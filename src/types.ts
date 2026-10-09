export interface Env {
  // Basic-auth credentials for the WebDAV surface: comma or newline separated
  // "user:password" pairs. The server fails closed when unset or empty.
  USERS?: string;
  // Terabox session cookie: full cookie string or bare "ndus" value.
  COOKIE?: string;
  // Optional alternate Terabox mirror host (defaults to www.terabox.com).
  TERABOX_DOMAIN?: string;
  // Optional pre-minted Terabox jsToken: run `window.jsToken` in the browser
  // console on terabox.com and paste the value (same as Alist/CLI config).
  // When set, the worker skips automatic token minting.
  JSTOKEN?: string;
  // Minimum gap in ms between outbound Terabox calls (default 400).
  MIN_GAP_MS?: string;
  // Optional per-request log tag.
  LOG_PREFIX?: string;
}

/** Raw item shape returned by Terabox list/filemeta endpoints. */
export interface TeraboxItem {
  fs_id?: number | string;
  path?: string;
  server_filename?: string;
  size?: number;
  ctime?: number;
  mtime?: number;
  server_ctime?: number;
  server_mtime?: number;
  category?: number;
  share?: number;
  isdir?: number;
  md5?: string;
  dlink?: string;
  errno?: number;
}

/** Normalised resource used by the WebDAV layer. */
export interface Dentry {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  mtimeMs: number;
  etag: string;
  contentType: string;
}