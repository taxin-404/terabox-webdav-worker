import {
  decodeMD5,
  getChunkSize,
  jsTokenFromHtml,
  placeholderBlockList,
  sign,
  splitPath,
  valuedCookie,
  MAX_FREE_FILE_BYTES,
  MAX_PREMIUM_FILE_BYTES,
} from './sign';
import { md5Hex } from './md5';
import type { TeraboxItem } from './types';

const DEFAULT_BASE_URL = 'https://www.terabox.com';
const APP_ID = '250528';
const CHANNEL = 'dubox';
/** Browser UA the web flow sends on PCS uploads (TeraboxUploaderCLI). */
const WEB_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14.2; rv:121.0) Gecko/20100101 Firefox/121.0';
/** Max bytes peeked from a download response to classify stream vs errno
 *  gate (~100-byte JSON bodies; anything larger is stitched back on-stream). */
const DOWNLOAD_SNIFF_LIMIT = 8192;

const RETRY_STATUS = new Set([429, 500, 502, 503, 504, 509]);
const JS_TOKEN_ERRORS = new Set([4000023, 400141, 450016]);
/** Minimum gap between outbound Terabox calls (bclone minSleep 400 ms parity). */
const DEFAULT_MIN_GAP_MS = 400;
/** Upstream fetch bounds: a hung mint or bodiless API fetch held the handler
 *  open until the edge cut the client's connection (litmus lockbomb's
 *  "connection timed out" and the 60 s `slow` handlers), and a mint-page
 *  network failure escaped as a plain Error → generic 500. Timeout here
 *  surfaces both as TeraboxError(-5) → 502. Deliberately NOT applied to
 *  fetches that carry upload bodies or stream downloads: their transfers are
 *  only bounded by the transfer itself. */
const API_TIMEOUT_MS = 30_000;
const MINT_TIMEOUT_MS = 15_000;
/** Header-phase bound for resolved (cache-recalled) download fetches: a
 *  capability URL that accept-then-hangs would otherwise stick for the whole
 *  cache TTL with no retry left. Cleared the moment headers land, so bodies
 *  stream unbounded like every other download. */
const RESOLVED_HEADER_TIMEOUT_MS = 15_000;
/** Next free upstream slot, shared by every request handled by THIS isolate.
 *  Within one isolate the reservation in pace() is race-free (no await
 *  between read and write), so concurrent requests here cannot burst — but
 *  Cloudflare runs one module registry per isolate, so N isolates could each
 *  schedule one call per MIN_GAP_MS. Account-wide pacing therefore goes
 *  through the DAV_STATE DO (store.apiSlot, wired per request in
 *  handleWebDav); the isolate floor below stays as the backstop whenever the
 *  DO is unbound, unreachable or cooling down. */
let nextUpstreamSlot = 0;
/** Account-wide reservation cooldown after a DO failure or timeout: the
 *  local floor keeps pacing meanwhile, so a sick DO costs one bounded wait
 *  per window instead of one per request. */
let apiSlotFailUntil = 0;
/** Test hook: how many reservations pace() completed through the DO. */
export const paceAccountReservations = { count: 0 };
/** Budget for one DO reservation round-trip (normally ~1-5 ms). */
const API_SLOT_TIMEOUT_MS = 300;
/** Cooldown after a failed account-wide reservation. */
const API_SLOT_COOLDOWN_MS = 30_000;
/** Reused jsToken across WebDAV requests — the root fetch is the call most
 *  exposed to Terabox's verification gate, so mint at most once per TTL. */
const JS_TOKEN_CACHE = { token: '', at: 0 };
const JS_TOKEN_TTL_MS = 5 * 60_000;
/** One in-flight mint per isolate: concurrent gate-rejected requests share it
 *  instead of each hitting the verification gate with its own root fetch. */
let inflightMint: Promise<string> | null = null;
/** Module-level caches: the premium probe and locateupload walk are
 *  account-scoped, not request-scoped. Re-running them per HTTP request
 *  burned the Free plan's 10 ms CPU budget (Cloudflare error 1102) once the
 *  resumable `begin` endpoint chained them with precreate + stat + parent
 *  checks. Cache once per isolate; a forced refresh still works. */
const PREMIUM_CACHE = { checked: false, isPremium: false };
const UPLOAD_HOSTS_CACHE: { hosts: string[] | null; at: number } = { hosts: null, at: 0 };
/** Upload clusters retire and gates rotate — don't pin a list for a lifetime. */
const UPLOAD_HOSTS_TTL_MS = 10 * 60_000;

/** Test hook: clear the module-level account caches between test cases. */
export function resetTeraboxCaches(): void {
  JS_TOKEN_CACHE.token = '';
  JS_TOKEN_CACHE.at = 0;
  inflightMint = null;
  PREMIUM_CACHE.checked = false;
  PREMIUM_CACHE.isPremium = false;
  UPLOAD_HOSTS_CACHE.hosts = null;
  UPLOAD_HOSTS_CACHE.at = 0;
  paceAccountReservations.count = 0;
  apiSlotFailUntil = 0;
  nextUpstreamSlot = 0;
}
/** Desktop-app UA used when minting the jsToken from the root page. */
const DESKTOP_APP_USER_AGENT = 'terabox;1.37.0.7;PC;PC-Windows;10.0.22631;WindowsTeraBox';

const TERABOX_ERRORS: Record<number, string> = {
  1: 'System error',
  2: 'Required parameters are missing',
  3: 'No more than 100 files at a time',
  4: 'New file name error',
  5: 'Illegal target directory',
  6: 'Failed to login, please try again later',
  7: 'Illegal NS or no access',
  8: 'Illegal ID or no access',
  10: 'Unsuccessful superfile',
  11: 'Illegal user id or no access',
  12: 'Some files already exist in target directory',
  15: 'Operation failed',
  '-1': 'User name or password verification failed',
  '-6': 'Failed to login, please try again later',
  '-7': 'Invalid file name',
  '-8': 'The file already exists',
  '-9': "The file doesn't exist",
  '-10': 'Your space is insufficient',
  '-11': 'The parent directory does not exist',
  '-12': 'Error in extraction code',
  '-13': 'The device has been bonded',
  '-14': 'The account has been initialized',
  '-19': 'Please enter the verification code',
  '-22': 'Shared files cannot be renamed or moved',
  '-25': 'Not beta user',
  '-32': 'Your space is insufficient',
  58: 'File is too large for your plan',
  4000023: 'Invalid session, refreshing token',
  400141: 'Verification required, refreshing token',
  450016: 'Invalid session, refreshing token',
};

export class TeraboxError extends Error {
  /** Pipeline stage that failed ("precreate", "chunk1", ...), for diagnostics. */
  step?: string;
  /** Verbatim msg/errmsg from the upstream JSON, when the API provided one. */
  upstream?: string;
  /** HTTP status of a non-2xx upstream response (drives cluster failover). */
  httpStatus?: number;
  /**
   * Set when the file was created upstream but failed the control-md5
   * comparison. The bytes Terabox stored are not the bytes we sent, so the
   * caller must not treat a retry as a fresh create — re-running create
   * reproduces the mismatch (and answers -8 → 409 on a create-only path).
   */
  integrity?: boolean;

  constructor(
    public readonly errno: number,
    message: string,
  ) {
    super(message);
    this.name = 'TeraboxError';
  }
}

/** Run fn, stamping any TeraboxError with the stage that failed. */
async function atStep<T>(step: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof TeraboxError && !error.step) error.step = step;
    throw error;
  }
}

export function errIsNum(err: unknown, code: number): boolean {
  return err instanceof TeraboxError && err.errno === code;
}

export function es<T>(teraboxErrno: number): TeraboxError {
  return new TeraboxError(teraboxErrno, TERABOX_ERRORS[teraboxErrno] || `Terabox error ${teraboxErrno}`);
}

/** Ensure a path has a leading slash (mirrors x1arch's TBPath). */
export function tbPath(path: string): string {
  if (path.length === 0) return '/';
  return path.startsWith('/') ? path : '/' + path;
}

