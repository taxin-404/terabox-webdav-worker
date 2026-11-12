import { DurableObject } from 'cloudflare:workers';
import type { Env } from './types';

/**
 * Advisory WebDAV state (lock records + dead properties).
 *
 * The state lives behind the {@link DavStore} interface with two
 * implementations:
 *
 *  - {@link MemoryDavStore} — per-isolate maps, the zero-dependency default.
 *    Enforcement *relaxes* across isolate hops (an empty store allows the
 *    write) and self-issued tokens carry their expiry, so clients are never
 *    bricked; this is the pre-Durable-Object behaviour.
 *  - {@link RemoteDavStore} — a single Durable Object (`DavState`) that holds
 *    the state for the whole account. Every WebDAV isolate talks to the same
 *    object, so locks/dead props are consistent no matter how Cloudflare
 *    schedules requests; litmus's sequential suite becomes deterministic.
 *    The DO path is STRICT: a token counts only when a live record names it
 *    (no self-issued-token grace, no adoption of presented tokens), so lock
 *    capabilities cannot be forged where records durably exist.
 *
 * Both implementations delegate to the same pure core functions below, so
 * the semantics cannot drift — except for the documented `volatile` grace,
 * which only the record-losing memory store enables.
 */

export interface LockRecord {
  token: string;
  scope: 'exclusive' | 'shared';
  /** RFC 4918 depth: "0" or "Infinity". */
  depth: string;
  /** Inner XML of the request's <owner> element. */
  owner: string;
  expiresAt: number;
  /**
   * Encoded href of the resource the lock was TAKEN on (§14.12 lockroot).
   * A refresh answered through a descendant, or a lockdiscovery PROPFIND on
   * a child, must still advertise the lock's own root — not the URI the
   * request happened to arrive at. Absent on records minted before this
   * field existed: callers fall back to the request URI.
   */
  rootHref?: string;
}

export interface PathState {
  locks: LockRecord[];
  props: Record<string, string>;
}

export interface LockRequest {
  shared: boolean;
  depth: string;
  owner: string;
  presented: string[];
  seconds: number;
  /** Encoded href of `path`, captured for the record's lockroot. */
  rootHref?: string;
}

export interface LockOutcome {
  ok: boolean;
  refreshed: boolean;
  /** Present only when `ok` (or when a conflicting record had to be quoted). */
  record?: LockRecord;
  /**
   * The request carried an If header whose tokens name a live lock that does
   * NOT cover the Request-URI: the condition is false → 412 (RFC 4918
   * §9.10.6). Distinct from `ok: false` alone, which means 423 "locked".
   */
  precondition?: boolean;
}

export type UnlockOutcome = 'removed' | 'lapsed' | 'nomatch';

export interface TokenCheck {
  /** Presented tokens that apply (live record match, or our own unexpired). */
  applies: string[];
  /** Tokens of the live records applying to the path (enforcement needs them). */
  recordTokens: string[];
  /** Number of live records applying to the path (self + Infinity ancestors). */
  applying: number;
}

export interface PropPatchOp {
  op: 'set' | 'remove';
  key: string;
  markup: string;
}

export interface RelocateItem {
  src: string;
  dest?: string;
  mode: 'move' | 'copy' | 'forget';
  recursive: boolean;
  /** Move lock records too (true for MOVE; locks are never copied). */
  withLocks?: boolean;
}

export interface DavStore {
  checkTokens(path: string, tokens: string[]): Promise<TokenCheck>;
  /** Live locks on `path` and every descendant — collection DELETE/MOVE
   *  must present a token for each (RFC 4918 §9.6.1/§9.9.4). */
  subtreeLocks(path: string): Promise<LockRecord[]>;
  lockAcquire(path: string, req: LockRequest): Promise<LockOutcome>;
  unlock(path: string, token: string): Promise<UnlockOutcome>;
  describe(paths: string[]): Promise<Record<string, PathState>>;
  propPatch(path: string, ops: PropPatchOp[]): Promise<Record<string, string>>;
  relocate(items: RelocateItem[]): Promise<void>;
  /**
   * Shared metadata-cache generation. Every worker write bumps it; isolates
   * compare it before trusting their local read-side cache, which is what
   * makes "writes through this worker invalidate immediately" true across
   * isolates (the cache itself lives per isolate). `bump` increments and
   * returns the new value; otherwise the current value is returned.
   */
  metaGeneration(bump: boolean): Promise<number>;
  /**
   * Account-wide upstream slot reservation (TeraboxClient.pace): returns the
   * ms the caller must wait before firing, having queued its slot in the
   * shared timeline. Only remote (DO-backed) stores offer it — the memory
   * fallback omits it and pacing stays isolate-local.
   */
  apiSlot?(minGapMs: number): Promise<number>;
}

/* ------------------------------------------------------------------ */
/* Resumable upload sessions (for bodies larger than the Workers cap)  */
/* ------------------------------------------------------------------ */

/**
 * One resumable upload: Terabox's native multipart (precreate → superfile2
 * chunks → create) driven across many small HTTP requests so a single body
 * never exceeds Cloudflare's ~100 MB account-plan edge limit. Session state
 * lives in the Durable Object so any isolate can serve the next chunk.
 */
export interface UploadSession {
  path: string;
  size: number;
  mtimeMs: number;
  uploadId: string;
  uploadSign: string;
  chunkSize: number;
  chunkCount: number;
  /** Per-chunk md5 from superfile2; null until that chunk lands. */
  chunkMd5s: Array<string | null>;
  hosts: string[];
  overwriteMode: number;
  createdAt: number;
  /** Last chunk/finalize activity — drives the idle-abandonment reap. */
  lastActivity?: number;
  /** Host that accepted the last chunk; tried first on the next one. */
  activeHost?: string;
  /**
   * Set once finalize succeeded: the HTTP status to replay (201/204).
   * A retried finalize after a lost response then answers identically
   * instead of 404 (the session was not yet swept), so a client retry
   * cannot misreport a completed upload as a failure.
   */
  finalized?: number;
  /** When finalize succeeded — finalized sessions only linger for the retry
   *  grace window below, not the full session TTL. */
  finalizedAt?: number;
  /**
   * Non-undefined while a finalize is in flight: the atomic claim taken by
   * the request that owns the create. A second concurrent finalize POST
   * (a client retry racing a slow create) sees it, waits, and replays the
   * owner's verdict instead of racing a second create — which the upstream
   * would answer with -8 (path conflict) for a file that DID land.
   */
  finalizing?: number;
}

