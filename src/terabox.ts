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

  /** Referer/Cookie pair for streaming Terabox download links. */
  baseUrlForDownload(): string {
    return this.baseUrl;
  }

  cookieForDownload(): string {
    return this.cookie;
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
    for (let page = 1; ; page++) {
      const { json } = await this.request<{ errno?: number; list?: TeraboxItem[] }>('/api/list', {
        query: { dir: absDir, page: String(page), num: String(pageSize) },
      });
      const batch = json.list || [];
      items.push(...batch);
      if (batch.length === 0 || batch.length < pageSize) break;
      if (batch.length >= pageSize && page >= 100) break;
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

    const payload = items.map((item) => ({
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
      query: { opera, async: opera === 'copy' ? '2' : '1', onnest: 'fail' },
      body,
      raw: true,
    });

    if (json.taskid && json.taskid > 0) {
      await this.pollTask(json.taskid);
      return;
    }

    const infos = json.info || [];
    for (const entry of infos) {
      if (entry.errno !== undefined && entry.errno !== 0) throw es(entry.errno);
    }
    if (infos.length === 0 && json.errno) throw es(json.errno);
    // -8 (already exists) may legitimately occur for non-task responses.
  }

  private async pollTask(taskId: number): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const { json } = await this.request<{
        errno?: number;
        status?: string;
        list?: Array<{ errno?: number }>;
      }>('/share/taskquery', { query: { taskid: String(taskId) } });

      if (json.status === 'running') {
        await this.sleep(attempt * 1000);
        continue;
      }
      for (const entry of json.list || []) {
        if (entry.errno !== undefined && entry.errno !== 0) throw es(entry.errno);
      }
      return;
    }
    throw es(-5);
  }

  // ---------------------------------------------------------------------------
  // upload (locate host -> precreate -> chunks -> create)
  // ---------------------------------------------------------------------------

  private async ensureUploadHosts(): Promise<string[]> {
    // A host that already accepted an upload in this session is listed first.
    if (this.uploadHost) return [this.uploadHost, ...(this.uploadHosts ?? [])];
    if (this.uploadHosts) return this.uploadHosts;
    // The web client asks d.terabox.com (bare GET, withCredentials) and gets
    // a *candidate list* back: server[] plus a host fallback — it probes each
    // until one accepts the upload (clusters like c-jp/c1-jp/c2-jp can answer
    // error_code 31045 "user not exists" for the same account). The
    // <prefix>-data.terabox.com origin serves the same endpoint and is kept
    // as a fallback (works from datacenter IPs; the www origin answers
    // 400141 "need verify"). (Official API instead gets upload_domain from
    // /oauth/tokeninfo — docs/terabox-openapi.md.)
    const origins = ['https://d.terabox.com', `https://${this.domainPrefix}-data.terabox.com`];
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

  private async precreate(absPath: string, size: number, mtimeMs: number): Promise<{ uploadId: string; returnType: number }> {
    const chunkSize = getChunkSize(size, this.isPremium);
    const dir = splitPath(absPath).dir;
    const { json } = await this.request<{ errno?: number; uploadid?: string; return_type?: number }>(
      '/api/precreate',
      {
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
      },
    );
    return { uploadId: json.uploadid || '', returnType: json.return_type || 0 };
  }

  private async uploadChunk(
    host: string,
    absPath: string,
    uploadId: string,
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
          partseq: String(partSeq),
          uploadsign: '0',
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

    const { uploadId, returnType } = await atStep('precreate', () =>
      this.precreate(absPath, size, mtimeMs),
    );
    if (returnType === 2) throw es(-8);

    const chunkSize = getChunkSize(size, this.isPremium);
    const chunks: Array<{ partSeq: number; md5: string; data: Uint8Array }> = [];

    if (size === 0) {
      chunks.push({ partSeq: 0, md5: await md5Hex(new Uint8Array(0)), data: new Uint8Array(0) });
    } else {
      for (let offset = 0, partSeq = 0; offset < bytes.byteLength; offset += chunkSize, partSeq += 1) {
        const data = bytes.slice(offset, Math.min(offset + chunkSize, bytes.byteLength));
        chunks.push({ partSeq, md5: await md5Hex(data), data });
      }
    }

    const chunkMd5s = chunks.map((chunk) => chunk.md5);
    // The browser walks locateupload's candidate server list until one
    // accepts the upload (wrong-cluster hosts answer HTTP 403
    // error_code 31045 "user not exists"). Mirror that: retry the chunk
    // sequence on the next candidate; lock onto the first host that works.
    let uploaded = false;
    let lastHostError: TeraboxError | undefined;
    for (let hostIndex = 0; hostIndex < hosts.length; hostIndex += 1) {
      const host = hosts[hostIndex]!;
      try {
        for (const chunk of chunks) {
          const uploadedMd5 = await atStep(`chunk${chunk.partSeq}@${host}`, () =>
            this.uploadChunk(host, absPath, uploadId, chunk.partSeq, chunk.data),
          );
          if (uploadedMd5 !== chunk.md5) {
            throw new TeraboxError(-5, `Uploaded chunk ${chunk.partSeq} md5 mismatch`);
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
      this.createFile(absPath, uploadId, size, mtimeMs, chunkMd5s, overwriteMode),
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