/**
 * Mirror the web app's formatDownloadURL: browsers never fetch a dlink on
 * the <prefix>-d data gateway — they rewrite the host to the main origin
 * first (dm-d.terabox.com → dm.terabox.com; d.x → www.x when the page is
 * www). That gateway's /file/ path is what answers 400141 "need verify"
 * from datacenter IPs, so we follow the exact same rewrite before fetching.
 * CDN hosts (…-ddata…) and already-main hosts are left untouched.
 */
export function browserDlinkUrl(raw: string, pageHostname: string): string {
  try {
    const url = new URL(raw);
    if (!url.pathname.startsWith('/file/')) return raw;
    const bare = /^d\.(.+)$/.exec(url.hostname);
    if (bare) {
      url.hostname = pageHostname.startsWith('www.') ? `www.${bare[1]}` : bare[1]!;
      return url.toString();
    }
    const gateway = /^([a-z0-9]+)-d\.(.+)$/.exec(url.hostname);
    if (gateway) {
      url.hostname = `${gateway[1]}.${gateway[2]}`;
      return url.toString();
    }
    return raw;
  } catch {
    return raw;
  }
}

/** Host of the final hop a download fetch landed on (after redirects). */
function downloadHost(finalUrl: string, fallback: string): string {
  for (const candidate of [finalUrl, fallback]) {
    try {
      const host = new URL(candidate).hostname;
      if (host) return host;
    } catch {
      /* try the next candidate */
    }
  }
  return 'dlink';
}

/** Parse a Terabox JSON error body (nonzero errno + request markers).
 *  Returns null for anything else — including legitimate file content. */
function errnoBodyFrom(text: string): { errno: number; msg: string } | null {
  if (!text.trimStart().startsWith('{')) return null;
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof json !== 'object' || json === null) return null;
  const record = json as Record<string, unknown>;
  // The web API speaks `errno`; the PCS/app routes speak `error_code`
  // ({"error_code":31045,"error_msg":…}). Both shapes must be caught here —
  // a download response shaped like either one is a gate/error, never content.
  const errno = Number(record.errno !== undefined ? record.errno : record.error_code);
  if (!Number.isFinite(errno) || errno === 0) return null;
  const marked =
    'request_id' in record ||
    'request_id_string' in record ||
    'errmsg' in record ||
    'error_msg' in record ||
    'error_code' in record;
  if (!marked) return null;
  const msg =
    typeof record.errmsg === 'string'
      ? record.errmsg
      : typeof record.error_msg === 'string'
        ? record.error_msg
        : '';
  return { errno, msg };
}

export interface ApiOptions {
  method?: string;
  query?: Record<string, string>;
  form?: FormData | Record<string, string>;
  /** Raw body: a string, or a prebuilt buffer (the hand-built multipart for
   *  a chunk upload — one copy instead of FormData's two, and a known
   *  Content-Length, which Terabox's origin requires). */
  body?: string | Uint8Array;
  contentType?: string;
  /** Do not append app_id/channel/clienttype/jsToken and skip jsToken / host retries. */
  skipCommonParams?: boolean;
  /** Send nothing but the URL's own query and an Accept header: the
   *  locateupload cluster endpoint is served bare (Alist parity) and answers
   *  400141 "need verify" when session headers accompany it from
   *  datacenter IPs. */
  bare?: boolean;
  /** The response is not an ErrorAPI shape (chunk upload); skip errno handling. */
  skipErrorRetry?: boolean;
  /** Return the JSON even when the top-level errno is non-zero, so the caller
   *  can read the authoritative per-item `info[].errno` (filemetas returns
   *  top-level 12 alongside info[].errno -9 for missing paths). */
  raw?: boolean;
  /** Absolute URL override (chunk upload host). */
  absoluteUrl?: string;
  /** Extra request headers merged over the defaults (Origin/Referer/UA for
   *  the PCS cluster, which checks them). */
  headers?: Record<string, string>;
}

interface ApiResult<T> {
  json: T;
  headers: Headers;
  status: number;
}

/**
 * Pull exactly `size` bytes from `body` as fixed `chunkSize` windows (the
 * last one short, one empty window for a zero-byte size), carrying bytes the
 * transport delivered past a window boundary over to the next one. Returns
 * null once — as soon as — the body ends short of `size`, so callers can
 * refuse to finalize instead of publishing a truncated file.
 */
function streamWindows(
  body: ReadableStream<Uint8Array>,
  size: number,
  chunkSize: number,
): { next(): Promise<Uint8Array | null>; cancel(): Promise<void> } {
  const reader = body.getReader();
  const maxWindows = size === 0 ? 1 : Math.ceil(size / chunkSize);
  let emitted = 0;
  let delivered = 0;
  let carry: Uint8Array | null = null;
  return {
    async next() {
      if (emitted >= maxWindows) return null;
      emitted += 1;
      if (size === 0) return new Uint8Array(0);
      const want = Math.min(chunkSize, size - delivered);
      const window = new Uint8Array(want);
      let filled = 0;
      if (carry && carry.byteLength > 0) {
        const take = Math.min(carry.byteLength, want);
        window.set(carry.subarray(0, take), 0);
        filled = take;
        carry = carry.byteLength > take ? carry.subarray(take) : null;
      }
      while (filled < want) {
        const { done, value } = await reader.read();
        if (done) return null; // short body: caller throws before create()
        if (!value || value.byteLength === 0) continue;
        const take = Math.min(value.byteLength, want - filled);
        window.set(value.subarray(0, take), filled);
        filled += take;
        if (value.byteLength > take) carry = value.subarray(take);
      }
      delivered += want;
      return window;
    },
    async cancel() {
      await reader.cancel().catch(() => undefined);
    },
  };
}

/**
 * Options for {@link TeraboxClient.fetchDownload}. `resolved` is a
 * cache-recalled URL, so the caller MUST state its cookieless boundary
 * explicitly: a forgotten flag would default to replaying the session to
 * whatever host the URL names. The union makes that omission a type error
 * rather than a fail-open default.
 */
export type ResolvedFetchOpts =
  | { resolved?: false; cookieless?: never; headerTimeoutMs?: never }
  | { resolved: true; cookieless: boolean; headerTimeoutMs?: number };

export class TeraboxClient {
  private cookie: string;
  private baseUrl: string;
  private jsToken = '';
  private uploadHost: string | null = null;
  /** Candidate superfile2 hosts from locateupload's server[] list. */
  private uploadHosts: string[] | null = null;
  private isPremium = false;
  private premiumChecked = false;
  /** Terabox cluster prefix (Url-Domain-Prefix header); doubles as the
   *  fallback origin for upload-host discovery. */
  private domainPrefix = 'jp';
  /** Pre-minted token from env JSTOKEN (Alist/CLI users paste window.jsToken). */
  private readonly configuredJsToken: string;
  private readonly minGapMs: number;
  private readonly maxChunkBytes: number | undefined;
  /** Account-wide slot reserver — wired per request by handleWebDav to the
   *  DAV_STATE DO (advisory: left unset for the memory fallback, and any
   *  failure falls back to the isolate-local floor). */
  apiSlotReserver: ((minGapMs: number) => Promise<number>) | undefined;

  constructor(cookie: string, domain = DEFAULT_BASE_URL, opts: { jsToken?: string; minGapMs?: number; maxChunkBytes?: number } = {}) {
    this.cookie = valuedCookie(cookie);
    this.baseUrl = /^https?:\/\//.test(domain) ? domain : 'https://' + domain;
    this.configuredJsToken = (opts.jsToken || '').trim();
    this.minGapMs = typeof opts.minGapMs === 'number' && opts.minGapMs >= 0 ? opts.minGapMs : DEFAULT_MIN_GAP_MS;
    this.maxChunkBytes =
      typeof opts.maxChunkBytes === 'number' && opts.maxChunkBytes > 0 ? opts.maxChunkBytes : undefined;
  }