/**
 * Upload sessions that never finalize would otherwise leak in the Durable
 * Object forever. 24 h is far longer than any real multipart upload (even a
 * 4 GiB free-tier file streams in well under an hour) but bounded enough to
 * keep storage from growing without limit.
 */
export const UPLOAD_SESSION_TTL_MS = 24 * 60 * 60 * 1000;
/** How long a successfully finalized session is kept so a retried finalize
 *  replays its status instead of 404. Long past any HTTP retry window,
 *  short enough that finished uploads do not accumulate. */
export const UPLOAD_FINALIZED_GRACE_MS = 10 * 60 * 1000;
/** A finalize claim held longer than this may be taken over: an isolate that
 *  died mid-finalize must not wedge the session for its whole TTL. Comfortably
 *  past the create call's worst-case retry ladder, so a live owner is never
 *  preempted. */
export const FINALIZE_CLAIM_TTL_MS = 2 * 60 * 1000;

function isExpired(session: UploadSession): boolean {
  // A completed session only has to outlive a lost-response retry; keeping it
  // for the full TTL would let `persist()` serialize an ever-growing list of
  // finished uploads (one per file, 256 md5s each) on every chunk PUT.
  if (session.finalized) {
    return Date.now() - (session.finalizedAt ?? session.createdAt) > UPLOAD_FINALIZED_GRACE_MS;
  }
  return Date.now() - session.createdAt > UPLOAD_SESSION_TTL_MS;
}

/**
 * An OPEN session whose client went away (crash, killed rclone, dropped
 * network) keeps no useful state: its chunks cannot finalize without the
 * client, yet it would hold one of the MAX_UPLOAD_SESSIONS slots until the
 * 24 h TTL — 64 abandons would brick new uploads for a day. Reap open
 * sessions with no chunk/finalize activity for UPLOAD_SESSION_IDLE_MS.
 * Industry resumable stores use similar idle aborts (S3 MPU lifecycle,
 * Drive abandon windows); 2 h is far beyond any real gap between 4 MiB
 * chunks, and a client resuming after longer restarts cleanly instead of
 * wedging everyone else.
 */
const UPLOAD_SESSION_IDLE_MS = 2 * 60 * 60 * 1000;

function reapUploadSessions(uploads: Map<string, UploadSession>): void {
  const now = Date.now();
  const idleCutoff = now - UPLOAD_SESSION_IDLE_MS;
  for (const [id, s] of uploads) {
    if (isExpired(s)) {
      uploads.delete(id);
      continue;
    }
    if (s.finalized === undefined && (s.lastActivity ?? s.createdAt) < idleCutoff) {
      uploads.delete(id);
    }
  }
}

/**
 * Result of the atomic finalize claim. `owned` — this request now runs the
 * create; `replay` — a finished finalize answers with its recorded status;
 * `busy` — another request holds the claim; `unknown` — session gone.
 */
export type FinalizeClaim =
  | { kind: 'owned' }
  | { kind: 'busy' }
  | { kind: 'unknown' }
  | { kind: 'replay'; status: number };

export interface UploadStore {
  init(session: UploadSession): Promise<void>;
  get(uploadId: string): Promise<UploadSession | undefined>;
  recordChunk(uploadId: string, index: number, md5: string, activeHost?: string): Promise<void>;
  /** Record that finalize succeeded so a retried finalize replays its status. */
  markFinalized(uploadId: string, status: number): Promise<void>;
  /** Atomically claim exclusive rights to run finalize for this session. */
  claimFinalize(uploadId: string): Promise<FinalizeClaim>;
  /** Give the claim back after a failed finalize so a retry can claim anew. */
  releaseFinalize(uploadId: string): Promise<void>;
  delete(uploadId: string): Promise<void>;
}

/* ------------------------------------------------------------------ */
/* Advisory-state safety caps (see corePatch / coreLockAcquire)        */
/* ------------------------------------------------------------------ */

/**
 * Dead-property caps, counted in string chars (≈ bytes; a safety limit, not
 * an accounting one). Dead props never expire, so without limits one client
 * PROPPATCHing megabytes would grow the DO's whole-state persist toward the
 * storage value limit — after which EVERY lock/prop mutation deployment-wide
 * would fail until the object reset.
 */
export const MAX_PROP_BYTES_PER_PATH = 32 * 1024;
export const MAX_PROP_BYTES_TOTAL = 512 * 1024;
export const MAX_PROP_PATHS = 8192;
/** Lock records do expire (TTL), but a client could still LOCK thousands of
 *  paths inside one timeout window; cap both the path count and how many
 *  shared locks may stack on a single path. */
export const MAX_LOCK_PATHS = 4096;
export const MAX_LOCK_RECORDS_PER_PATH = 32;
/** Lock owner markup is stored for the lock's lifetime and re-persisted with
 *  the whole advisory map. The request body cap (4 MiB) alone would let 32
 *  records overflow the DO's single-value limit and turn every later
 *  lock/prop write into a deployment-wide 500. */
export const MAX_LOCK_OWNER_BYTES = 8 * 1024;
export const MAX_LOCK_BYTES_PER_PATH = 128 * 1024;
/**
 * Cap on concurrently OPEN (non-finalized) upload sessions (see
 * DavLimitError → 507). Open sessions expire via the 24 h TTL, but an
 * authenticated client opening them without bound would grow the uploads
 * map — and every chunk PUT re-persists that whole map (see
 * persist('uploads')), so cost per chunk is O(map). FINALIZED records do
 * NOT count: they are already bounded by their 10 min grace
 * (UPLOAD_FINALIZED_GRACE_MS), and counting them would 507 a batch upload
 * mid-sync as soon as 64 files finished within the grace window.
 * Mirrors the lock/prop advisory caps.
 */
