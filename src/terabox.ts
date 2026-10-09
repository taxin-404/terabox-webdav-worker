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

const RETRY_STATUS = new Set([429, 500, 502, 503, 504, 509]);
const JS_TOKEN_ERRORS = new Set([4000023, 400141, 450016]);

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
  constructor(
    public readonly errno: number,
    message: string,
  ) {
    super(message);
    this.name = 'TeraboxError';
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
  /** The response is not an ErrorAPI shape (chunk upload); skip errno handling. */
  skipErrorRetry?: boolean;
  /** Return the JSON even when the top-level errno is non-zero, so the caller
   *  can read the authoritative per-item `info[].errno` (filemetas returns
   *  top-level 12 alongside info[].errno -9 for missing paths). */
  raw?: boolean;
  /** Absolute URL override (chunk upload host). */
  absoluteUrl?: string;
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
  private isPremium = false;
  private premiumChecked = false;

  constructor(cookie: string, domain = DEFAULT_BASE_URL) {
    this.cookie = valuedCookie(cookie);
    this.baseUrl = /^https?:\/\//.test(domain) ? domain : 'https://' + domain;
  }

  /** Referer/Cookie pair for streaming Terabox download links. */
  baseUrlForDownload(): string {
    return this.baseUrl;
  }

  cookieForDownload(): string {
    return this.cookie;
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

    if (!opts.skipCommonParams) {
      url.searchParams.set('app_id', APP_ID);
      url.searchParams.set('channel', CHANNEL);
      url.searchParams.set('clienttype', '0');
      if (this.jsToken) url.searchParams.set('jsToken', this.jsToken);
    }
    for (const [key, value] of Object.entries(opts.query || {})) {
      url.searchParams.set(key, value);
    }

    const headers: Record<string, string> = {
      Accept: 'application/json, text/plain, */*',
      Referer: this.baseUrl,
      'X-Requested-With': 'XMLHttpRequest',
      Cookie: this.cookie,
    };
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
      response = await fetch(url.toString(), { method: opts.method || 'GET', headers, body });
    } catch (error) {
      throw new TeraboxError(-5, `Terabox network error: ${error instanceof Error ? error.message : String(error)}`);
    }

    if (RETRY_STATUS.has(response.status) && attempt < 3) {
      await this.sleep(attempt * 1000);
      return this.request<T>(path, opts, attempt + 1, jsTokenTried);
    }
    if (response.status < 200 || response.status > 299) {
      throw new TeraboxError(-5, `Terabox http error ${response.status}`);
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
        throw new TeraboxError(errno, message);
      }
    }

    return { json: json as T, headers: response.headers, status: response.status };
  }

  private async ensureJsToken(force = false): Promise<void> {
    if (this.jsToken && !force) return;
    // The session Cookie must be sent: a token minted for an anonymous request
    // (192 hex chars) is rejected by precreate/create with 4000023/400141
    // "need verify". Only a token bound to the account (128 hex chars) works.
    const response = await fetch(this.baseUrl + '/', {
      headers: {
        Cookie: this.cookie,
        Referer: this.baseUrl,
        'User-Agent': 'terabox;1.37.0.7;PC;PC-Windows;10.0.22631;WindowsTeraBox',
      },
      redirect: 'follow',
    });
    const html = await response.text();
    const token = jsTokenFromHtml(html);
    if (!token) {
      // Terabox answers the root with a 302 to /simple-verify when the IP or
      // session is rate-limited; that page has no jsToken.
      throw new TeraboxError(400141, 'jsToken unavailable (Terabox verification required)');
    }
    this.jsToken = token;
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

  private async ensureUploadHost(): Promise<string> {
    if (this.uploadHost) return this.uploadHost;
    const { json } = await this.request<{ errno?: number; host?: string }>(
      '/rest/2.0/pcs/file?method=locateupload',
      { skipCommonParams: true },
    );
    if (!json.host) throw es(-5);
    this.uploadHost = json.host;
    return this.uploadHost;
  }

  private async checkPremium(): Promise<void> {
    if (this.premiumChecked) return;
    const { json } = await this.request<{
      errno?: number;
      data?: { member_info?: { is_vip?: number } };
    }>('/rest/2.0/membership/proxy/user', { query: { method: 'query', membership_version: '1.0' } });
    this.isPremium = (json.data?.member_info?.is_vip || 0) > 0;
    this.premiumChecked = true;
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
    form.set('file', new Blob([data as unknown as BufferSource], { type: 'application/octet-stream' }), 'blob');
    const { json } = await this.request<{ errno?: number; md5?: string }>(
      `/rest/2.0/pcs/superfile2`,
      {
        method: 'POST',
        absoluteUrl: `https://${host}/rest/2.0/pcs/superfile2`,
        query: {
          method: 'upload',
          path: tbPath(absPath),
          uploadid: uploadId,
          partseq: String(partSeq),
          uploadsign: '0',
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

    const host = await this.ensureUploadHost();
    await this.ensureJsToken();

    const { uploadId, returnType } = await this.precreate(absPath, size, mtimeMs);
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
    for (const chunk of chunks) {
      const uploadedMd5 = await this.uploadChunk(host, absPath, uploadId, chunk.partSeq, chunk.data);
      if (uploadedMd5 !== chunk.md5) {
        throw new TeraboxError(-5, `Uploaded chunk ${chunk.partSeq} md5 mismatch`);
      }
    }

    const createdMd5 = await this.createFile(absPath, uploadId, size, mtimeMs, chunkMd5s, overwriteMode);

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