  /**
   * Reserve the next upstream slot and sleep until it (rate-limit guard).
   * Every outbound Terabox call — API, jsToken mint, download stream — passes
   * through here. The isolate-local floor always applies; when
   * apiSlotReserver is wired (handleWebDav → DAV_STATE DO) an account-wide
   * reservation is taken too and the longer of the two waits is slept, so
   * the aggregate upstream rate is 1 / MIN_GAP_MS across ALL isolates.
   */
  async pace(): Promise<void> {
    const slot = Math.max(Date.now(), nextUpstreamSlot + this.minGapMs);
    nextUpstreamSlot = slot;
    let wait = slot - Date.now();
    const reserver = this.apiSlotReserver;
    if (reserver && Date.now() >= apiSlotFailUntil) {
      try {
        const global = await this.reserveAccountSlot(reserver);
        paceAccountReservations.count += 1;
        wait = Math.max(wait, global);
      } catch {
        // Advisory: the local floor above already stands; back off so the
        // outage costs one bounded wait, not one per request.
        apiSlotFailUntil = Date.now() + API_SLOT_COOLDOWN_MS;
      }
    }
    if (wait > 0) await this.sleep(wait);
  }

  /** One account-wide reservation under a hard budget: this call sits on the
   *  hot path of every upstream request, so a sick DO may delay a request by
   *  at most API_SLOT_TIMEOUT_MS before the cooldown skips it entirely.
   *  A reservation that times out still consumed its slot on the DO timeline
   *  (the response was merely lost): later reservations queue briefly behind
   *  a gap nobody waits on — a phantom delay. Accepted: every request already
   *  inside this call when the DO hangs times out together (N phantoms for
   *  the N in-flight, not a per-window trickle), the cooldown then stops new
   *  reservations for API_SLOT_COOLDOWN_MS, the local floor already bounds
   *  the burst, and the timeline re-syncs on the next successful reservation. */
  private reserveAccountSlot(reserver: (minGapMs: number) => Promise<number>): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('api slot reservation timed out')), API_SLOT_TIMEOUT_MS);
      reserver(this.minGapMs).then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private errorMessage(errno: number, fallback: string): string {
    return TERABOX_ERRORS[errno] || TERABOX_ERRORS[String(errno) as unknown as number] || fallback;
  }

  /**
   * Core request wrapper (ported from apiExec). Adds the common
   * app_id/channel/clienttype/jsToken params, the session Cookie, retries on
   * rate-limit/server errors, refreshes jsToken, and re-roots the base host.
   */
  private async request<T>(
    path: string,
    opts: ApiOptions = {},
    attempt = 0,
    jsTokenTried = false,
    rerooted = false,
  ): Promise<ApiResult<T>> {
    const url = new URL(opts.absoluteUrl || this.baseUrl + path);

    if (!opts.bare && !opts.skipCommonParams) {
      url.searchParams.set('app_id', APP_ID);
      url.searchParams.set('web', '1'); // browser/alist parity: every web API call carries it
      url.searchParams.set('channel', CHANNEL);
      url.searchParams.set('clienttype', '0');
    }
    // The jsToken is account-bound auth (see ensureJsToken): send it on every
    // API call once minted — except bare and skipCommonParams requests; all
    // working clients omit it from the superfile2 chunk upload.
    if (this.jsToken && !opts.bare && !opts.skipCommonParams) {
      url.searchParams.set('jsToken', this.jsToken);
    }
    for (const [key, value] of Object.entries(opts.query || {})) {
      url.searchParams.set(key, value);
    }

    const headers: Record<string, string> = {
      Accept: 'application/json, text/plain, */*',
    };
    if (!opts.bare) {
      headers['Referer'] = this.baseUrl;
      headers['X-Requested-With'] = 'XMLHttpRequest';
      headers['Cookie'] = this.cookie;
    }
    if (opts.headers) Object.assign(headers, opts.headers);
    let body: BodyInit | undefined;
    if (opts.form instanceof FormData) {
      body = opts.form;
    } else if (opts.form) {
      const form = new FormData();
      for (const [key, value] of Object.entries(opts.form)) form.set(key, value);
      body = form;
    } else if (opts.body !== undefined) {
      headers['Content-Type'] = opts.contentType || 'application/x-www-form-urlencoded';
      body = opts.body;
    }

    let response: Response;
    try {
      await this.pace(); // rate-limit guard: no bursts toward Terabox
      // Bodiless calls (stats, lists, quotas, task polls) get a hard time
      // bound so a hung upstream answers 502 instead of holding the request
      // until the edge drops the client. Calls carrying an upload body are
      // exempt: their transfer is only bounded by the transfer itself.
      response = await fetch(url.toString(), {
        method: opts.method || 'GET',
        headers,
        body,
        ...(body === undefined ? { signal: AbortSignal.timeout(API_TIMEOUT_MS) } : {}),
      });
    } catch (error) {
      throw new TeraboxError(-5, `Terabox network error: ${error instanceof Error ? error.message : String(error)}`);
    }

    if (RETRY_STATUS.has(response.status) && attempt < 3) {
      // Workers anti-pattern guard: an unread response body keeps the
      // connection open — release it before sleeping/recursing.
      void response.body?.cancel().catch(() => undefined);
      // bclone pacing: honour Retry-After when present, cap the sleep at 5 s.
      const retryAfter = Number(response.headers.get('Retry-After'));
      const delay =
        Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 5000) : attempt * 1000;
      await this.sleep(delay);
      return this.request<T>(path, opts, attempt + 1, jsTokenTried, rerooted);
    }
    // Follow Terabox's cluster hint for the *-data upload-host endpoint.
    const domainPrefix = response.headers.get('Url-Domain-Prefix');
    if (domainPrefix) this.domainPrefix = domainPrefix;
    if (response.status < 200 || response.status > 299) {
      // Capture the upstream body: HTTP-level failures (403 WAF pages, rate
      // limit HTML) carry no JSON errno and would otherwise be opaque.
      const snippet = (await response.text().catch(() => '')).slice(0, 300);
      const error = new TeraboxError(-5, `Terabox http error ${response.status}`);
      if (snippet) error.upstream = snippet;
      error.httpStatus = response.status;
      throw error;
    }

    const text = await response.text();
    let json: any = {};
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        if (!opts.skipErrorRetry) {
          throw new TeraboxError(-5, 'Terabox returned a non-JSON response');
        }
      }
    }

    if (!opts.skipErrorRetry) {
      const errno = typeof json.errno === 'number' ? json.errno : typeof json.errno === 'string' ? Number(json.errno) : 0;

      if (errno !== 0) {
        // Refresh jsToken exactly once, then retry the request. The re-root
        // latch must survive the mint recursion (otherwise a mint-then--6
        // sequence could spend a second host change).
        if (JS_TOKEN_ERRORS.has(errno) && !jsTokenTried) {
          await this.ensureJsToken(true);
          return this.request<T>(path, opts, attempt, true, rerooted);
        }

        // Some accounts are served from a mirrored host; re-root and retry —
        // at most ONCE per request (the rerooted latch) and only to a host
        // that actually differs (a prefix naming the host we are already on,
        // or one that keeps arriving after the re-root, used to recurse with
        // no bound at all: one upstream call + pace() slot per iteration
        // until the subrequest budget or the client's timeout fired).
        const prefix = response.headers.get('Url-Domain-Prefix');
        if (prefix && errno === -6 && !rerooted) {
          const host = new URL(this.baseUrl).hostname.split('.');
          const sld = host.length >= 2 ? host[host.length - 2] : 'terabox';
          const tld = host.length >= 2 ? host[host.length - 1]! : 'com';
          const next = `https://${prefix}.${sld}.${tld}`;
          if (next !== this.baseUrl) {
            this.baseUrl = next;
            return this.request<T>(path, opts, attempt, jsTokenTried, true);
          }
        }

        // The caller wants to inspect info[] itself; retries above still ran.
        if (opts.raw) {
          return { json: json as T, headers: response.headers, status: response.status };
        }

        const message = this.errorMessage(errno, `Terabox error ${errno}`);
        const error = new TeraboxError(errno, message);
        const upstream =
          typeof json.msg === 'string'
            ? json.msg
            : typeof json.errmsg === 'string'
              ? json.errmsg
              : typeof json.message === 'string'
                ? json.message
                : '';
        if (upstream) error.upstream = upstream;
        throw error;
      }
    }

    return { json: json as T, headers: response.headers, status: response.status };
  }

  private async ensureJsToken(force = false): Promise<void> {
    if (this.jsToken && !force) return;
    if (!force) {
      // A freshly minted cached token outranks the configured env JSTOKEN
      // (the same window.jsToken Alist and TeraboxUploaderCLI ask their users
      // to paste): a stale configured token is never marked rejected, so
      // preferring it made every write repeat reject → force-mint → retry
      // forever. The env token still seeds the choice while the cache is
      // cold; only an API rejection (force) mints fresh.
      if (JS_TOKEN_CACHE.token && Date.now() - JS_TOKEN_CACHE.at < JS_TOKEN_TTL_MS) {
        this.jsToken = JS_TOKEN_CACHE.token;
        return;
      }
      if (this.configuredJsToken) {
        this.jsToken = this.configuredJsToken;
        return;
      }
    }
    // Concurrent gate-rejected writes share ONE in-flight mint: two parallel
    // force-mints would otherwise hit the verification gate twice, exactly
    // the pressure the mint cache exists to avoid.
    let mint = inflightMint;
    if (!mint) {
      mint = this.mintJsToken();
      inflightMint = mint;
      const clear = () => {
        if (inflightMint === mint) inflightMint = null;
      };
      void mint.then(clear, clear);
    }
    this.jsToken = await mint;
  }

  /**
   * Mint a session-bound jsToken from the root page and record it in the
   * module cache. The session Cookie must be sent: a token minted for an
   * anonymous request (192 hex chars) is rejected by precreate/create with
   * 4000023/400141 "need verify". Only a token bound to the account
   * (128 hex chars) works.
   */
  private async mintJsToken(): Promise<string> {
    const pages = [`${this.baseUrl}/`, `${this.baseUrl}/main?category=all`];
    const outcome: string[] = [];
    for (const page of pages) {
      const { response, html } = await this.fetchMintPage(page);
      const token = jsTokenFromHtml(html);
      const landed = (response.url || page).replace(this.baseUrl, '') || '/';
      outcome.push(`${landed}=${token ? 'token' : 'none'}`);
      if (token) {
        JS_TOKEN_CACHE.token = token;
        JS_TOKEN_CACHE.at = Date.now();
        return token;
      }
    }
    // Terabox answers pages with a 302 to /simple-verify when the IP or the
    // session is rate-limited; that page has no jsToken. Probe once without
    // the Cookie to tell IP gating (anonymous also fails) from session
    // gating (anonymous still carries a token) — report both outcomes.
    const anon = await this.fetchMintPage(`${this.baseUrl}/`, false);
    const anonToken = jsTokenFromHtml(anon.html);
    const anonLanded = (anon.response.url || `${this.baseUrl}/`).replace(this.baseUrl, '') || '/';
    outcome.push(`anon:${anonLanded}=${anonToken ? 'token' : 'none'}`);
    const error = new TeraboxError(400141, 'jsToken unavailable (Terabox verification required)');
    error.upstream = outcome.join(' ').slice(0, 300);
    throw error;
  }

  /** Paced page fetch used for jsToken minting (with or without the session). */
  private async fetchMintPage(url: string, withCookie = true): Promise<{ response: Response; html: string }> {
    await this.pace();
    try {
      const response = await fetch(url, {
        headers: {
          ...(withCookie ? { Cookie: this.cookie, Referer: this.baseUrl } : {}),
          'User-Agent': DESKTOP_APP_USER_AGENT,
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(MINT_TIMEOUT_MS),
      });
      return { response, html: await response.text() };
    } catch (error) {
      // Raw network/abort failures here previously escaped every wrapper as
      // a plain Error and the fetch handler answered a generic 500; every
      // other upstream site already maps this to TeraboxError(-5) → 502.
      throw new TeraboxError(
        -5,
        `Terabox mint network error: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async checkLogin(): Promise<void> {
    const { json } = await this.request<{ errno?: number }>('/api/check/login');
    if (json.errno) throw new TeraboxError(json.errno, this.errorMessage(json.errno, 'Not logged in'));
  }

  async homeInfo(): Promise<{ sign1: string; sign3: string; timestamp: number }> {
    const { json } = await this.request<{
      data?: { sign1?: string; sign3?: string; timestamp?: number };
    }>('/api/home/info');
    return {
      sign1: json.data?.sign1 || '',
      sign3: json.data?.sign3 || '',
      timestamp: json.data?.timestamp || 0,
    };
  }

  /** List a directory, following pagination (100 entries/page). */
  async list(dir: string): Promise<TeraboxItem[]> {
    const absDir = tbPath(dir);
    const items: TeraboxItem[] = [];
    const pageSize = 100;
    const MAX_PAGES = 100;
    for (let page = 1; ; page++) {
      const { json } = await this.request<{ errno?: number; list?: TeraboxItem[] }>('/api/list', {
        query: { dir: absDir, page: String(page), num: String(pageSize) },
      });
      const batch = json.list || [];
      items.push(...batch);
      if (batch.length === 0 || batch.length < pageSize) break;
      // The API caps a listing at 100 pages (10 000 entries). Stopping
      // silently would make sync clients (rclone/davfs) treat the missing
      // tail as deletions on the next sync — fail loudly instead.
      if (page >= MAX_PAGES) {
        throw new TeraboxError(
          -5,
          `Directory listing truncated: ${dir} exceeds ${MAX_PAGES * pageSize} entries`,
        );
      }
    }
    return items;
  }

  /** Resolve a single item by absolute path. When downloadLink is true the
   *  response includes a direct download URL. */
  async itemInfo(path: string, downloadLink: boolean): Promise<TeraboxItem> {
    // raw: filemetas reports a missing target as top-level errno 12 with the
    // real cause in info[0].errno (-9), so we must read info[] ourselves.
    const { json } = await this.request<{
      errno?: number;
      info?: Array<{ errno?: number } & TeraboxItem>;
    }>('/api/filemetas', {
      query: { target: JSON.stringify([tbPath(path)]), dlink: downloadLink ? '1' : '0' },
      raw: true,
    });
    const entry = json.info?.[0];
    if (entry) {
      if (entry.errno !== undefined && entry.errno !== 0) throw es(entry.errno);
      return entry;
    }
    // No per-item detail: fall back to whatever the top-level errno says.
    if (json.errno) throw es(json.errno);
    throw es(-9);
  }

  /** Create a directory at an absolute path. */
  async mkdir(absPath: string): Promise<void> {
    await this.request<{ errno?: number }>('/api/create', {
      method: 'POST',
      form: { path: tbPath(absPath), isdir: '1', rtype: '0' },
    });
  }

  async downloadLink(fileId: string): Promise<string> {
    const home = await this.homeInfo();
    // 64-bit fs_ids above 2^53 lose precision as JS numbers and mint a
    // different file's link; keep those verbatim and only narrow safe ids.
    const numeric = Number(fileId);
    const fid = Number.isSafeInteger(numeric) ? numeric : fileId;
    const { json } = await this.request<{ errno?: number; dlink?: Array<{ fs_id: string; dlink?: string }> }>(
      '/api/download',
      {
        query: {
          type: 'dlink',
          vip: '2',
          sign: sign(home.sign3, home.sign1),
          timestamp: String(Math.floor(Date.now() / 1000)),
          need_speed: '1',
          fidlist: JSON.stringify([fid]),
        },
      },
    );
    return json.dlink?.[0]?.dlink || '';
  }

  /**
   * PCS app-protocol download URLs (mobile/desktop app parity): GET
   * `/rest/2.0/pcs/file?method=download&path=…` with the session cookie
   * answers a 302 straight to the CDN — there is no signed `/file/<hash>`
   * dlink hop, and that hop is exactly what answers 400141 "need verify"
   * from datacenter IPs. The route family is the same one locateupload runs
   * on (live-proven reachable from Cloudflare), so candidates lead the
   * download ladder. Hosts mirror `ensureUploadHosts`: the deployment's own
   * data gateway first, then `<label>-data`, then the configured origin.
   */
  pcsDownloadUrls(absPath: string): string[] {
    const query = `method=download&app_id=${APP_ID}&path=${encodeURIComponent(tbPath(absPath))}`;
    const hostname = new URL(this.baseUrl).hostname;
    const label = hostname.split('.')[0] ?? '';
    const hosts =
      label && label !== 'www'
        ? [`${label}-d.terabox.com`, `${label}-data.terabox.com`, hostname]
        : [hostname, 'd.terabox.com'];
    return hosts.map((host) => `https://${host}/rest/2.0/pcs/file?${query}`);
  }

  /**
   * Fetch a signed dlink or PCS download stream. The signed URL still requires
   * the session Cookie (bare → HTTP 403), and from datacenter IPs the /file/
   * endpoint answers 400141 "need verify" even with it — the same gate the API
   * remedies with a jsToken, so retry once with a freshly minted token. Both
   * the dlink and the app-protocol route answer with a 302 to a capability URL
   * on the CDN; we follow that hop by hand (Alist parity): the session Cookie
   * never leaves the API origin and Range rides along, so partial GETs survive
   * the redirect. An errno-shaped body must never stream out as file content:
   * it becomes a TeraboxError stamped with `dlink@<host>` so live failures
   * name the exact host that gated.
   *
   * A `resolved` replay of a post-302 capability URL passes `cookieless`
   * (recorded at write time: a hop happened, so the final URL lives on a CDN
   * host the session must never reach — replaying it with Cookie/Referer
   * would leak the session off-origin). Resolved fetches skip the jsToken
   * remedy (re-walking the ladder re-mints under the current token) and run
   * a header-phase timeout so a hung capability URL self-heals instead of
   * sticking for the cache TTL.
   */
  async fetchDownload(
    url: string,
    range?: string | null,
    opts: ResolvedFetchOpts = {},
  ): Promise<{ response: Response; finalUrl: string; cookieless: boolean }> {
    // Follow the browser: fetch the rewritten main-origin URL, not the gated
    // <prefix>-d data-gateway host the raw dlink points at. A `resolved` URL
    // is a final post-302 capability URL recalled by the download-URL cache:
    // it was never a raw dlink, so the browser /file/ rewrite must not touch
    // it — re-running the rewrite would send the fetch somewhere the bytes
    // never came from.
    if (!opts.resolved) url = browserDlinkUrl(url, new URL(this.baseUrl).hostname);
    const credentialLess = Boolean(opts.resolved && opts.cookieless);
    let lastError: TeraboxError | undefined;
    // Resolved replays get exactly one attempt: a gate on a cached artifact
    // means re-mint, not re-token — the ladder below owns recovery.
    const maxAttempts = opts.resolved ? 1 : 2;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      let target = url;
      if (attempt > 0) {
        await this.ensureJsToken(true); // fresh account-bound token for the retry
        if (this.jsToken) {
          const withToken = new URL(url);
          withToken.searchParams.set('jsToken', this.jsToken);
          target = withToken.toString();
        }
      }
      // Credential-free shape mirrors the hop loop below: only UA/Accept/Range
      // cross to a host that never received the session in the first place.
      const headers: Record<string, string> = credentialLess
        ? { 'User-Agent': WEB_USER_AGENT, Accept: '*/*' }
        : {
            Referer: this.baseUrl,
            Cookie: this.cookie,
            'User-Agent': WEB_USER_AGENT,
            Accept: '*/*',
            'Accept-Language': 'en-US,en;q=0.9',
          };
      if (range) headers['Range'] = range;

      // API-origin pacing guard before the stream. A resolved capability URL
      // is a CDN host outside the API rate domain: pacing it would only add
      // the 400 ms floor to every repeat open, which is the TTFB this cache
      // exists to remove.
      if (!opts.resolved) await this.pace();
      let response: Response;
      let finalUrl = target;
      let hopped = false;
      const controller = opts.resolved ? new AbortController() : undefined;
      const headerTimer = controller
        ? setTimeout(() => controller.abort(), opts.headerTimeoutMs ?? RESOLVED_HEADER_TIMEOUT_MS)
        : undefined;
      try {
        response = await fetch(target, { headers, redirect: 'manual', signal: controller?.signal });
        // Follow the CDN hop ourselves: the redirect target is a capability
        // URL that serves bytes with no session, so only the UA (and Range)
        // cross the hop. No pacing here: the capability host is not the API
        // origin, and the 400 ms floor it used to pay was pure added TTFB
        // on every cold open.
        for (let hop = 0; response.status >= 300 && response.status < 400 && hop < 4; hop++) {
          const location = response.headers.get('Location');
          if (!location) break;
          hopped = true;
          finalUrl = new URL(location, finalUrl).toString();
          const hopHeaders: Record<string, string> = { 'User-Agent': WEB_USER_AGENT, Accept: '*/*' };
          if (range) hopHeaders['Range'] = range;
          response = await fetch(finalUrl, { headers: hopHeaders, redirect: 'manual', signal: controller?.signal });
        }
      } catch (error) {
        throw new TeraboxError(
          -5,
          `Terabox download network error: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        // Headers landed (or we bailed): the body must stream unbounded —
        // clearing the timer also disarms the controller before any read.
        if (headerTimer !== undefined) clearTimeout(headerTimer);
      }

      const host = downloadHost(finalUrl, target);
      const verdict = await this.classifyDownload(response, host);
      if (!verdict.error) return { response: verdict.response, finalUrl, cookieless: hopped };
      if (attempt === 0 && JS_TOKEN_ERRORS.has(verdict.error.errno)) {
        lastError = verdict.error;
        continue; // remedy: fresh jsToken, exactly like the API retry
      }
      throw verdict.error;
    }
    throw lastError ?? new TeraboxError(-5, 'Terabox download failed');
  }

  /**
   * Split a dlink response into "stream it" or an errno-shaped TeraboxError.
   * At most ~8 KiB is ever buffered (gate bodies are ~100 bytes); larger
   * bodies are classified by peeking, then stitched back onto the live stream
   * so a legitimate file is never consumed or re-encoded.
   */
  private async classifyDownload(
    response: Response,
    host: string,
  ): Promise<{ error?: TeraboxError; response: Response }> {
    const status = response.status;
    const contentType = (response.headers.get('Content-Type') || '').toLowerCase();
    const lengthHeader = response.headers.get('Content-Length');
    const length = lengthHeader === null ? Number.NaN : Number(lengthHeader);
    const jsonish = contentType.includes('json');
    // Sniff JSON bodies (any size, up to the peek limit) plus small non-JSON
    // ones; never open a reader for a large or unbounded binary stream.
    const sniffable = jsonish || (Number.isFinite(length) && length <= DOWNLOAD_SNIFF_LIMIT);

    if (status >= 200 && status < 300) {
      if (!sniffable || !response.body) return { response };

      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      let overflow = false;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        total += value.byteLength;
        if (total > DOWNLOAD_SNIFF_LIMIT) {
          overflow = true;
          break;
        }
      }
      const buffered = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        buffered.set(chunk, offset);
        offset += chunk.byteLength;
      }

      if (overflow) {
        // Too big to be a gate: re-attach the peeked bytes to the live stream.
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(buffered);
          },
          async pull(controller) {
            const { done, value } = await reader.read();
            if (done) controller.close();
            else controller.enqueue(value);
          },
          cancel(reason) {
            return reader.cancel(reason);
          },
        });
        return { response: new Response(stream, { status, headers: response.headers }) };
      }

      const gate = errnoBodyFrom(new TextDecoder().decode(buffered));
      if (gate) {
        const error = this.downloadError(gate, host, status, `Terabox download error ${gate.errno}`);
        return { error, response };
      }
      // Legitimate small file (e.g. a real .json): re-wrap the original bytes.
      return { response: new Response(buffered, { status, headers: response.headers }) };
    }

    // Non-2xx: 403 WAF pages and gate JSON with an error status.
    if (status === 416) {
      // RFC 7233 unsatisfiable-range verdict: a valid answer to a Range
      // request, never a gate — hand it straight to the WebDAV layer.
      return { response };
    }
    const text = await response.text().catch(() => '');
    const gate = errnoBodyFrom(text);
    const errno = gate ? gate.errno : -5;
    const fallback = errno === -5 ? `Terabox download http error ${status}` : `Terabox download error ${errno}`;
    const error = this.downloadError({ errno, msg: gate?.msg ?? '' }, host, status, fallback);
    if (text && !gate) error.upstream = text.slice(0, 300);
    return { error, response };
  }

  private downloadError(
    body: { errno: number; msg: string },
    host: string,
    status: number,
    fallback: string,
  ): TeraboxError {
    const error = new TeraboxError(body.errno, this.errorMessage(body.errno, fallback));
    error.step = `dlink@${host}`;
    if (body.msg) error.upstream = body.msg;
    error.httpStatus = status;
    return error;
  }

  async quota(): Promise<{ total: number; used: number; free: number }> {
    const { json } = await this.request<{ errno?: number; total?: number; used?: number; free?: number }>(
      '/api/quota',
      { query: { checkexpire: '1', checkfree: '1' } },
    );
    return { total: json.total || 0, used: json.used || 0, free: json.free || 0 };
  }

  async recycle(): Promise<void> {
    await this.request<{ errno?: number }>('/api/recycle/clear', { method: 'POST', query: { async: '0' } });
  }

  // ---------------------------------------------------------------------------
  // filemanager operations (async aware)
  // ---------------------------------------------------------------------------

  async fileOperation<T extends { path?: string }>(
    opera: 'copy' | 'move' | 'rename' | 'delete',
    items: Array<OperationalItem & T>,
  ): Promise<void> {
    // copy is submitted async; move/rename/delete report a task id otherwise.
    await this.ensureJsToken();

    // Wire contract differs per opera (bclone apiOperation parity):
    //   delete: filelist ["/path"]        — a plain array of path strings;
    //          objects make the server NPE with an empty HTTP 500.
    //   move/rename/copy: [{"path":…,"dest":…,"newname":…}]
    const payload =
      opera === 'delete'
        ? items.map((item) => tbPath(String(item.path || '')))
        : items.map((item) => ({
            path: tbPath(String(item.path || '')),
            ...(item.dest !== undefined ? { dest: tbPath(item.dest) } : {}),
            ...(item.newname !== undefined ? { newname: item.newname } : {}),
            ...(item.ondup !== undefined ? { ondup: item.ondup } : {}),
          }));

    const jsonList = JSON.stringify(payload);
    const body = `filelist=${encodeURIComponent(jsonList)}`;

    const { json } = await this.request<{
      errno?: number;
      taskid?: number;
      info?: Array<{ errno?: number; path?: string }>;
    }>('/api/filemanager', {
      method: 'POST',
      // async=1 ("adaptive") for every opera — bclone parity. async=2 made
      // the server hand back a task id whose only query endpoint is
      // /share/taskquery, which answers nginx 404 for filemanager tasks; the
      // copy itself had already succeeded by then.
      query: { opera, async: '1', onnest: 'fail' },
      body,
      raw: true,
    });

    // Validate per-entry errors BEFORE accepting a task id: adaptive mode can
    // return taskid AND info[] together, and a failed copy/move/delete must
    // never be reported as success just because the task id is non-zero.
    const infos = json.info || [];
    for (const entry of infos) {
      if (entry.errno !== undefined && entry.errno !== 0) throw es(entry.errno);
    }

    if (json.taskid && json.taskid > 0) {
      // Adaptive mode may still report a task id for slow operations; the
      // result is observable on the next list (bclone reads info and moves
      // on). There is no filemanager task-query endpoint to poll.
      return;
    }

    if (infos.length === 0 && json.errno) throw es(json.errno);
  }

  // ---------------------------------------------------------------------------
  // upload (locate host -> precreate -> chunks -> create)
  // ---------------------------------------------------------------------------

  private async ensureUploadHosts(): Promise<string[]> {
    // A host that already accepted an upload in this session is listed first.
    if (this.uploadHost) return [this.uploadHost, ...(this.uploadHosts ?? [])];
    if (this.uploadHosts) return this.uploadHosts;
    // Account-scoped: reuse the isolate's cached candidate list so each
    // request doesn't re-walk up to 8 locateupload origins (CPU + latency).
    if (UPLOAD_HOSTS_CACHE.hosts && Date.now() - UPLOAD_HOSTS_CACHE.at < UPLOAD_HOSTS_TTL_MS) {
      this.uploadHosts = UPLOAD_HOSTS_CACHE.hosts;
      return this.uploadHosts;
    }
    // locateupload returns a *candidate list* (server[] plus a host fallback)
    // and the client walks it until a cluster accepts the upload. The origin
    // matters more than the IP: regional deployments host different clusters.
    // Live-verified 2026-10-09: the account behind dm.terabox.com lives on
    // dm1/dm2/kul-cdata.terabox.com, which d.terabox.com doesn't even know
    // (it answers the c-jp/c1-jp/c2-jp table → error_code 31045 "user not
    // exists" on every one).
    // Origin priority: the configured base origin (authoritative, but gated
    // from datacenter IPs), then the deployment's own data gateways
    // (<label>-d / <label>-data, bare GETs work from anywhere — the same
    // pattern as jp-data for the www deployment), then d.terabox.com (www's
    // gateway → JP table), then <prefix>-data.
    const label = new URL(this.baseUrl).hostname.split('.')[0] ?? '';
    const deploymentGateways =
      label && label !== 'www'
        ? [`https://${label}-d.terabox.com`, `https://${label}-data.terabox.com`]
        : [];
    const origins = [
      this.baseUrl,
      ...deploymentGateways,
      'https://d.terabox.com',
      `https://${this.domainPrefix}-data.terabox.com`,
    ];
    let lastError: unknown;
    for (const origin of origins) {
      // Browser parity: the XHR runs withCredentials (session Cookie) with
      // only its own query; fall back to a bare GET for origins that gate
      // sessioned callers from datacenter IPs.
      for (const session of [true, false]) {
        try {
          const { json } = await this.request<{ errno?: number; server?: string[]; host?: string }>(
            '/rest/2.0/pcs/file?method=locateupload',
            {
              absoluteUrl: `${origin}/rest/2.0/pcs/file?method=locateupload`,
              ...(session ? { skipCommonParams: true } : { bare: true }),
            },
          );
          const candidates = [
            ...(Array.isArray(json.server) ? json.server : []),
            ...(json.host ? [json.host] : []),
          ].filter((host, index, all) => Boolean(host) && all.indexOf(host) === index);
          if (!candidates.length) throw es(-5);
          this.uploadHosts = candidates;
          UPLOAD_HOSTS_CACHE.hosts = candidates;
          UPLOAD_HOSTS_CACHE.at = Date.now();
          return candidates;
        } catch (error) {
          lastError = error;
        }
      }
    }
    // Every candidate origin failed: the cached list (if any) is bad, so drop
    // it or every later upload re-fails identically until the isolate recycles.
    UPLOAD_HOSTS_CACHE.hosts = null;
    throw lastError instanceof Error ? lastError : es(-5);
  }

  private async checkPremium(): Promise<void> {
    if (this.premiumChecked) return;
    this.premiumChecked = true;
    // Account-scoped, not request-scoped: reuse the isolate's cached answer
    // so every WebDAV request doesn't re-spend CPU on the membership probe.
    if (PREMIUM_CACHE.checked) {
      this.isPremium = PREMIUM_CACHE.isPremium;
      return;
    }
    try {
      const { json } = await this.request<{
        errno?: number;
        data?: { member_info?: { is_vip?: number } };
      }>('/rest/2.0/membership/proxy/user', { query: { method: 'query', membership_version: '1.0' } });
      this.isPremium = (json.data?.member_info?.is_vip || 0) > 0;
      PREMIUM_CACHE.checked = true;
      PREMIUM_CACHE.isPremium = this.isPremium;
    } catch {
      // bclone discards this probe's error too (`_ = f.apiCheckPremium(ctx)`):
      // a failed premium check must not block uploads — fall back to
      // free-tier limits (4 MiB chunks, 4 GiB file cap) for THIS request.
      // Deliberately NOT cached: a transient 429/gate would otherwise pin
      // the isolate to free-tier limits for its whole lifetime, turning
      // every >4 GiB upload into a 507 for a VIP account.
      this.isPremium = false;
    }
  }

  private async precreate(
    absPath: string,
    size: number,
    mtimeMs: number,
  ): Promise<{ uploadId: string; returnType: number; uploadSign: string }> {
    const chunkSize = getChunkSize(size, this.isPremium, this.maxChunkBytes);
    const dir = splitPath(absPath).dir;
    const { json } = await this.request<{
      errno?: number;
      uploadid?: string;
      return_type?: number;
      uploadsign?: string | number;
    }>('/api/precreate', {
      method: 'POST',
      form: {
        path: tbPath(absPath),
        autoinit: '1',
        local_mtime: String(Math.floor(mtimeMs / 1000)),
        file_limit_switch_v34: 'true',
        size: String(size),
        target_path: dir,
        block_list: placeholderBlockList(size, chunkSize),
      },
    });
    // The web client forwards precreate's uploadsign to superfile2 and
    // create (e.uploadSign = o.uploadsign) — never hardcodes 0.
    return {
      uploadId: json.uploadid || '',
      returnType: json.return_type || 0,
      uploadSign: String(json.uploadsign ?? 0),
    };
  }

  private async uploadChunk(
    host: string,
    absPath: string,
    uploadId: string,
    uploadSign: string,
    partSeq: number,
    data: Uint8Array,
  ): Promise<string> {
    const fileName = splitPath(absPath).base || 'blob';
    // Hand-built multipart as ONE Uint8Array instead of FormData. FormData
    // costs TWO extra copies of the chunk (Blob construction + runtime
    // multipart assembly); building the envelope manually costs one, which
    // keeps a 4 MiB chunk PUT inside the Free plan's 10 ms CPU budget
    // (Cloudflare 1102 under GC pressure). A single buffer also carries a
    // known Content-Length — Terabox's origin 524s on chunked-transfer
    // multipart with no length header.
    // Random boundary: a guessable one lets crafted file *content* contain
    // it and split the part early (self-harm only, but free to prevent).
    const boundary = `----teraboxBoundary${crypto.randomUUID()}`;
    const encoder = new TextEncoder();
    // CR/LF/NUL in a decoded filename would terminate the part headers and
    // inject the rest of the name into the body — corrupting the upload
    // while the control-md5 check still passes (it hashes what we sent).
    const safeName = fileName.replace(/[\u0000-\u001f\u007f"\\]/g, '') || 'blob';
    const head = encoder.encode(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="${safeName}"\r\n` +
        `Content-Type: application/octet-stream\r\n\r\n`,
    );
    const tail = encoder.encode(`\r\n--${boundary}--\r\n`);
    const multipart = new Uint8Array(head.length + data.length + tail.length);
    multipart.set(head, 0);
    multipart.set(data, head.length);
    multipart.set(tail, head.length + data.length);
    // Identity on the PCS cluster comes from the session Cookie. Neither
    // working client (Alist, TeraboxUploaderCLI) sends jsToken here — the
    // superfile2 call failed with error_code 31045 "user not exists" while
    // ours did. Send the union of their proven parameters instead: web/type
    // flags (Alist / CLI) plus browser Origin, Referer and User-Agent (CLI).
    const { json } = await this.request<{ errno?: number; md5?: string }>(
      `/rest/2.0/pcs/superfile2`,
      {
        method: 'POST',
        absoluteUrl: `https://${host}/rest/2.0/pcs/superfile2`,
        skipCommonParams: true, // no jsToken; the common params are listed below
        query: {
          // Exact web-client superfile2 query (_setServerUrl + _compileUrl in
          // chunk-78587962): no jsToken, no type param — identity comes from
          // the session Cookie alone.
          method: 'upload',
          web: '1',
          app_id: APP_ID,
          channel: CHANNEL,
          clienttype: '0',
          path: tbPath(absPath),
          uploadid: uploadId,
          uploadsign: uploadSign,
          partseq: String(partSeq),
        },
        headers: {
          Origin: this.baseUrl,
          Referer: `${this.baseUrl}/main?category=all`,
          'User-Agent': WEB_USER_AGENT,
        },
        body: multipart,
        contentType: `multipart/form-data; boundary=${boundary}`,
        skipErrorRetry: true,
      },
    );
    return json.md5 || '';
  }

  private async createFile(
    absPath: string,
    uploadId: string,
    uploadSign: string,
    size: number,
    mtimeMs: number,
    blockList: string[],
    overwriteMode: number,
  ): Promise<string> {
    const dir = splitPath(absPath).dir;
    const rtype = overwriteMode > 3 ? 1 : overwriteMode;
    const { json } = await this.request<{ errno?: number; md5?: string }>('/api/create', {
      method: 'POST',
      query: { isdir: '0', rtype: String(rtype) },
      form: {
        path: tbPath(absPath),
        local_mtime: String(Math.floor(mtimeMs / 1000)),
        uploadid: uploadId,
        uploadsign: uploadSign,
        size: String(size),
        target_path: dir,
        block_list: JSON.stringify(blockList),
      },
    });
    return json.md5 || '';
  }

  /**
   * Upload a file (ported from apiFileUpload). Runs sequentially so each chunk
   * stays a small, retryable subrequest and respects Terabox rate limits.
   */
  async upload(absPath: string, size: number, mtimeMs: number, bytes: Uint8Array, overwriteMode = 0): Promise<void> {
    await this.checkPremium();
    const limit = this.isPremium ? MAX_PREMIUM_FILE_BYTES : MAX_FREE_FILE_BYTES;
    if (size > limit) throw es(58);

    await atStep('jsToken', () => this.ensureJsToken());
    const hosts = await atStep('locateupload', () => this.ensureUploadHosts());

    const { uploadId, returnType, uploadSign } = await atStep('precreate', () =>
      this.precreate(absPath, size, mtimeMs),
    );
    if (returnType === 2) throw es(-8);

    const chunkSize = getChunkSize(size, this.isPremium, this.maxChunkBytes);
    // Views, not copies: subarray windows share the single arrayBuffer so the
    // file is held once. Chunk md5s come from the server (below) — no local
    // hashing, which is what used to blow the Workers 10 ms CPU budget.
    const chunkCount = size === 0 ? 1 : Math.ceil(bytes.byteLength / chunkSize);
    const windowAt = (index: number): Uint8Array =>
      size === 0
        ? new Uint8Array(0)
        : bytes.subarray(index * chunkSize, Math.min((index + 1) * chunkSize, bytes.byteLength));

    // The browser walks locateupload's candidate server list until one
    // accepts the upload (wrong-cluster hosts answer HTTP 403
    // error_code 31045 "user not exists"). Mirror that: retry the chunk
    // sequence on the next candidate; lock onto the first host that works.
    // superfile2 returns the md5 of each chunk it received, so we collect
    // those instead of re-hashing locally (identical value, zero CPU).
    const chunkMd5s: string[] = [];
    let uploaded = false;
    let lastHostError: TeraboxError | undefined;
    for (let hostIndex = 0; hostIndex < hosts.length; hostIndex += 1) {
      const host = hosts[hostIndex]!;
      try {
        chunkMd5s.length = 0;
        for (let index = 0; index < chunkCount; index += 1) {
          const uploadedMd5 = await atStep(`chunk${index}@${host}`, () =>
            this.uploadChunk(host, absPath, uploadId, uploadSign, index, windowAt(index)),
          );
          if (!uploadedMd5) {
            throw new TeraboxError(-5, `Uploaded chunk ${index} returned no md5`);
          }
          chunkMd5s.push(uploadedMd5);
        }
        this.uploadHost = host;
        uploaded = true;
        break;
      } catch (error) {
        const isLastHost = hostIndex === hosts.length - 1;
        // Same rule as the resumable ladder: anything thrown inside the
        // per-host try IS that host's answer (chunk uploads only), whether
        // or not it carries an HTTP status — a200-with-error-body must not
        // abort the failover.
        if (error instanceof TeraboxError && !isLastHost) {
          lastHostError = error;
          continue;
        }
        throw error;
      }
    }
    if (!uploaded) throw lastHostError ?? es(-5);

    const createdMd5 = await atStep('create', () =>
      this.createFile(absPath, uploadId, uploadSign, size, mtimeMs, chunkMd5s, overwriteMode),
    );

    // Single-chunk control md5 IS the chunk md5 the server returned; the
    // multi-chunk form hashes only the tiny JSON array of digests (a few
    // hundred bytes) — negligible CPU either way.
    const controlMd5 =
      chunkMd5s.length === 1 ? chunkMd5s[0]! : await md5Hex(new TextEncoder().encode(JSON.stringify(chunkMd5s)));
    if (decodeMD5(createdMd5) !== controlMd5) {
      const integrity = new TeraboxError(-5, 'Server file md5 does not match uploaded chunks');
      integrity.integrity = true;
      throw integrity;
    }
  }

  /**
   * Streaming variant of {@link upload} for bodies whose total size is known
   * but which must never be buffered whole (Cloudflare's edge delivers up to
   * ~100 MB — larger than half the isolate). Runs the identical precreate →
   * superfile2 → create pipeline, the same host failover (the current window
   * is held until its md5 returns, so a switch retries the same bytes), and
   * the same control-md5 integrity check. A body that ends before `size`
   * throws -9 and never runs create, so a truncated client cannot publish a
   * partial file.
   */
  async uploadStream(
    absPath: string,
    size: number,
    mtimeMs: number,
    body: ReadableStream<Uint8Array>,
    overwriteMode = 0,
  ): Promise<void> {
    await this.checkPremium();
    const limit = this.isPremium ? MAX_PREMIUM_FILE_BYTES : MAX_FREE_FILE_BYTES;
    if (size > limit) throw es(58);
    await atStep('jsToken', () => this.ensureJsToken());
    const hosts = await atStep('locateupload', () => this.ensureUploadHosts());

    const { uploadId, returnType, uploadSign } = await atStep('precreate', () =>
      this.precreate(absPath, size, mtimeMs),
    );
    if (returnType === 2) throw es(-8);

    const chunkSize = getChunkSize(size, this.isPremium, this.maxChunkBytes);
    const chunkCount = size === 0 ? 1 : Math.ceil(size / chunkSize);
    const chunkMd5s: string[] = [];
    let hostIndex = 0;
    let host = hosts[0]!;
    const windows = streamWindows(body, size, chunkSize);
    try {
      for (let index = 0; index < chunkCount; index += 1) {
        const window = await windows.next();
        if (window === null) throw new TeraboxError(-9, 'Request body ended before Content-Length');
        for (;;) {
          try {
            const uploadedMd5 = await atStep(`chunk${index}@${host}`, () =>
              this.uploadChunk(host, absPath, uploadId, uploadSign, index, window),
            );
            if (!uploadedMd5) throw new TeraboxError(-5, `Uploaded chunk ${index} returned no md5`);
            chunkMd5s.push(uploadedMd5);
            break;
          } catch (error) {
            // Anything thrown inside this try is the host's answer, whether
            // or not it carries an HTTP status — same rule as upload()'s
            // ladder; the window above is still in hand for the retry.
            if (error instanceof TeraboxError && hostIndex < hosts.length - 1) {
              hostIndex += 1;
              host = hosts[hostIndex]!;
              continue;
            }
            throw error;
          }
        }
      }
    } finally {
      await windows.cancel();
    }

    const createdMd5 = await atStep('create', () =>
      this.createFile(absPath, uploadId, uploadSign, size, mtimeMs, chunkMd5s, overwriteMode),
    );
    const controlMd5 =
      chunkMd5s.length === 1 ? chunkMd5s[0]! : await md5Hex(new TextEncoder().encode(JSON.stringify(chunkMd5s)));
    if (decodeMD5(createdMd5) !== controlMd5) {
      const integrity = new TeraboxError(-5, 'Server file md5 does not match uploaded chunks');
      integrity.integrity = true;
      throw integrity;
    }
  }

  // ---------------------------------------------------------------------------
  // resumable upload (exposes Terabox's native multipart across many small
  // HTTP requests, so a single body never exceeds Cloudflare's ~100 MB cap)
  // ---------------------------------------------------------------------------

  /**
   * Step 1 of a resumable upload: run precreate and return the upload
   * coordinates. The caller stores these (in the Durable Object) and feeds
   * them back to {@link uploadResumableChunk} / {@link finalizeResumable}.
   */
  async beginResumable(
    absPath: string,
    size: number,
    mtimeMs: number,
  ): Promise<{ uploadId: string; uploadSign: string; chunkSize: number; chunkCount: number; hosts: string[] }> {
    await this.checkPremium();
    const limit = this.isPremium ? MAX_PREMIUM_FILE_BYTES : MAX_FREE_FILE_BYTES;
    if (size > limit) throw es(58);
    await atStep('jsToken', () => this.ensureJsToken());
    const hosts = await atStep('locateupload', () => this.ensureUploadHosts());
    const { uploadId, returnType, uploadSign } = await atStep('precreate', () =>
      this.precreate(absPath, size, mtimeMs),
    );
    if (returnType === 2) throw es(-8);
    // An empty uploadid would store a session under `""`; the chunk route
    // requires a non-empty id, so every follow-up would 404 with no clue why.
    if (!uploadId) throw new TeraboxError(-5, 'precreate returned no uploadid');
    const chunkSize = getChunkSize(size, this.isPremium, this.maxChunkBytes);
    const chunkCount = size === 0 ? 1 : Math.ceil(size / chunkSize);
    return { uploadId, uploadSign, chunkSize, chunkCount, hosts };
  }

  /**
   * Step 2 of a resumable upload: send one chunk to the upload cluster and
   * return the md5 Terabox computed for it (never re-hash locally).
   */
  async uploadResumableChunk(
    host: string,
    absPath: string,
    uploadId: string,
    uploadSign: string,
    partSeq: number,
    data: Uint8Array,
  ): Promise<string> {
    const md5 = await atStep(`chunk${partSeq}@${host}`, () =>
      this.uploadChunk(host, absPath, uploadId, uploadSign, partSeq, data),
    );
    if (!md5) throw new TeraboxError(-5, `Uploaded chunk ${partSeq} returned no md5`);
    return md5;
  }

  /**
   * Step 3 of a resumable upload: run create with the collected chunk md5s
   * and verify the control md5. The caller must have stored every chunk's
   * md5 from {@link uploadResumableChunk}.
   */
  async finalizeResumable(
    absPath: string,
    uploadId: string,
    uploadSign: string,
    size: number,
    mtimeMs: number,
    chunkMd5s: string[],
    overwriteMode = 0,
  ): Promise<void> {
    const createdMd5 = await atStep('create', () =>
      this.createFile(absPath, uploadId, uploadSign, size, mtimeMs, chunkMd5s, overwriteMode),
    );
    const controlMd5 =
      chunkMd5s.length === 1 ? chunkMd5s[0]! : await md5Hex(new TextEncoder().encode(JSON.stringify(chunkMd5s)));
    if (decodeMD5(createdMd5) !== controlMd5) {
      const integrity = new TeraboxError(-5, 'Server file md5 does not match uploaded chunks');
      integrity.integrity = true;
      throw integrity;
    }
  }

  // ---------------------------------------------------------------------------
  // download
  // ---------------------------------------------------------------------------

  /** Resolve a direct, streamable URL for an absolute file path. */
  async getDownloadUrl(absPath: string, fileId: string): Promise<string> {
    const item = await this.itemInfo(absPath, true);
    if (item.dlink) return item.dlink;
    const url = await this.downloadLink(fileId);
    if (!url) throw es(-9);
    return url;
  }

  /** Get a signed redirect URL for a file id (mirror of rclone Open()). */
  async downloadUrlFromId(fileId: string): Promise<string> {
    return this.downloadLink(fileId);
  }
}

export interface OperationalItem {
  path: string;
  dest?: string;
  newname?: string;
  ondup?: string;
}