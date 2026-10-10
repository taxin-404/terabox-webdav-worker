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
 *
 * Both implementations delegate to the same pure core functions below, so
 * the semantics cannot drift.
 */

export interface LockRecord {
  token: string;
  scope: 'exclusive' | 'shared';
  /** RFC 4918 depth: "0" or "Infinity". */
  depth: string;
  /** Inner XML of the request's <owner> element. */
  owner: string;
  expiresAt: number;
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
}

export interface LockOutcome {
  ok: boolean;
  refreshed: boolean;
  record: LockRecord;
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
  lockAcquire(path: string, req: LockRequest): Promise<LockOutcome>;
  unlock(path: string, token: string): Promise<UnlockOutcome>;
  describe(paths: string[]): Promise<Record<string, PathState>>;
  propPatch(path: string, ops: PropPatchOp[]): Promise<Record<string, string>>;
  relocate(items: RelocateItem[]): Promise<void>;
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

/** Locks on the path itself, plus Infinity-depth locks on its ancestors. */
function applyingLocksOf(locks: Map<string, LockRecord[]>, path: string): LockRecord[] {
  const now = Date.now();
  const out: LockRecord[] = [];
  for (const [lockedPath, records] of locks) {
    for (const rec of records) {
      if (rec.expiresAt <= now) continue;
      if (
        lockedPath === path ||
        (rec.depth === 'Infinity' && path.startsWith(lockedPath + '/'))
      ) {
        out.push(rec);
      }
    }
  }
  return out;
}

function coreCheckTokens(
  locks: Map<string, LockRecord[]>,
  path: string,
  tokens: string[],
): TokenCheck {
  purgeAt(locks, path);
  const applying = applyingLocksOf(locks, path);
  const recordTokens = applying.map((r) => r.token);
  const applies: string[] = [];
  for (const token of new Set(tokens)) {
    if (recordTokens.includes(token) || isOurUnexpiredToken(token)) applies.push(token);
  }
  return { applies, recordTokens, applying: applying.length };
}

function coreLockAcquire(
  locks: Map<string, LockRecord[]>,
  path: string,
  req: LockRequest,
): LockOutcome {
  const now = Date.now();
  // Refresh: a presented token matches a lock on this resource or on an
  // Infinity-depth ancestor (litmus indirect_refresh) — extend in place.
  const refreshable = applyingLocksOf(locks, path).find((r) => req.presented.includes(r.token));
  if (refreshable) {
    refreshable.expiresAt = now + req.seconds * 1000;
    return { ok: true, refreshed: true, record: refreshable };
  }
  const existing = purgeAt(locks, path);
  if (existing.length > 0) {
    // Already locked and not the owner: an exclusive lock admits nothing
    // else, and a shared lock admits only further shared requests
    // (RFC 4918 §9.10.6).
    if (!req.shared || existing.some((r) => r.scope === 'exclusive')) {
      return {
        ok: false,
        refreshed: false,
        record: existing.find((r) => r.scope === 'exclusive') ?? existing[0]!,
      };
    }
  }
  // Re-acquire the client's own still-valid token when its record was lost
  // (isolate rotation); any other presented token is ignored and a fresh
  // one minted.
  const token = req.presented.find(isOurUnexpiredToken) ?? makeLockToken(req.seconds);
  const record: LockRecord = {
    token,
    scope: req.shared ? 'shared' : 'exclusive',
    depth: req.depth,
    owner: req.owner,
    expiresAt: now + req.seconds * 1000,
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
): UnlockOutcome {
  const records = purgeAt(locks, path);
  const index = records.findIndex((r) => r.token === token);
  if (index === -1) {
    // A self-issued token whose record is gone means the lock has already
    // lapsed: succeeding is the graceful answer. Foreign/forged tokens 409.
    return isOurUnexpiredToken(token) ? 'lapsed' : 'nomatch';
  }
  records.splice(index, 1);
  if (records.length > 0) locks.set(path, records);
  else locks.delete(path);
  return 'removed';
}

function coreDescribe(
  locks: Map<string, LockRecord[]>,
  props: Map<string, Record<string, string>>,
  paths: string[],
): Record<string, PathState> {
  const out: Record<string, PathState> = {};
  for (const path of new Set(paths)) {
    out[path] = {
      locks: purgeAt(locks, path),
      props: props.get(path) ?? {},
    };
  }
  return out;
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
  if (Object.keys(store).length > 0) props.set(path, store);
  else props.delete(path);
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
  rekeyCore(props, item.src, item.dest!, item.mode, item.recursive);
  if (item.mode === 'move' && item.withLocks) {
    rekeyCore(locks, item.src, item.dest!, 'move', item.recursive);
  }
}

/* ------------------------------------------------------------------ */
/* In-memory implementation (default, per isolate)                     */
/* ------------------------------------------------------------------ */

export class MemoryDavStore implements DavStore {
  private locks = new Map<string, LockRecord[]>();
  private props = new Map<string, Record<string, string>>();

  /** Test hook: clear per-isolate advisory state between test cases. */
  reset(): void {
    this.locks.clear();
    this.props.clear();
  }

  async checkTokens(path: string, tokens: string[]): Promise<TokenCheck> {
    return coreCheckTokens(this.locks, path, tokens);
  }

  async lockAcquire(path: string, req: LockRequest): Promise<LockOutcome> {
    return coreLockAcquire(this.locks, path, req);
  }

  async unlock(path: string, token: string): Promise<UnlockOutcome> {
    return coreUnlock(this.locks, path, token);
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
}

const sharedMemoryStore = new MemoryDavStore();

/** Test hook: clear per-isolate advisory state between test cases. */
export function resetDavVolatileState(): void {
  sharedMemoryStore.reset();
}

/** Pick the store: Durable Object when bound, per-isolate memory otherwise. */
export function createDavStore(env: Env): DavStore {
  return env.DAV_STATE ? new RemoteDavStore(env.DAV_STATE) : sharedMemoryStore;
}

/* ------------------------------------------------------------------ */
/* Durable Object client                                               */
/* ------------------------------------------------------------------ */

const DO_NAME = 'terabox-dav-state';

export class RemoteDavStore implements DavStore {
  constructor(private readonly ns: DurableObjectNamespace) {}

  private stub(): DurableObjectStub {
    return this.ns.get(this.ns.idFromName(DO_NAME));
  }

  private async call<T>(route: string, body: unknown): Promise<T> {
    const res = await this.stub().fetch(`https://dav-state${route}`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`dav-state ${route}: HTTP ${res.status}`);
    return (await res.json()) as T;
  }

  checkTokens(path: string, tokens: string[]): Promise<TokenCheck> {
    return this.call<TokenCheck>('/tokens', { path, tokens });
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
}

/* ------------------------------------------------------------------ */
/* The Durable Object itself                                           */
/* ------------------------------------------------------------------ */

interface StoredShape {
  locks?: Array<[string, LockRecord[]]>;
  props?: Array<[string, Record<string, string>]>;
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
  private readonly ready: Promise<void>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ready = this.load();
  }

  private async load(): Promise<void> {
    const [locks, props] = await Promise.all([
      this.ctx.storage.get<StoredShape['locks']>('locks'),
      this.ctx.storage.get<StoredShape['props']>('props'),
    ]);
    this.locks = new Map(locks ?? []);
    this.props = new Map(props ?? []);
  }

  private async persist(): Promise<void> {
    await this.ctx.storage.put({
      locks: [...this.locks],
      props: [...this.props],
    });
  }

  override async fetch(request: Request): Promise<Response> {
    await this.ready;
    if (request.method !== 'POST') {
      return new Response('POST only', { status: 405 });
    }
    const url = new URL(request.url);
    const body = (await request.json()) as Record<string, unknown>;
    switch (url.pathname) {
      case '/tokens': {
        const out = coreCheckTokens(this.locks, body['path'] as string, body['tokens'] as string[]);
        return Response.json(out);
      }
      case '/lock': {
        const out = coreLockAcquire(this.locks, body['path'] as string, body['req'] as LockRequest);
        if (out.ok) await this.persist();
        return Response.json(out);
      }
      case '/unlock': {
        const out = coreUnlock(this.locks, body['path'] as string, body['token'] as string);
        if (out === 'removed') await this.persist();
        return Response.json(out);
      }
      case '/describe': {
        const out = coreDescribe(this.locks, this.props, body['paths'] as string[]);
        return Response.json(out);
      }
      case '/patch': {
        const out = corePatch(this.props, body['path'] as string, body['ops'] as PropPatchOp[]);
        await this.persist();
        return Response.json(out);
      }
      case '/relocate': {
        for (const item of body['items'] as RelocateItem[]) {
          coreRelocate(this.locks, this.props, item);
        }
        await this.persist();
        return Response.json({});
      }
      default:
        return new Response('unknown route', { status: 404 });
    }
  }
}