export const MAX_UPLOAD_SESSIONS = 64;

/** Advisory state exceeded a safety cap above; both stores surface it as
 *  HTTP 507 (RFC 4918 §7.1) rather than letting the DO storage cliff turn
 *  it into a deployment-wide 500. */
export class DavLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DavLimitError';
  }
}

/* ------------------------------------------------------------------ */
/* Token helpers (shared by the WebDAV layer, both stores, and the DO) */
/* ------------------------------------------------------------------ */

/**
 * Self-issued tokens carry their expiry: a warm client's token keeps working
 * for the rest of its life even when the record behind it was lost to an
 * isolate rotation, so writes are never spuriously blocked.
 */
export function isOurUnexpiredToken(token: string): boolean {
  const m = /^opaquelocktoken:[0-9a-fA-F-]{36}:(\d{13,})$/.exec(token);
  return m !== null && Number(m[1]) > Date.now();
}

export function makeLockToken(seconds: number): string {
  return `opaquelocktoken:${crypto.randomUUID()}:${Date.now() + seconds * 1000}`;
}

/** Extract every `<...>` token from an If / Lock-Token style header value. */
export function collectTokens(header: string | null): string[] {
  if (!header) return [];
  const tokens: string[] = [];
  for (const m of header.matchAll(/<([^<>\s]+)>/g)) {
    if (m[1] !== undefined) tokens.push(m[1]);
  }
  return tokens;
}

/* ------------------------------------------------------------------ */
/* Pure core: the single source of truth for both store implementations */
/* ------------------------------------------------------------------ */

function purgeAt(locks: Map<string, LockRecord[]>, path: string): LockRecord[] {
  const records = locks.get(path);
  if (!records) return [];
  const now = Date.now();
  const live = records.filter((r) => r.expiresAt > now);
  if (live.length > 0) locks.set(path, live);
  else locks.delete(path);
  return live;
}

/** Drop expired records on every path (cap headroom — the DO's alarm does
 *  the same job on a timer; the memory fallback has no alarm at all). */
function sweepExpiredLocks(locks: Map<string, LockRecord[]>): void {
  const now = Date.now();
  for (const [key, records] of locks) {
    const live = records.filter((r) => r.expiresAt > now);
    if (live.length > 0) locks.set(key, live);
    else locks.delete(key);
  }
}

/** Locks on the path itself, plus Infinity-depth locks on its ancestors. */
/**
 * Does the lock stored at `key` govern `path`? Exact hit, or an
 * Infinity-depth ancestor (RFC 4918 §9.11 scope). Shared by enforcement,
 * refresh, precondition and UNLOCK so all four answer identically.
 */
function lockCovers(key: string, record: LockRecord, path: string): boolean {
  if (key === path) return true;
  if (record.depth !== 'Infinity') return false;
  if (key === '/') return path.startsWith('/');
  return path.startsWith(key + '/');
}

function applyingLocksOf(locks: Map<string, LockRecord[]>, path: string): LockRecord[] {
  const now = Date.now();
  const out: LockRecord[] = [];
  for (const [lockedPath, records] of locks) {
    for (const rec of records) {
      if (rec.expiresAt <= now) continue;
      if (lockCovers(lockedPath, rec, path)) out.push(rec);
    }
  }
  return out;
}

/**
 * Live locks at `path` and anywhere beneath it. A collection DELETE/MOVE
 * destroys members too, and RFC 4918 §9.6.1/§9.9.4 require a token for every
 * locked resource in the affected tree — the ancestor-only `applyingLocksOf`
 * cannot see a depth-0 lock on a child.
 */
function coreSubtreeLocks(locks: Map<string, LockRecord[]>, path: string): LockRecord[] {
  const now = Date.now();
  const prefix = path === '/' ? '/' : path + '/';
  const out: LockRecord[] = [];
  for (const [lockedPath, records] of locks) {
    if (lockedPath !== path && !lockedPath.startsWith(prefix)) continue;
    for (const rec of records) if (rec.expiresAt > now) out.push(rec);
  }
  return out;
}

/**
 * `volatile` enables the memory store's never-brick grace: a self-issued
 * token keeps satisfying checks after its record was lost to an isolate
 * rotation. The Durable Object passes `false` — records there survive, so
 * the grace would only ever be exercised by FORGED tokens (§6.5 makes lock
 * tokens capabilities; accepting invented ones voids the capability).
 */
function coreCheckTokens(
  locks: Map<string, LockRecord[]>,
  path: string,
  tokens: string[],
  volatile: boolean,
): TokenCheck {
  purgeAt(locks, path);
  const applying = applyingLocksOf(locks, path);
  const recordTokens = applying.map((r) => r.token);
  const applies: string[] = [];
  for (const token of new Set(tokens)) {
    if (recordTokens.includes(token) || (volatile && isOurUnexpiredToken(token))) applies.push(token);
  }
  return { applies, recordTokens, applying: applying.length };
}

