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
  // Optional base path the WebDAV surface is served under (gdrive parity),
  // e.g. "/dav/": requests outside it 404, the bare base 301s to its slash
  // form, and every emitted href includes it.
  PATH?: string;
  // Optional Terabox folder mounted as the WebDAV root (gdrive parity with
  // ROOT_ID; Terabox keys folders by path, not by opaque id), e.g. "/backup".
  // Unset or "/" mounts the whole account.
  ROOT_ID?: string;
  // Optional per-request log tag.
  LOG_PREFIX?: string;
  // Durable Object holding advisory WebDAV state (locks + dead props) for
  // the whole account. When absent the worker falls back to per-isolate
  // in-memory state (enforcement then relaxes across isolate hops).
  DAV_STATE?: DurableObjectNamespace;
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