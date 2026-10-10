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
/** Shared pacing state per isolate: slots are assigned in order so even
 *  concurrent WebDAV requests cannot burst the upstream. */
let nextUpstreamSlot = 0;
/** Reused jsToken across WebDAV requests — the root fetch is the call most
 *  exposed to Terabox's verification gate, so mint at most once per TTL. */
const JS_TOKEN_CACHE = { token: '', at: 0 };
const JS_TOKEN_TTL_MS = 5 * 60_000;
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
  body?: string;
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

  constructor(cookie: string, domain = DEFAULT_BASE_URL, opts: { jsToken?: string; minGapMs?: number } = {}) {
    this.cookie = valuedCookie(cookie);
    this.baseUrl = /^https?:\/\//.test(domain) ? domain : 'https://' + domain;
    this.configuredJsToken = (opts.jsToken || '').trim();
    this.minGapMs = typeof opts.minGapMs === 'number' && opts.minGapMs >= 0 ? opts.minGapMs : DEFAULT_MIN_GAP_MS;
  }

  /**
   * Reserve the next upstream slot and sleep until it (rate-limit guard).
   * Every outbound Terabox call — API, jsToken mint, download stream — passes
   * through here so the account never bursts past bclone's pacing.
   */
  async pace(): Promise<void> {
    const slot = Math.max(Date.now(), nextUpstreamSlot + this.minGapMs);
    nextUpstreamSlot = slot;
    const wait = slot - Date.now();
    if (wait > 0) await this.sleep(wait);
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
      response = await fetch(url.toString(), { method: opts.method || 'GET', headers, body });
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
      return this.request<T>(path, opts, attempt + 1, jsTokenTried);
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
        // Refresh jsToken exactly once, then retry the request.
        if (JS_TOKEN_ERRORS.has(errno) && !jsTokenTried) {
          await this.ensureJsToken(true);
          return this.request<T>(path, opts, attempt, true);
        }

        // Some accounts are served from a mirrored host; re-root and retry once.
        const prefix = response.headers.get('Url-Domain-Prefix');
        if (prefix && errno === -6) {
          const host = new URL(this.baseUrl).hostname.split('.');
          const sld = host.length >= 2 ? host[host.length - 2] : 'terabox';
          const tld = host.length >= 2 ? host[host.length - 1]! : 'com';
          this.baseUrl = `https://${prefix}.${sld}.${tld}`;
          return this.request<T>(path, opts, attempt, jsTokenTried);
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
    // A pre-minted token (env JSTOKEN — the same window.jsToken Alist and
    // TeraboxUploaderCLI ask their users to paste) skips minting entirely;
    // only an API rejection (force) triggers a fresh mint.
    if (this.configuredJsToken && !force) {
      this.jsToken = this.configuredJsToken;
      return;
    }
    // Reuse the last minted token: the root fetch is the call most exposed
    // to Terabox's verification gate, so don't repeat it per WebDAV request.
    if (!force && JS_TOKEN_CACHE.token && Date.now() - JS_TOKEN_CACHE.at < JS_TOKEN_TTL_MS) {
      this.jsToken = JS_TOKEN_CACHE.token;
      return;
    }
    // The session Cookie must be sent: a token minted for an anonymous request
    // (192 hex chars) is rejected by precreate/create with 4000023/400141
    // "need verify". Only a token bound to the account (128 hex chars) works.
    const pages = [`${this.baseUrl}/`, `${this.baseUrl}/main?category=all`];
    const outcome: string[] = [];
    for (const page of pages) {
      const { response, html } = await this.fetchMintPage(page);
      const token = jsTokenFromHtml(html);
      const landed = (response.url || page).replace(this.baseUrl, '') || '/';
      outcome.push(`${landed}=${token ? 'token' : 'none'}`);
      if (token) {
        this.jsToken = token;
        JS_TOKEN_CACHE.token = token;
        JS_TOKEN_CACHE.at = Date.now();
        return;
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
    const response = await fetch(url, {
      headers: {
        ...(withCookie ? { Cookie: this.cookie, Referer: this.baseUrl } : {}),
        'User-Agent': DESKTOP_APP_USER_AGENT,
      },
      redirect: 'follow',
    });
    return { response, html: await response.text() };
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
    const { json } = await this.request<{ errno?: number; dlink?: Array<{ fs_id: string; dlink?: string }> }>(
      '/api/download',
      {
        query: {
          type: 'dlink',
          vip: '2',
          sign: sign(home.sign3, home.sign1),
          timestamp: String(Math.floor(Date.now() / 1000)),
          need_speed: '1',
          fidlist: JSON.stringify([Number(fileId)]),
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
   */
  async fetchDownload(url: string, range?: string | null): Promise<Response> {
    // Follow the browser: fetch the rewritten main-origin URL, not the gated
    // <prefix>-d data-gateway host the raw dlink points at.
    url = browserDlinkUrl(url, new URL(this.baseUrl).hostname);
    let lastError: TeraboxError | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      let target = url;
      if (attempt > 0) {
        await this.ensureJsToken(true); // fresh account-bound token for the retry
        if (this.jsToken) {
          const withToken = new URL(url);
          withToken.searchParams.set('jsToken', this.jsToken);
          target = withToken.toString();
        }
      }
      const headers: Record<string, string> = {
        Referer: this.baseUrl,
        Cookie: this.cookie,
        'User-Agent': WEB_USER_AGENT,
        Accept: '*/*',
        'Accept-Language': 'en-US,en;q=0.9',
      };
      if (range) headers['Range'] = range;

      await this.pace(); // rate-limit guard before the download stream too
      let response: Response;
      let finalUrl = target;
      try {
        response = await fetch(target, { headers, redirect: 'manual' });
        // Follow the CDN hop ourselves: the redirect target is a capability
        // URL that serves bytes with no session, so only the UA (and Range)
        // cross the hop.
        for (let hop = 0; response.status >= 300 && response.status < 400 && hop < 4; hop++) {
          const location = response.headers.get('Location');
          if (!location) break;
          finalUrl = new URL(location, finalUrl).toString();
          await this.pace();
          const hopHeaders: Record<string, string> = { 'User-Agent': WEB_USER_AGENT, Accept: '*/*' };
          if (range) hopHeaders['Range'] = range;
          response = await fetch(finalUrl, { headers: hopHeaders, redirect: 'manual' });
        }
      } catch (error) {
        throw new TeraboxError(
          -5,
          `Terabox download network error: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      const host = downloadHost(finalUrl, target);
      const verdict = await this.classifyDownload(response, host);
      if (!verdict.error) return verdict.response;
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

    if (json.taskid && json.taskid > 0) {
      // Adaptive mode may still report a task id for slow operations; the
      // result is observable on the next list (bclone reads info and moves
      // on). There is no filemanager task-query endpoint to poll.
      return;
    }

    const infos = json.info || [];
    for (const entry of infos) {
      if (entry.errno !== undefined && entry.errno !== 0) throw es(entry.errno);
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
          return candidates;
        } catch (error) {
          lastError = error;
        }
      }
    }
    throw lastError instanceof Error ? lastError : es(-5);
  }

  private async checkPremium(): Promise<void> {
    if (this.premiumChecked) return;
    this.premiumChecked = true;
    try {
      const { json } = await this.request<{
        errno?: number;
        data?: { member_info?: { is_vip?: number } };
      }>('/rest/2.0/membership/proxy/user', { query: { method: 'query', membership_version: '1.0' } });
      this.isPremium = (json.data?.member_info?.is_vip || 0) > 0;
    } catch {
      // bclone discards this probe's error too (`_ = f.apiCheckPremium(ctx)`):
      // a failed premium check must not block uploads — fall back to
      // free-tier limits (4 MiB chunks, 4 GiB file cap) until proven VIP.
    }
  }

  private async precreate(
    absPath: string,
    size: number,
    mtimeMs: number,
  ): Promise<{ uploadId: string; returnType: number; uploadSign: string }> {
    const chunkSize = getChunkSize(size, this.isPremium);
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
    const form = new FormData();
    const fileName = splitPath(absPath).base || 'blob';
    form.set('file', new Blob([data as unknown as BufferSource], { type: 'application/octet-stream' }), fileName);
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
        form,
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

    const chunkSize = getChunkSize(size, this.isPremium);
    // Views, not copies: the previous implementation pre-built a `chunks`
    // array of `bytes.slice(...)` windows — a full second copy of the file
    // held for the whole upload (peak ~3× body with the Blob copies), which
    // OOMs the isolate near the Workers request-body ceiling. Subarray views
    // share the single arrayBuffer; md5s are computed per window and only
    // the digest strings are retained. (True streaming would additionally
    // drop the 1× body itself, but forfeits the transparent host-failover
    // replay below — the body is single-use once consumed.)
    const chunkCount = size === 0 ? 1 : Math.ceil(bytes.byteLength / chunkSize);
    const chunkMd5s: string[] = [];
    const windowAt = (index: number): Uint8Array =>
      size === 0
        ? new Uint8Array(0)
        : bytes.subarray(index * chunkSize, Math.min((index + 1) * chunkSize, bytes.byteLength));
    for (let index = 0; index < chunkCount; index += 1) {
      chunkMd5s.push(await md5Hex(windowAt(index)));
    }

    // The browser walks locateupload's candidate server list until one
    // accepts the upload (wrong-cluster hosts answer HTTP 403
    // error_code 31045 "user not exists"). Mirror that: retry the chunk
    // sequence on the next candidate; lock onto the first host that works.
    let uploaded = false;
    let lastHostError: TeraboxError | undefined;
    for (let hostIndex = 0; hostIndex < hosts.length; hostIndex += 1) {
      const host = hosts[hostIndex]!;
      try {
        for (let index = 0; index < chunkCount; index += 1) {
          const uploadedMd5 = await atStep(`chunk${index}@${host}`, () =>
            this.uploadChunk(host, absPath, uploadId, uploadSign, index, windowAt(index)),
          );
          if (uploadedMd5 !== chunkMd5s[index]) {
            throw new TeraboxError(-5, `Uploaded chunk ${index} md5 mismatch`);
          }
        }
        this.uploadHost = host;
        uploaded = true;
        break;
      } catch (error) {
        const isLastHost = hostIndex === hosts.length - 1;
        if (error instanceof TeraboxError && error.httpStatus !== undefined && !isLastHost) {
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

    const controlMd5 =
      chunkMd5s.length === 1 ? chunkMd5s[0]! : await md5Hex(new TextEncoder().encode(JSON.stringify(chunkMd5s)));
    if (decodeMD5(createdMd5) !== controlMd5) {
      throw new TeraboxError(-5, 'Server file md5 does not match uploaded chunks');
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