function coreLockAcquire(
  locks: Map<string, LockRecord[]>,
  path: string,
  req: LockRequest,
  volatile: boolean,
): LockOutcome {
  const now = Date.now();
  // A presented token that names a LIVE lock not covering this URI means
  // the If condition fails (RFC 4918 §9.10.6) → 412. Checked BEFORE the
  // refresh below, so a request carrying a valid refresh token *plus* an
  // unrelated live token cannot slip through; tokens that DO cover this
  // path (including from an Infinity ancestor) never trip it, which keeps
  // indirect refresh working.
  const ownedElsewhere = req.presented.some((token) =>
    [...locks.entries()].some(
      ([key, records]) =>
        records.some((r) => r.token === token && r.expiresAt > now && !lockCovers(key, r, path)),
    ),
  );
  if (ownedElsewhere) return { ok: false, refreshed: false, precondition: true };
  // Refresh: a presented token matches a lock on this resource or on an
  // Infinity-depth ancestor (litmus indirect_refresh) — extend in place.
  const refreshable = applyingLocksOf(locks, path).find((r) => req.presented.includes(r.token));
  if (refreshable) {
    refreshable.expiresAt = now + req.seconds * 1000;
    return { ok: true, refreshed: true, record: refreshable };
  }
  purgeAt(locks, path);
  // RFC 4918 §6.1.3: a server MUST NOT create conflicting locks. Whether
  // this resource is ALREADY locked includes indirect locks — an Infinity-
  // depth lock on an ancestor (§9.11) — not just records stored at this
  // exact path. The old direct-only check let B lock /coll/f beneath A's
  // depth-infinity lock on /coll and then write through A's exclusivity.
  const covering = applyingLocksOf(locks, path);
  if (covering.length > 0 && (!req.shared || covering.some((r) => r.scope === 'exclusive'))) {
    // Exclusive admits nothing; shared admits only further shared requests
    // (RFC 4918 §9.10.6) — same table as before, now over ALL covering locks.
    return {
      ok: false,
      refreshed: false,
      record: covering.find((r) => r.scope === 'exclusive') ?? covering[0]!,
    };
  }
  // §9.10.3 whole-hierarchy rule: granting depth-infinity must not conflict
  // with a lock DEEPER in the subtree (the covering check above only sees
  // ancestors and the path itself). Exclusive conflicts with any live
  // descendant lock; shared conflicts with an exclusive descendant.
  if (req.depth === 'Infinity') {
    const cover = { depth: 'Infinity' } as LockRecord;
    for (const [key, records] of locks) {
      if (key === path) continue;
      for (const r of records) {
        if (r.expiresAt <= now) continue;
        if (!lockCovers(path, cover, key)) continue;
        if (r.scope === 'exclusive' || !req.shared) {
          return { ok: false, refreshed: false, record: r };
        }
      }
    }
  }
  // Safety caps (see DavLimitError): refuse growth the DO could not persist.
  const atPath = locks.get(path);
  if (!atPath && locks.size >= MAX_LOCK_PATHS) {
    // Expired records on paths nobody re-locks still occupy the cap — and
    // the memory fallback never sweeps them. Without this, an isolate that
    // has ever held 4096 distinct (now-expired) locks answers 507 to every
    // new LOCK until one of those old paths is touched again.
    sweepExpiredLocks(locks);
    if (locks.size >= MAX_LOCK_PATHS) throw new DavLimitError('lock path cap reached');
  }
  if (atPath && atPath.length >= MAX_LOCK_RECORDS_PER_PATH) {
    throw new DavLimitError('lock record cap reached');
  }
  // Byte caps: record count alone does not bound the persisted value (the
  // owner fragment can be up to the XML body cap). Check BEFORE mutating.
  if (req.owner.length > MAX_LOCK_OWNER_BYTES) {
    throw new DavLimitError('lock owner size cap reached');
  }
  // Re-acquire a presented still-valid token ONLY in volatile mode (memory
  // store, whose records can be lost to isolate rotation). The DO persists
  // records — "lost" never legitimately happens there — and adopting what a
  // client presents would let it CHOOSE its own capability (§6.5).
  const token =
    (volatile ? req.presented.find(isOurUnexpiredToken) : undefined) ?? makeLockToken(req.seconds);
  const usedBytes = (atPath ?? []).reduce(
    (n, r) => n + r.owner.length + (r.rootHref?.length ?? 0) + r.token.length,
    0,
  );
  if (
    usedBytes + req.owner.length + (req.rootHref?.length ?? 0) + token.length >
    MAX_LOCK_BYTES_PER_PATH
  ) {
    throw new DavLimitError('lock record byte cap reached');
  }
  const record: LockRecord = {
    token,
    scope: req.shared ? 'shared' : 'exclusive',
    depth: req.depth,
    owner: req.owner,
    expiresAt: now + req.seconds * 1000,
    rootHref: req.rootHref,
  };
  const records = locks.get(path) ?? [];
  records.push(record);
  locks.set(path, records);
  return { ok: true, refreshed: false, record };
}

function coreUnlock(
  locks: Map<string, LockRecord[]>,
  path: string,
  token: string,
  volatile: boolean,
): UnlockOutcome {
  const now = Date.now();
  let liveTokenElsewhere = false;
  // A lock covers this URI when it is stored here, or when an ancestor holds
  // an Infinity-depth lock over it. RFC 4918 §9.11: UNLOCK removes the lock
  // from the resource AND everything in its scope — so unlocking a child with
  // the collection's token must free the collection's lock, not answer 204
  // and leave the 423 in force until the timeout.
  for (const [key, records] of locks) {
    const live = records.filter((r) => r.expiresAt > now);
    if (live.length !== records.length) {
      if (live.length > 0) locks.set(key, live);
      else locks.delete(key);
    }
    const index = live.findIndex((r) => r.token === token);
    if (index === -1) continue;
    const record = live[index]!;
    // The token is real but belongs to a lock that does not cover this URI:
    // that is a genuine mismatch (409), not a lapsed record.
    if (!lockCovers(key, record, path)) {
      liveTokenElsewhere = true;
      continue;
    }
    live.splice(index, 1);
    if (live.length > 0) locks.set(key, live);
    else locks.delete(key);
    return 'removed';
  }
  if (liveTokenElsewhere) return 'nomatch';
  // A well-formed token that matches no live record anywhere. If something
  // on this path is STILL locked by others, answering the graceful 'lapsed'
  // (204) would mask their state — the client would sail on believing it
  // unlocked and trip 423 on its next write (RFC 4918 §9.11 wants 409 for a
  // non-matching token). 'lapsed' stays for the genuine case: nothing here
  // is locked at all, so the record simply aged out (memory-store rotation).
  if (applyingLocksOf(locks, path).length > 0) return 'nomatch';
  return volatile && isOurUnexpiredToken(token) ? 'lapsed' : 'nomatch';
}

function coreDescribe(
  locks: Map<string, LockRecord[]>,
  props: Map<string, Record<string, string>>,
  paths: string[],
): Record<string, PathState> {
  const out: Record<string, PathState> = {};
  for (const path of new Set(paths)) {
    purgeAt(locks, path);
    // §13.10: lockdiscovery lists every lock that APPLIES to the resource,
    // including one held by an Infinity-depth ancestor — a child must not
    // report `<D:lockdiscovery/>` while it is in fact write-locked.
    out[path] = {
      locks: applyingLocksOf(locks, path),
      props: props.get(path) ?? {},
    };
  }
  return out;
}

function propBytes(record: Record<string, string>): number {
  return Object.values(record).reduce((n, v) => n + v.length, 0);
}

function propsTotal(props: Map<string, Record<string, string>>): number {
  let total = 0;
  for (const rec of props.values()) total += propBytes(rec);
  return total;
}

/**
 * Enforce the dead-property budget on a candidate map. `oldTotal` lets an
 * already-oversized map shrink: a repair must never be refused just because
 * the state it repairs is over the cap.
 */
function assertPropsBudget(
  props: Map<string, Record<string, string>>,
  oldTotal: number,
): void {
  if (props.size > MAX_PROP_PATHS) throw new DavLimitError('dead-property path cap');
  let total = 0;
  for (const rec of props.values()) {
    const bytes = propBytes(rec);
    if (bytes > MAX_PROP_BYTES_PER_PATH) throw new DavLimitError('dead-property size cap per path');
    total += bytes;
  }
  if (total > MAX_PROP_BYTES_TOTAL && total > oldTotal) {
    throw new DavLimitError('dead-property total size cap');
  }
}

function corePatch(
  props: Map<string, Record<string, string>>,
  path: string,
  ops: PropPatchOp[],
): Record<string, string> {
  const store = { ...(props.get(path) ?? {}) };
  for (const op of ops) {
    if (op.op === 'set') store[op.key] = op.markup;
    else delete store[op.key];
  }
  if (Object.keys(store).length > 0) {
    // Size caps BEFORE mutating the map: dead props never expire, and the DO
    // persists the whole map — unbounded growth would eventually exceed the
    // storage value limit and turn every mutation deployment-wide into a 500.
    // 507 (RFC 4918 §7.1) is the honest answer to "cannot store".
    const next = new Map(props);
    next.set(path, store);
    assertPropsBudget(next, propsTotal(props));
    props.set(path, store);
  } else props.delete(path);
  return store;
}

function forgetCore<T>(store: Map<string, T>, path: string, recursive: boolean): void {
  store.delete(path);
  if (!recursive) return;
  for (const key of [...store.keys()]) {
    if (key.startsWith(path + '/')) store.delete(key);
  }
}

function rekeyCore<T>(
  store: Map<string, T>,
  src: string,
  dest: string,
  mode: 'move' | 'copy',
  recursive: boolean,
): void {
  const relocated: Array<[string, T]> = [];
  if (store.has(src)) relocated.push([dest, store.get(src)!]);
  if (recursive) {
    for (const [key, value] of store) {
      if (key.startsWith(src + '/')) relocated.push([dest + key.slice(src.length), value]);
    }
  }
  if (mode === 'move') forgetCore(store, src, recursive);
  for (const [key, value] of relocated) store.set(key, value);
}

function coreRelocate(
  locks: Map<string, LockRecord[]>,
  props: Map<string, Record<string, string>>,
  item: RelocateItem,
): void {
  if (item.mode === 'forget') {
    forgetCore(props, item.src, item.recursive);
    forgetCore(locks, item.src, item.recursive);
    return;
  }
  // Relocation used to bypass the dead-property caps: a recursive COPY of a
  // large tree could grow the map past every limit, after which even a pure
  // removal answered 507. Validate the projected map before committing.
  const oldTotal = propsTotal(props);
  const nextProps = new Map(props);
  rekeyCore(nextProps, item.src, item.dest!, item.mode, item.recursive);
  assertPropsBudget(nextProps, oldTotal);
  props.clear();
  for (const [key, value] of nextProps) props.set(key, value);
  if (item.mode === 'move' && item.withLocks) {
    rekeyCore(locks, item.src, item.dest!, 'move', item.recursive);
  }
}

/* ------------------------------------------------------------------ */
/* In-memory implementation (default, per isolate)                     */
/* ------------------------------------------------------------------ */

export class MemoryDavStore implements DavStore, UploadStore {
  private locks = new Map<string, LockRecord[]>();
  private props = new Map<string, Record<string, string>>();
  private uploads = new Map<string, UploadSession>();
  private metaGen = 0;

  /** Test hook: clear per-isolate advisory state between test cases. */
  reset(): void {
    this.locks.clear();
    this.props.clear();
    this.uploads.clear();
  }

  async checkTokens(path: string, tokens: string[]): Promise<TokenCheck> {
    // volatile=true: this store's records die with the isolate, so the
    // self-issued-token grace below keeps warm clients working (documented
    // relaxed semantics for the zero-dependency fallback).
    return coreCheckTokens(this.locks, path, tokens, true);
  }

  async subtreeLocks(path: string): Promise<LockRecord[]> {
    return coreSubtreeLocks(this.locks, path);
  }

  async lockAcquire(path: string, req: LockRequest): Promise<LockOutcome> {
    return coreLockAcquire(this.locks, path, req, true);
  }

  async unlock(path: string, token: string): Promise<UnlockOutcome> {
    return coreUnlock(this.locks, path, token, true);
  }

  async describe(paths: string[]): Promise<Record<string, PathState>> {
    return coreDescribe(this.locks, this.props, paths);
  }

  async propPatch(path: string, ops: PropPatchOp[]): Promise<Record<string, string>> {
    return corePatch(this.props, path, ops);
  }

  async relocate(items: RelocateItem[]): Promise<void> {
    for (const item of items) coreRelocate(this.locks, this.props, item);
  }

  async init(session: UploadSession): Promise<void> {
    // Same lazy sweep the Durable Object runs: without it, a deployment with
    // no DAV_STATE binding accumulates abandoned sessions until recycle.
    reapUploadSessions(this.uploads);
    let openSessions = 0;
    for (const existing of this.uploads.values()) {
      if (existing.finalized === undefined) openSessions += 1;
    }
    if (openSessions >= MAX_UPLOAD_SESSIONS) {
      throw new DavLimitError('upload session cap reached');
    }
    this.uploads.set(session.uploadId, session);
  }

  async get(uploadId: string): Promise<UploadSession | undefined> {
    const session = this.uploads.get(uploadId);
    if (!session) return undefined;
    if (isExpired(session)) {
      this.uploads.delete(uploadId);
      return undefined;
    }
    return session;
  }

  async recordChunk(uploadId: string, index: number, md5: string, activeHost?: string): Promise<void> {
    const session = this.uploads.get(uploadId);
    if (session) {
      session.chunkMd5s[index] = md5;
      session.lastActivity = Date.now();
      if (activeHost) session.activeHost = activeHost;
    }
  }

  async metaGeneration(bump: boolean): Promise<number> {
    if (bump) this.metaGen += 1;
    return this.metaGen;
  }

  async markFinalized(uploadId: string, status: number): Promise<void> {
    const session = this.uploads.get(uploadId);
    if (session) {
      session.finalized = status;
      session.finalizedAt = Date.now();
      session.finalizing = undefined;
    }
  }

  async claimFinalize(uploadId: string): Promise<FinalizeClaim> {
    const session = this.uploads.get(uploadId);
    if (!session) return { kind: 'unknown' };
    if (session.finalized !== undefined) return { kind: 'replay', status: session.finalized };
    const now = Date.now();
    // Check and set with no await in between: the single-isolate runtime
    // makes that an atomic claim, mirroring the DO route below.
    if (session.finalizing !== undefined && now - session.finalizing < FINALIZE_CLAIM_TTL_MS) {
      return { kind: 'busy' };
    }
    session.finalizing = now;
    return { kind: 'owned' };
  }

  async releaseFinalize(uploadId: string): Promise<void> {
    const session = this.uploads.get(uploadId);
    if (session && session.finalized === undefined) session.finalizing = undefined;
  }

  async delete(uploadId: string): Promise<void> {
    this.uploads.delete(uploadId);
  }
}

const sharedMemoryStore = new MemoryDavStore();

/** Test hook: clear per-isolate advisory state between test cases. */
export function resetDavVolatileState(): void {
  sharedMemoryStore.reset();
}

/** Pick the store: Durable Object when bound, per-isolate memory otherwise. */
export function createDavStore(env: Env): DavStore & UploadStore {
  return env.DAV_STATE ? new RemoteDavStore(env.DAV_STATE) : sharedMemoryStore;
}

/* ------------------------------------------------------------------ */
/* Durable Object client                                               */
/* ------------------------------------------------------------------ */

export const DO_NAME = 'terabox-dav-state';

export class RemoteDavStore implements DavStore, UploadStore {
  constructor(private readonly ns: DurableObjectNamespace) {}

  private stub(): DurableObjectStub {
    return this.ns.get(this.ns.idFromName(DO_NAME));
  }

  private async call<T>(route: string, body: unknown): Promise<T> {
    const res = await this.stub().fetch(`https://dav-state${route}`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    if (res.status === 507) throw new DavLimitError(`dav-state ${route}: ${await res.text()}`);
    if (!res.ok) throw new Error(`dav-state ${route}: HTTP ${res.status}`);
    return (await res.json()) as T;
  }

  checkTokens(path: string, tokens: string[]): Promise<TokenCheck> {
    return this.call<TokenCheck>('/tokens', { path, tokens });
  }

  subtreeLocks(path: string): Promise<LockRecord[]> {
    return this.call<LockRecord[]>('/subtree-locks', { path });
  }

  lockAcquire(path: string, req: LockRequest): Promise<LockOutcome> {
    return this.call<LockOutcome>('/lock', { path, req });
  }

  unlock(path: string, token: string): Promise<UnlockOutcome> {
    return this.call<UnlockOutcome>('/unlock', { path, token });
  }

  describe(paths: string[]): Promise<Record<string, PathState>> {
    return this.call<Record<string, PathState>>('/describe', { paths });
  }

  propPatch(path: string, ops: PropPatchOp[]): Promise<Record<string, string>> {
    return this.call<Record<string, string>>('/patch', { path, ops });
  }

  async relocate(items: RelocateItem[]): Promise<void> {
    await this.call('/relocate', { items });
  }

  async init(session: UploadSession): Promise<void> {
    await this.call('/upload-init', { session });
  }

  get(uploadId: string): Promise<UploadSession | undefined> {
    return this.call<UploadSession | undefined>('/upload-get', { uploadId });
  }

  async recordChunk(uploadId: string, index: number, md5: string, activeHost?: string): Promise<void> {
    await this.call('/upload-chunk', { uploadId, index, md5, activeHost });
  }

  metaGeneration(bump: boolean): Promise<number> {
    return this.call<number>('/meta-gen', { bump });
  }

  apiSlot(minGapMs: number): Promise<number> {
    return this.call<number>('/api-slot', { minGapMs });
  }

  async markFinalized(uploadId: string, status: number): Promise<void> {
    await this.call('/upload-finalized', { uploadId, status });
  }

  claimFinalize(uploadId: string): Promise<FinalizeClaim> {
    return this.call<FinalizeClaim>('/upload-claim', { uploadId });
  }

  async releaseFinalize(uploadId: string): Promise<void> {
    await this.call('/upload-claim-release', { uploadId });
  }

  async delete(uploadId: string): Promise<void> {
    await this.call('/upload-delete', { uploadId });
  }
}

/* ------------------------------------------------------------------ */
/* The Durable Object itself                                           */
/* ------------------------------------------------------------------ */

interface StoredShape {
  locks?: Array<[string, LockRecord[]]>;
  props?: Array<[string, Record<string, string>]>;
  uploads?: Array<[string, UploadSession]>;
  metaGen?: number;
}

/**
 * One Durable Object instance per account (by name) holding all advisory
 * WebDAV state. Requests to it are serialized by the platform, which is
 * exactly what lock semantics need — and every worker isolate in the
 * deployment talks to this same instance, so isolate scheduling becomes
 * irrelevant. Storage is write-through on every mutation (SQLite-backed
 * class; the state is a few KB at litmus scale).
 */
export class DavState extends DurableObject {
  private locks = new Map<string, LockRecord[]>();
  private props = new Map<string, Record<string, string>>();
  private uploads = new Map<string, UploadSession>();
  /** Bumped by every metadata-changing write; isolates diff it against the
   *  value their local read cache was filled under. */
  private metaGen = 0;
  /** Next account-wide upstream slot. Computed synchronously (the DO is
   *  single-threaded, so read+write has no await between them — the same
   *  race-free reservation the isolate-local floor uses) and kept in memory:
   *  a rate floor needs no durability, and eviction just re-opens the gap. */
  private nextApiSlot = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Load (and re-arm any expiry sweep) inside blockConcurrencyWhile:
    // requests are held until state is ready, and a transient storage error
    // restarts the object with backoff instead of rejecting a stored `ready`
    // promise forever (which would 500 every fetch for the rest of the
    // instance's lifetime).
    this.ctx.blockConcurrencyWhile(async () => {
      await this.load();
      await this.armSweep();
    });
  }

  private async load(): Promise<void> {
    const [locks, props, uploads, metaGen] = await Promise.all([
      this.ctx.storage.get<StoredShape['locks']>('locks'),
      this.ctx.storage.get<StoredShape['props']>('props'),
      this.ctx.storage.get<StoredShape['uploads']>('uploads'),
      this.ctx.storage.get<StoredShape['metaGen']>('metaGen'),
    ]);
    this.locks = new Map(locks ?? []);
    this.props = new Map(props ?? []);
    this.uploads = new Map(uploads ?? []);
    this.metaGen = metaGen ?? 0;
  }

  /**
   * Write-through persist, scoped to what actually changed: chunk PUTs
   * re-persist ONLY the upload sessions (the old full-state write re-serialized
   * every lock and dead prop on every 4 MiB chunk), lock/prop routes only the
   * advisory maps. Partial object puts leave the other keys untouched.
   */
  private async persist(what: 'all' | 'advisory' | 'uploads' = 'all'): Promise<void> {
    if (what === 'advisory') {
      await this.ctx.storage.put({ locks: [...this.locks], props: [...this.props] });
      return;
    }
    if (what === 'uploads') {
      await this.ctx.storage.put({ uploads: [...this.uploads] });
      return;
    }
    await this.ctx.storage.put({
      locks: [...this.locks],
      props: [...this.props],
      uploads: [...this.uploads],
      metaGen: this.metaGen,
    });
  }

  /** Deep-ish copy of the advisory maps for rollback (records are mutated
   *  in place — refresh, UNLOCK splice — so a shallow map copy would not
   *  undo anything). */
  private advisorySnapshot(): {
    locks: Map<string, LockRecord[]>;
    props: Map<string, Record<string, string>>;
  } {
    return {
      locks: new Map(
        [...this.locks].map(([k, v]) => [k, v.map((r) => ({ ...r }))] as [string, LockRecord[]]),
      ),
      props: new Map(
        [...this.props].map(([k, v]) => [k, { ...v }] as [string, Record<string, string>]),
      ),
    };
  }

  private restoreAdvisory(snap: {
    locks: Map<string, LockRecord[]>;
    props: Map<string, Record<string, string>>;
  }): void {
    this.locks = snap.locks;
    this.props = snap.props;
  }

  /** Earliest future expiry among locks and unfinished uploads — when an
   *  alarm sweep would first change something (null = nothing expires). */
  private nextSweepAt(): number | null {
    const now = Date.now();
    let next: number | null = null;
    const consider = (t: number): void => {
      if (t > now && (next === null || t < next)) next = t;
    };
    for (const records of this.locks.values()) for (const r of records) consider(r.expiresAt);
    for (const s of this.uploads.values()) {
      if (s.finalized) consider((s.finalizedAt ?? s.createdAt) + UPLOAD_FINALIZED_GRACE_MS);
      else consider(s.createdAt + UPLOAD_SESSION_TTL_MS);
    }
    return next;
  }

  /**
   * Arm a one-shot alarm at the next real expiry. The lazy per-path purges
   * only run when a path is re-touched; without this backstop, a lock (or
   * abandoned upload) on a path nobody visits again would sit in memory and
   * get re-serialized into every subsequent persist forever.
   */
  private async armSweep(): Promise<void> {
    const next = this.nextSweepAt();
    if (next === null) return;
    try {
      const current = await this.ctx.storage.getAlarm();
      if (current === null || current > next) await this.ctx.storage.setAlarm(next);
    } catch {
      // Arming is a backstop; the lazy sweeps still bound growth.
    }
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.method !== 'POST') {
      return new Response('POST only', { status: 405 });
    }
    const url = new URL(request.url);
    const body = (await request.json()) as Record<string, unknown>;
    try {
      switch (url.pathname) {
        case '/tokens': {
          const out = coreCheckTokens(
            this.locks,
            body['path'] as string,
            body['tokens'] as string[],
            false,
          );
          return Response.json(out);
        }
        case '/subtree-locks': {
          return Response.json(coreSubtreeLocks(this.locks, body['path'] as string));
        }
        case '/lock': {
          const snap = this.advisorySnapshot();
          const out = coreLockAcquire(
            this.locks,
            body['path'] as string,
            body['req'] as LockRequest,
            false,
          );
          if (out.ok) {
            try {
              await this.persist('advisory');
            } catch (err) {
              // Mutate-before-persist needs a rollback: a failed write must
              // not leave the lock live in memory — the client gets a 500
              // and never learns the token, yet the phantom record would
              // 423 every later writer, and the NEXT successful persist
              // would durabilize it.
              this.restoreAdvisory(snap);
              throw err;
            }
            await this.armSweep();
          }
          return Response.json(out);
        }
        case '/unlock': {
          const snap = this.advisorySnapshot();
          const out = coreUnlock(
            this.locks,
            body['path'] as string,
            body['token'] as string,
            false,
          );
          if (out === 'removed') {
            try {
              await this.persist('advisory');
            } catch (err) {
              this.restoreAdvisory(snap);
              throw err;
            }
          }
          return Response.json(out);
        }
        case '/describe': {
          const out = coreDescribe(this.locks, this.props, body['paths'] as string[]);
          return Response.json(out);
        }
        case '/patch': {
          const snap = this.advisorySnapshot();
          const out = corePatch(this.props, body['path'] as string, body['ops'] as PropPatchOp[]);
          try {
            await this.persist('advisory');
          } catch (err) {
            this.restoreAdvisory(snap);
            throw err;
          }
          return Response.json(out);
        }
        case '/relocate': {
          const snap = this.advisorySnapshot();
          for (const item of body['items'] as RelocateItem[]) {
            coreRelocate(this.locks, this.props, item);
          }
          try {
            await this.persist('advisory');
          } catch (err) {
            this.restoreAdvisory(snap);
            throw err;
          }
          return Response.json({});
        }
        case '/meta-gen': {
          if (body['bump']) {
            this.metaGen += 1;
            // Only the counter changed. A full persist() would serialize every
            // lock, dead prop and upload session (each with its full chunk-md5
            // list) to storage on EVERY metadata write — O(state) per PUT.
            await this.ctx.storage.put('metaGen', this.metaGen);
          }
          return Response.json(this.metaGen);
        }
        case '/api-slot': {
          const minGapMs = Math.max(0, Number(body['minGapMs']) || 0);
          const now = Date.now();
          const slot = Math.max(now, this.nextApiSlot + minGapMs);
          this.nextApiSlot = slot;
          return Response.json(slot - now);
        }
        case '/upload-init': {
          const session = body['session'] as UploadSession;
          // Lazy sweep: drop expired AND idle-abandoned sessions whenever a
          // new one lands, so the map stays bounded even if clients vanish.
          reapUploadSessions(this.uploads);
          // Safety cap (see MAX_UPLOAD_SESSIONS): refuse growth the DO could
          // not persist cheaply — every later chunk re-serializes the map.
          // Open sessions only; finalized records ride their 10 min grace.
          let openSessions = 0;
          for (const existing of this.uploads.values()) {
            if (existing.finalized === undefined) openSessions += 1;
          }
          if (openSessions >= MAX_UPLOAD_SESSIONS) {
            throw new DavLimitError('upload session cap reached');
          }
          this.uploads.set(session.uploadId, session);
          await this.persist('uploads');
          await this.armSweep();
          return Response.json({});
        }
        case '/upload-get': {
          const uploadId = body['uploadId'] as string;
          const session = this.uploads.get(uploadId);
          if (session && isExpired(session)) {
            this.uploads.delete(uploadId);
            await this.persist('uploads');
            return Response.json(null);
          }
          return Response.json(session ?? null);
        }
        case '/upload-chunk': {
          const session = this.uploads.get(body['uploadId'] as string);
          if (session) {
            session.chunkMd5s[body['index'] as number] = body['md5'] as string;
            session.lastActivity = Date.now();
            const activeHost = body['activeHost'] as string | undefined;
            if (activeHost) session.activeHost = activeHost;
            // Only the uploads key changes here; every other key (locks,
            // props) stays untouched in storage.
            await this.persist('uploads');
          }
          return Response.json({});
        }
        case '/upload-finalized': {
          const session = this.uploads.get(body['uploadId'] as string);
          if (session) {
            const prev = {
              finalized: session.finalized,
              finalizedAt: session.finalizedAt,
              finalizing: session.finalizing,
            };
            session.finalized = body['status'] as number;
            session.finalizedAt = Date.now();
            session.finalizing = undefined;
            try {
              await this.persist('uploads');
            } catch (err) {
              Object.assign(session, prev);
              throw err;
            }
            // The session's expiry just moved from the 24h upload TTL to
            // finalizedAt+grace: re-arm, or the sweep still waits at the
            // old, much later time and the record outlives its window.
            await this.armSweep();
          }
          return Response.json({});
        }
        case '/upload-claim': {
          const session = this.uploads.get(body['uploadId'] as string);
          if (!session) return Response.json({ kind: 'unknown' });
          if (session.finalized !== undefined) return Response.json({ kind: 'replay', status: session.finalized });
          const now = Date.now();
          if (session.finalizing !== undefined && now - session.finalizing < FINALIZE_CLAIM_TTL_MS) {
            return Response.json({ kind: 'busy' });
          }
          // Fresh claim, or taking over a stale one (owner died mid-finalize).
          // Mutate before persist: the check and the set happen with no await
          // in between, so a second request can never interleave here. A failed
          // persist must release the claim again — otherwise this 500 wedges
          // concurrent retries into `busy` until the claim TTL.
          const prev = session.finalizing;
          session.finalizing = now;
          try {
            await this.persist('uploads');
          } catch (err) {
            session.finalizing = prev;
            throw err;
          }
          return Response.json({ kind: 'owned' });
        }
        case '/upload-claim-release': {
          const session = this.uploads.get(body['uploadId'] as string);
          if (session && session.finalized === undefined) {
            session.finalizing = undefined;
            await this.persist('uploads');
          }
          return Response.json({});
        }
        case '/upload-delete': {
          this.uploads.delete(body['uploadId'] as string);
          await this.persist('uploads');
          return Response.json({});
        }
        default:
          return new Response('unknown route', { status: 404 });
      }
    } catch (err) {
      // Safety-cap refusals from the cores become 507 (RFC 4918 §7.1) both
      // for the in-process caller and for RemoteDavStore over the wire.
      if (err instanceof DavLimitError) return new Response(err.message, { status: 507 });
      throw err;
    }
  }

  /**
   * One-shot expiry sweep: the lazy purges only run when a path is touched
   * again, so the alarm fires at the earliest real expiry and drops whatever
   * the lazy passes would never revisit (never-re-touched locked paths,
   * abandoned uploads), then re-arms for the next one.
   */
  override async alarm(): Promise<void> {
    const now = Date.now();
    let changed = false;
    for (const [key, records] of this.locks) {
      const live = records.filter((r) => r.expiresAt > now);
      if (live.length !== records.length) {
        changed = true;
        if (live.length > 0) this.locks.set(key, live);
        else this.locks.delete(key);
      }
    }
    for (const [id, session] of this.uploads) {
      if (isExpired(session)) {
        this.uploads.delete(id);
        changed = true;
      }
    }
    if (changed) {
      try {
        await this.persist();
      } catch {
        // A failed sweep write is bounded by the next alarm/lazy purge.
      }
    }
    await this.armSweep();
  }
}
