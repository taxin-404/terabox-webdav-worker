import { TeraboxClient, TeraboxError, errIsNum, type ResolvedFetchOpts } from './terabox';
import { viewerRedirect, viewerResponse, wantsViewer } from './viewer';
import { joinPath, splitPath } from './sign';
import {
  collectXmlScope,
  parsePropElements,
  selfContain,
  validateXml,
  type PropElement,
} from './davxml';
import {
  collectTokens,
  createDavStore,
  DavLimitError,
  resetDavVolatileState as resetDavStoreState,
  type DavStore,
  type LockOutcome,
  type LockRecord,
  type PathState,
  type PropPatchOp,
  type RelocateItem,
  type TokenCheck,
  type UploadStore,
} from './davstate';
import type { Dentry, TeraboxItem } from './types';

/** Clears every advisory layer the HTTP surface keeps in this isolate. */
export function resetDavVolatileState(): void {
  resetDavStoreState();
  metaCache.clear();
  metaMissCache.clear();
  dlUrlCache.clear();
  listCache.clear();
  listEpoch++;
  metaGenState.value = -1;
  metaGenState.checkedAt = 0;
}

/** Test hook: current metaCache occupancy (cap assertions in dav.test.ts). */
export function metaCacheSize(): number {
  return metaCache.size;
}
/** Test hook: seed the cache through the same write path itemInfoCached
 *  uses (expiry sweep + FIFO cap), without an HTTP round-trip per entry. */
export function metaCacheSeedForTest(absPath: string, item: TeraboxItem): void {
  cacheWrite(absPath, item);
}
/** Test hook: is a path currently cached? */
export function metaCacheHasForTest(absPath: string): boolean {
  return metaCache.has(absPath);
}
/** Test hook: current miss-cache occupancy (cap assertions in dav.test.ts). */
export function metaMissCacheSize(): number {
  return metaMissCache.size;
}
/** Test hook: seed the miss cache through the same write path itemInfoCached
 *  uses, without an HTTP round-trip per entry. */
export function metaMissCacheSeedForTest(absPath: string, err: unknown): void {
  missCacheWrite(absPath, err);
}
/** Test hook: is a path currently cached as a miss? */
export function metaMissCacheHasForTest(absPath: string): boolean {
  return metaMissCache.has(absPath);
}
export type { LockRecord };

export const DAV_NS = 'DAV:';

const MIME: Record<string, string> = {
  '.zip': 'application/zip',
  '.tar': 'application/x-tar',
  '.gz': 'application/gzip',
  '.7z': 'application/x-7z-compressed',
  '.rar': 'application/vnd.rar',
  '.mp4': 'video/mp4',
  '.mkv': 'video/x-matroska',
  '.mov': 'video/quicktime',
  '.avi': 'video/x-msvideo',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.flac': 'audio/flac',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.heic': 'image/heic',
  '.svg': 'image/svg+xml',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.ogv': 'video/ogg',
  '.m4v': 'video/mp4',
  '.m4a': 'audio/mp4',
  '.ts': 'video/mp2t',
  '.mts': 'video/mp2t',
  '.m2ts': 'video/mp2t',
  '.flv': 'video/x-flv',
  '.wmv': 'video/x-ms-wmv',
  '.mpg': 'video/mpeg',
  '.mpeg': 'video/mpeg',
  '.3gp': 'video/3gpp',
  '.aac': 'audio/aac',
  '.opus': 'audio/opus',
  '.oga': 'audio/ogg',
  '.aiff': 'audio/aiff',
  '.aif': 'audio/aiff',
  '.wma': 'audio/x-ms-wma',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.csv': 'text/csv',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

export function contentTypeFor(path: string): string {
  const idx = path.lastIndexOf('.');
  if (idx === -1) return 'application/octet-stream';
  const ext = path.slice(idx).toLowerCase();
  return MIME[ext] || 'application/octet-stream';
}

export function rfc1123(ms: number): string {
  return new Date(ms).toUTCString();
}

/** Methods this surface implements — advertised on OPTIONS and any 405. */
const ALLOW_HEADER =
  'OPTIONS, PROPFIND, PROPPATCH, MKCOL, GET, HEAD, PUT, DELETE, COPY, MOVE, LOCK, UNLOCK';

export function xmlEscape(value: string): string {
  return (
    value
      // XML 1.0 §2.2 Char production: C0 controls (save TAB/LF/CR) and the
      // non-characters cannot appear AT ALL — one raw NUL or ^A in a
      // filename, dead prop or lock owner makes the whole PROPFIND 207
      // unparseable (rclone/libxml2 hard-fail the listing). Names and props
      // arrive from clients and from upstream, so they cannot all be
      // rejected on input: this is the single emission choke point.
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, '\uFFFD')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;')
  );
}

/** WebDAV href (URL-encoded, trailing slash for collections). */
export function encodeHref(path: string, isDir: boolean): string {
  const segments = String(path || '/').split('/').filter(Boolean).map(encodeURIComponent);
  if (segments.length === 0) return isDir ? '/' : '';
  return '/' + segments.join('/') + (isDir ? '/' : '');
}

/** TeraBox's web API rejects names it considers invalid at creation with
 * `errno -7` ("Invalid file name") — live-proven 2026-10-18 (MKCOL + PUT
 * batteries): emoji/pictographs AND the ASCII set `? " * < > | : \` AND
 * tab/control characters are all refused, and a directory name may not
 * end in a space. Rather than littering files with a placeholder glyph,
 * every rejected code point is REMOVED before a write path reaches
 * Terabox (a name that strips to nothing or to bare dot/space residue
 * falls back to `_` so it stays addressable). Reads are left raw so names
 * that were created elsewhere (a mobile app) stay addressable when a
 * client follows their listed href. */

/** Emoji / pictograph ranges and the ASCII/control set upstream refuses. */
const REJECTED_CODEPOINT_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x00, 0x1f], // C0 control characters (tab probe proven rejected; rest hostile everywhere)
  [0x1f000, 0x1ffff], // all supplementary pictographs: transport/symbols/flags/skin tones
  [0x231a, 0x231b], // ⌚⌛
  [0x23e9, 0x23fa], // playback controls
  [0x23f0, 0x23f0], // ⏰
  [0x23f3, 0x23f3], // ⏳
  [0x2600, 0x27bf], // misc symbols + dingbats (☀ ⚡ ✂ ✈ ✉)
  [0x2934, 0x2935], // ⤴⤵
  [0x2b00, 0x2bff], // ⭐⬛⬆
  [0x3030, 0x3030], // 〰
  [0x303d, 0x303d], // 〽
  [0x3297, 0x3297], // ㊗
  [0x3299, 0x3299], // ㊙
  [0x7f, 0x7f], // DEL
  // Live-proven name-invalid ASCII (upstream -7): ? " * < > | : \
  [0x22, 0x22], // "
  [0x2a, 0x2a], // *
  [0x3a, 0x3a], // :
  [0x3c, 0x3e], // < >
  [0x3f, 0x3f], // ?
  [0x5c, 0x5c], // \
  [0x7c, 0x7c], // |
];
// NB: 0x2f ('/') is the path separator and never reaches a segment here.

function isRejectedCodePoint(cp: number): boolean {
  // Joiners/enclosures that only exist inside emoji clusters: ZWJ, keycap,
  // and the emoji variation selectors.
  if (cp === 0x200d) return true;
  if (cp === 0x20e3) return true;
  if (cp >= 0xfe00 && cp <= 0xfe0f) return true;
  return REJECTED_CODEPOINT_RANGES.some(([lo, hi]) => cp >= lo && cp <= hi);
}

/** Sanitize ONE path segment for upstream: rejected code points (emoji
 * runs, flags, rejected ASCII, controls) are REMOVED outright, then
 * trailing spaces trim (upstream refuses a directory name ending in one;
 * an emoji-then-space tail empties to the trim). A segment that strips to
 * nothing — or to bare dot/space residue, which cannot anchor a name —
 * falls back to `_`. Letters (CJK, accents), ©/®, ⌘, and every other
 * ACCEPTED character — including a literal '#' — pass through untouched,
 * which also keeps the rewrite idempotent. */
export function upstreamSafeName(name: string): string {
  if (name === '') return ''; // structural segment (path root / middle empties)
  let out = '';
  for (const ch of name) {
    if (isRejectedCodePoint(ch.codePointAt(0)!)) continue;
    out += ch;
  }
  out = out.replace(/ +$/, '');
  if (out === '' || /^[.\s]*$/.test(out)) return '_';
  return out;
}

/** Apply `upstreamSafeName` to every segment of a write-path. Input is
 * already cleaned (`.`/`..` removed by the callers), so a segment that
 * was pure rejected characters yields `_` (never an empty name). */
export function upstreamSafeDavPath(davPath: string): string {
  return davPath.split('/').map(upstreamSafeName).join('/');
}

/** Decode a request pathname into a cleaned absolute path. */
export function decodePathname(pathname: string): string {
  const segments = pathname.split('/');
  const parts: string[] = [];
  for (const segment of segments) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      parts.pop();
      continue;
    }
    let name = segment;
    try {
      // RFC 3986: in a *path*, `+` is a literal plus — only query strings
      // form-decode it to a space. Form semantics here silently renamed every
      // `+` file (media names like "5.1+English.mkv") to a nonexistent
      // space-name and 404'd davfs/rclone lookups. Same rule as the Google
      // Drive worker: plain decodeURIComponent, nothing else.
      name = decodeURIComponent(segment);
    } catch {
      throw new TeraboxError(-9, 'Invalid path encoding');
    }
    // Percent-encoded dot-segments decode to the same literals and must get
    // the identical cleanup: a raw `%2e%2e` used to survive as a literal
    // ".." component into the upstream path, where Terabox-side
    // normalization could walk above a ROOT_ID mount (DELETE/MOVE outside
    // the bound). A decoded "/" would fabricate path structure the client
    // never had a separator for — reject rather than guess.
    if (name === '' || name === '.') continue;
    if (name === '..') {
      parts.pop();
      continue;
    }
    if (name.includes('/')) throw new TeraboxError(-9, 'Invalid path encoding');
    // `%5c` is the only way a backslash reaches this point (URL parsing
    // maps a raw '\' to '/'). If Terabox-side normalization treats '\' as
    // a separator, a backslash-split segment carrying ".." escapes the
    // mount exactly like the literal ".." the check above rejects. Plain
    // "a\b.txt" names stay legal.
    if (name.includes('\\') && name.split(/[\\/]/).includes('..')) {
      throw new TeraboxError(-9, 'Invalid path encoding');
    }
    parts.push(name);
  }
  return '/' + parts.join('/');
}

/**
 * Sanitize an already-decoded absolute path (e.g. from a JSON body) by
 * collapsing `.` and `..` segments. The resumable-upload JSON `path` skips
 * `decodePathname`, so without this a crafted `..` could walk above a
 * ROOT_ID mount before `toTera` concatenates it.
 */
/** True if any path segment is the reserved `.DAV` metadata directory
 *  name (case-insensitive). */
function isReservedDavSegment(davPath: string): boolean {
  return davPath.split('/').some((segment) => segment.toUpperCase() === '.DAV');
}

function sanitizeDavPath(davPath: string): string {
  const parts: string[] = [];
  for (const segment of davPath.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      parts.pop();
      continue;
    }
    // Same traversal premise as decodePathname's guard: a segment that only
    // hides ".." behind backslashes must not reach the upstream path. The
    // resumable-upload JSON body is already percent-decoded, so it skips
    // decodePathname and lands here raw (§6.5-style capability bypass via
    // `..\..\evil` would otherwise reach Terabox's storage un-normalized).
    if (segment.includes('\\') && segment.split(/[\\/]/).includes('..')) {
      throw new TeraboxError(-9, 'Invalid path encoding');
    }
    parts.push(segment);
  }
  return '/' + parts.join('/');
}

/**
 * Mount mapping between the WebDAV namespace (what clients see) and the
 * Terabox namespace (paths on the account). Mirrors the Google Drive worker's
 * `PATH` (base subdirectory) and `ROOT_ID` (folder mounted as `/`) options:
 * Terabox identifies folders by path, so ROOT_ID is a path like "/backup".
 */
export interface Mount {
  /** Base subdirectory the surface is served under ("" when unset). */
  base: string;
  /** Terabox path that backs the WebDAV root ("/" when unset). */
  root: string;
  /** True when absPath *is* the WebDAV root resource (guards mutations). */
  isRoot(absPath: string): boolean;
  /** Terabox space → path relative to the mount root (no base). */
  toDav(absPath: string): string;
  /** WebDAV space (no base) → Terabox space. */
  toTera(davPath: string): string;
  /** Terabox space → WebDAV href path including the base. */
  href(absPath: string): string;
}

/** Normalise PATH: "" / "/" → no base; "/dav/" → "/dav". */
export function normalizeBasePath(raw?: string): string {
  const value = (raw || '').trim();
  if (!value || value === '/') return '';
  const base = ('/' + value.replace(/^\/+/, '')).replace(/\/+$/, '');
  return base === '' ? '' : base;
}

/**
 * `base` percent-encoded exactly the way the URL parser encodes request
 * pathnames. Routing compares the raw `url.pathname` (always percent-encoded)
 * against the base: a PATH with non-ASCII/space/#/? must be encoded by the
 * same algorithm byte-for-byte, or every request on such a mount 404s.
 * `#`/`?` cannot survive a URL parse as path characters, so they are
 * pre-encoded before the parse; `%` is left alone (the parser keeps it).
 */
export function mountBasePath(base: string): string {
  if (!base) return base;
  const safe = base.replace(/[#?]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  try {
    return new URL(`http://x${safe.startsWith('/') ? safe : `/${safe}`}`).pathname;
  } catch {
    return safe;
  }
}

/** XML request bodies are read from the wire at most this much (see below). */
const MAX_XML_BODY = 4 * 1024 * 1024;
/** Distinct properties one PROPFIND may name. The 4 MiB body cap alone still
 *  allows ~500k elements, and every one is re-emitted per response entry —
 *  a single authenticated request could build hundreds of MB of strings. */
const MAX_PROPFIND_PROPS = 128;
/** Hard cap for the JSON `POST /.resumable` begin body (path + size). */
const RESUMABLE_BEGIN_MAX = 64 * 1024;
/** PUT bodies above this (Content-Length known) stream through the multipart
 *  pipeline instead of buffering; they stay within one 4 MiB chunk below. */
const STREAM_PUT_MIN = 4 * 1024 * 1024;
/** PUT bodies without a usable Content-Length must buffer (precreate needs
 *  the size upfront) — capped here so a chunked stream cannot exhaust the
 *  128 MB isolate. Above this: send Content-Length and the body streams. */
const PUT_BUFFER_MAX = 32 * 1024 * 1024;

/**
 * Buffer a request body up to `max` bytes; `null` = over the cap (the
 * caller answers 413/400). The body is read as a stream so a ~100 MB
 * authenticated body can never land whole in the 128 MB isolate before the
 * size check runs — including when the client sends NO Content-Length
 * (chunked/H2): the declared fast-path below is skipped then, and only this
 * loop enforces the cap. Stream errors (client hung up mid-body) report the
 * same as an over-cap body rather than surfacing a 500.
 */
async function readBytesCapped(request: Request, max: number): Promise<Uint8Array | null> {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > max) return null;
  if (request.body === null) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) {
        try {
          await reader.cancel();
        } catch {
          // The client may already be gone; the 413/400 still stands.
        }
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }
  const all = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    all.set(chunk, at);
    at += chunk.byteLength;
  }
  return all;
}

async function readTextCapped(request: Request, max = MAX_XML_BODY): Promise<string | null> {
  const bytes = await readBytesCapped(request, max);
  if (bytes === null) return null;
  return new TextDecoder().decode(bytes);
}

/** Normalise ROOT_ID: "" / "/" → whole account; "/backup/" → "/backup". */
export function normalizeRootId(raw?: string): string {
  const value = (raw || '').trim();
  if (!value || value === '/') return '/';
  const root = ('/' + value.replace(/^\/+/, '')).replace(/\/+$/, '');
  return root === '' ? '/' : root;
}

export function makeMount(opts?: { basePath?: string; rootId?: string }): Mount {
  const base = normalizeBasePath(opts?.basePath);
  const root = normalizeRootId(opts?.rootId);
  const toDav = (absPath: string): string => {
    if (root === '/') return absPath;
    if (absPath === root) return '/';
    if (absPath.startsWith(root + '/')) {
      const rel = absPath.slice(root.length);
      return rel.startsWith('/') ? rel : '/' + rel;
    }
    return absPath;
  };
  const toTera = (davPath: string): string => {
    if (root === '/') return davPath;
    return davPath === '/' ? root : root + davPath;
  };
  return {
    base,
    root,
    isRoot: (absPath: string) => absPath === root,
    toDav,
    toTera,
    href: (absPath: string) => base + toDav(absPath),
  };
}

/**
 * Stable validator for a resource: the md5 when the backend provides one,
 * otherwise the same `"mtime-size-isdir"` fallback PROPFIND serves. GET/HEAD
 * and PROPFIND must always agree, and a GET that answers *without* an ETag
 * strips the validator a client stored earlier — davfs2 captures an etag only
 * from an exactly-200 response, overwrites its stored one with NULL when the
 * header is missing, and then re-downloads the whole file on every open.
 */
/**
 * Best-effort modification time in seconds: `server_mtime` when the API
 * provides it, then the client-visible `ctime`/`mtime` fields some list
 * entries carry instead — never epoch 0 when any timestamp exists.
 */
export function mtimeSecondsOf(item: TeraboxItem): number {
  return item.server_mtime || item.mtime || item.ctime || 0;
}

/**
 * mtimeSecondsOf() through one validity rule: numeric AND inside the range
 * `new Date` accepts. Anything else collapses to 0 (the epoch fallback
 * PROPFIND already used for non-numerics), so GET, HEAD and PROPFIND always
 * agree and no upstream timestamp can RangeError out of `toISOString()` —
 * which500'd not just the poisoned child but its parent's whole Depth-1
 * listing — or drop header-illegal bytes into an ETag (GET 500 while the
 * same file's PROPFIND answered207).
 */
export function safeMtimeSeconds(item: TeraboxItem): number {
  const seconds = Number(mtimeSecondsOf(item));
  if (!Number.isFinite(seconds)) return 0;
  return Math.abs(seconds * 1000) <= 8.64e15 ? seconds : 0;
}

export function etagFor(item: TeraboxItem): string {
  if (item.md5) return `"${item.md5}"`;
  // One-second mtime + size cannot distinguish two same-second rewrites, so
  // RFC 7232 §2.3 requires a WEAK validator here. Quoted-strong it would
  // satisfy If-Match/If-Range as "unchanged": a206 could then splice bytes
  // the client's validator never described, and If-None-Match would304
  // content that changed within the same second.
  return `W/"${safeMtimeSeconds(item)}-${item.size || 0}-${item.isdir || 0}"`;
}

async function itemToDentry(item: TeraboxItem): Promise<Dentry> {
  return {
    name: item.server_filename || '',
    path: item.path || '',
    isDir: (item.isdir || 0) > 0,
    size: item.size || 0,
    mtimeMs: safeMtimeSeconds(item) * 1000,
    etag: etagFor(item),
    contentType: (item.isdir || 0) > 0 ? 'httpd/unix-directory' : contentTypeFor(item.server_filename || ''),
  };
}

export interface DavResource {
  /** Terabox path backing this resource (dead props and locks key off it). */
  absPath: string;
  href: string;
  isDir: boolean;
  size: number;
  mtimeMs: number;
  etag: string;
  contentType: string;
}

/**
 * Read-side item metadata cache — the Google Drive worker keeps metadata in
 * `config.cache` for five minutes for the same reason: a filemetas round-trip
 * is a paced upstream hop (~0.7 s) and WebDAV clients pay it constantly
 * (davfs issues a Depth:0 PROPFIND per attribute lookup and one GET per range
 * chunk — at 64 KiB chunks mount reads crawled at ~24 KB/s). Entries are
 * always filled with the dlink flavour so statResource and handleGet share one
 * fill. 60 s bounds staleness of size/etag after an *external* change; writes
 * through this worker invalidate immediately (exact path, subtree, parent).
 * Negative lookups are never cached — a created file must appear at once.
 */
const META_TTL_MS = 60_000;
/** Hard cap so a long-lived isolate touching many distinct paths cannot grow
 *  the map without bound; oldest entries are evicted first (Map preserves
 *  insertion order). 2000 × a few hundred bytes ≈ well under a megabyte. */
const META_MAX_ENTRIES = 2000;
const metaCache = new Map<string, { item: TeraboxItem; expires: number }>();

/**
 * Negative mirror of metaCache: upstream "path does not exist" (errno -9)
 * answers, keyed by the same absPath. gvfsd-dav probes dozens of plausible
 * cover-art names (AlbumArt.jpg, cover.png, thumb.*) on EVERY directory
 * view; before this cache each probe paid a full /api/filemetas round-trip,
 * which made mounts and directory opens feel sluggish. The caught error is
 * rethrown verbatim so consumers keep their exact error contract
 * ("same behavior as an uncached miss"), and the TTL is deliberately half
 * the positive one: a path created OUTSIDE this worker (phone app, web UI)
 * must surface within 30 s, inside the 60 s staleness envelope the
 * positive cache already accepted.
 */
const META_MISS_TTL_MS = 30_000;
const metaMissCache = new Map<string, { err: unknown; expires: number }>();

/** Insert into the meta cache: sweep expired entries, then enforce the size
 *  cap FIFO before writing. Shared by the live stat path and test seeding. */
function cacheWrite(absPath: string, item: TeraboxItem): void {
  const now = Date.now();
  for (const [key, entry] of metaCache) {
    if (entry.expires <= now) metaCache.delete(key);
  }
  while (metaCache.size >= META_MAX_ENTRIES) {
    const oldest = metaCache.keys().next();
    if (oldest.done) break;
    metaCache.delete(oldest.value);
  }
  metaCache.set(absPath, { item, expires: now + META_TTL_MS });
}

/** Mirror of cacheWrite for the negative mirror: same sweep + FIFO cap so a
 *  long-lived isolate probing thousands of distinct missing names (a gvfs
 *  client over a huge share) cannot grow the map without bound. */
function missCacheWrite(absPath: string, err: unknown): void {
  const now = Date.now();
  for (const [key, entry] of metaMissCache) {
    if (entry.expires <= now) metaMissCache.delete(key);
  }
  while (metaMissCache.size >= META_MAX_ENTRIES) {
    const oldest = metaMissCache.keys().next();
    if (oldest.done) break;
    metaMissCache.delete(oldest.value);
  }
  metaMissCache.set(absPath, { err, expires: now + META_MISS_TTL_MS });
}

async function itemInfoCached(client: TeraboxClient, absPath: string): Promise<TeraboxItem> {
  const hit = metaCache.get(absPath);
  if (hit && hit.expires > Date.now()) return hit.item;
  const hitMiss = metaMissCache.get(absPath);
  if (hitMiss && hitMiss.expires > Date.now()) throw hitMiss.err;
  try {
    const item = await client.itemInfo(absPath, true);
    cacheWrite(absPath, item);
    return item;
  } catch (error) {
    // Only a definitive nonexistent-path answer is a miss: upstream faults
    // (network, session, list-truncation) must never masquerade as absence.
    if (errIsNum(error, -9)) missCacheWrite(absPath, error);
    throw error;
  }
}

/**
 * Read-side directory-listing cache. `/api/list` pages at 100 entries and
 * every page pays the account-wide pacing floor, so a 500-entry folder costs
 * 5 upstream calls (~2 s minimum) on *every* PROPFIND Depth:1 — and davfs2
 * re-lists a directory each time it is opened. Collapsing repeat listings for
 * a few seconds is the difference between a directory open that waits on
 * five paced hops and one that does not.
 *
 * Staleness is bounded tighter than the item cache (META_TTL_MS is 60 s):
 * listings are cached for 15 s, and every write through this worker drops the
 * path, its subtree and its parent immediately, then bumps the shared
 * generation so other isolates drop theirs within a second. An upload made in
 * the TeraBox app or web UI still appears within 15 s, which is inside the
 * envelope the metadata cache already accepts.
 */
const LIST_TTL_MS = 15_000;
/** FIFO caps mirroring metaCache: a long-lived isolate browsing many folders
 *  cannot pin memory, and one enormous folder is never cached at all. */
const LIST_MAX_ENTRIES = 32;
const LIST_MAX_ITEMS = 4000;
const listCache = new Map<string, { items: TeraboxItem[]; expires: number }>();
/**
 * Bumped by every event that makes cached listings unsafe: a write through
 * this worker, a cross-isolate generation change, or a test reset. A listing
 * walk captures it before the (paced, multi-page) upstream read and refuses
 * to store a snapshot that resolved after an invalidation — otherwise a list
 * that started before a write could re-insert pre-write contents and mask
 * the write for the full TTL, because the generation has already been synced
 * by the time it lands.
 */
let listEpoch = 0;

function listCacheWrite(absPath: string, items: TeraboxItem[]): void {
  if (items.length > LIST_MAX_ITEMS) return;
  const now = Date.now();
  for (const [key, entry] of listCache) {
    if (entry.expires <= now) listCache.delete(key);
  }
  while (listCache.size >= LIST_MAX_ENTRIES) {
    const oldest = listCache.keys().next();
    if (oldest.done) break;
    listCache.delete(oldest.value);
  }
  listCache.set(absPath, { items, expires: now + LIST_TTL_MS });
}

async function listCached(client: TeraboxClient, absPath: string): Promise<TeraboxItem[]> {
  const hit = listCache.get(absPath);
  if (hit && hit.expires > Date.now()) return hit.items;
  // NOTE: coalescing concurrent walks through a shared promise is NOT safe on
  // Workers — the promise carries I/O owned by the first request's context and
  // workerd rejects it from another request ("Cannot perform I/O on behalf of a
  // different request"). Measured and rejected; each caller walks on its own.
  const epoch = listEpoch;
  const items = await client.list(absPath === '/' ? '/' : absPath);
  if (epoch === listEpoch) listCacheWrite(absPath, items);
  return items;
}

/**
 * Read-side download-URL cache — the final signed CDN URL from the last
 * successful ladder walk, remembered so repeat GETs (video reopen, player
 * seeks) skip the whole mint chain: no filemetas re-mint, no PCS round-trip,
 * no API pacing floor. That chain is 2.5-4+ s of TTFB per open; a cache hit
 * is one direct CDN fetch.
 *
 * Entries are keyed by path but validated against the item's identity
 * (fs_id + size + mtime) that metaCache already carries — so an external
 * rewrite (seen through a fresh meta within 60 s) can never be served from a
 * stale URL, keeping the 60 s staleness contract exactly as before. Writes
 * through this worker invalidate immediately via the same hooks and the DO
 * generation bump as metaCache. The signed URL itself self-heals: any
 * upstream refusal drops the entry and re-walks the ladder, so TTL is a
 * memory bound (30 min of disuse), not a correctness deadline.
 */
const DLURL_TTL_MS = 30 * 60_000;
/** Hard cap mirroring metaCache: FIFO eviction, a few hundred bytes per
 *  entry — 1000 entries stays well under a megabyte. */
const DLURL_MAX_ENTRIES = 1000;
interface DlUrlEntry {
  url: string;
  fsId: string;
  size: number;
  mtimeMs: number;
  expires: number;
  /** True when the fetch that minted this URL hopped (302) to it — i.e. the
   *  URL lives on a CDN host the session cookie must never be sent to. */
  cookieless: boolean;
}
const dlUrlCache = new Map<string, DlUrlEntry>();

/** Insert through the same sweep + FIFO discipline as metaCache. */
function dlUrlCacheWrite(absPath: string, item: TeraboxItem, url: string, cookieless: boolean): void {
  const now = Date.now();
  for (const [key, entry] of dlUrlCache) {
    if (entry.expires <= now) dlUrlCache.delete(key);
  }
  while (dlUrlCache.size >= DLURL_MAX_ENTRIES) {
    const oldest = dlUrlCache.keys().next();
    if (oldest.done) break;
    dlUrlCache.delete(oldest.value);
  }
  dlUrlCache.set(absPath, {
    url,
    fsId: String(item.fs_id ?? ''),
    size: item.size || 0,
    mtimeMs: safeMtimeSeconds(item) * 1000,
    expires: now + DLURL_TTL_MS,
    cookieless,
  });
}

/** Validated lookup: the entry's identity must match the item about to be
 * served, else it is dropped and the ladder re-walks. Returns the replay
 * shape (URL + the cookieless boundary recorded when it was minted). */
function dlUrlCacheGet(absPath: string, item: TeraboxItem): { url: string; cookieless: boolean } | undefined {
  const entry = dlUrlCache.get(absPath);
  if (!entry) return undefined;
  const valid =
    entry.expires > Date.now() &&
    entry.fsId === String(item.fs_id ?? '') &&
    entry.size === (item.size || 0) &&
    entry.mtimeMs === safeMtimeSeconds(item) * 1000;
  if (!valid) {
    dlUrlCache.delete(absPath);
    return undefined;
  }
  return { url: entry.url, cookieless: entry.cookieless };
}

/** Slide the TTL of an entry that just served a hit — a hot file keeps its
 *  warm URL across repeated opens instead of re-laddering every 30 min.
 *  Touches only `expires` (mutate-only: it can never resurrect an entry an
 *  invalidation/gate-drop/FIFO eviction removed): the URL and the mint-time
 *  cookieless boundary stay exactly as written. Touch never moves the key
 *  forward in FIFO order, so at DLURL_MAX_ENTRIES an entry that has become
 *  the oldest key is still evicted — unchanged, pre-existing. */
function dlUrlCacheTouch(absPath: string): void {
  const entry = dlUrlCache.get(absPath);
  if (entry) entry.expires = Date.now() + DLURL_TTL_MS;
}

/**
 * Drop a mutated path, everything beneath it, and the parent's own entry —
 * then bump the generation held in the Durable Object so every OTHER isolate
 * drops its own copy too. The read cache is per isolate, so without that bump
 * the contract above ("writes through this worker invalidate immediately")
 * would only hold inside the isolate that happened to serve the write.
 * With DAV_STATE unbound the fallback store keeps its own counter per
 * isolate, so this cross-isolate guarantee degrades to the 60 s TTL — the
 * bound Durable Object is what makes the contract global.
 * Advisory: the metadata is already correct on Terabox when this runs, so a
 * failed bump must never fail the write.
 */
async function invalidateMeta(
  absPath: string,
  store?: DavStore,
  bump = true,
): Promise<void> {
  metaCache.delete(absPath);
  dlUrlCache.delete(absPath);
  metaMissCache.delete(absPath);
  listCache.delete(absPath);
  // Invalidate any list walk that is in flight right now (see listEpoch).
  listEpoch++;
  const prefix = absPath.endsWith('/') ? absPath : absPath + '/';
  for (const key of [...metaCache.keys()]) if (key.startsWith(prefix)) metaCache.delete(key);
  for (const key of [...dlUrlCache.keys()]) if (key.startsWith(prefix)) dlUrlCache.delete(key);
  for (const key of [...metaMissCache.keys()]) if (key.startsWith(prefix)) metaMissCache.delete(key);
  for (const key of [...listCache.keys()]) if (key.startsWith(prefix)) listCache.delete(key);
  const slash = absPath.lastIndexOf('/');
  const parent = slash <= 0 ? '/' : absPath.slice(0, slash);
  metaCache.delete(parent);
  dlUrlCache.delete(parent);
  metaMissCache.delete(parent);
  listCache.delete(parent);
  // `bump = false` lets a multi-path mutation (MOVE/COPY touches source,
  // destination and a pre-deleted target) publish one generation instead of
  // one serialized DO write per path. Every isolate clears wholesale on any
  // change, so a single bump after the operation is equivalent.
  if (!store || !bump) return;
  try {
    await store.metaGeneration(true);
  } catch (error) {
    console.log(`metaGen bump failed: ${String(error).slice(0, 200)}`);
  }
}

/** Last shared generation this isolate reconciled against. */
const metaGenState = { value: -1, checkedAt: 0 };
/** Test hook: when the generation was last checked (0 = never). */
export function metaGenCheckedAtForTest(): number {
  return metaGenState.checkedAt;
}
/** Reconciliation cadence: one Durable Object read per second per isolate is
 *  enough to keep stale size/etag/dlink off the response path (the previous
 *  design served them for the full 60 s TTL in any isolate but the writer's)
 *  while staying far below the cost of re-filling the cache every request. */
const META_GEN_CHECK_MS = 1_000;

/**
 * Compare the shared generation with the one this isolate last saw and drop
 * the local cache when it moved. Called once per request (throttled), so a
 * write through any other isolate is visible here within a second instead of
 * a minute. Fail-open: if the Durable Object is unreachable the cache is kept
 * and staleness falls back to META_TTL_MS.
 */
async function syncMetaGeneration(store: DavStore): Promise<void> {
  const now = Date.now();
  if (now - metaGenState.checkedAt < META_GEN_CHECK_MS) return;
  metaGenState.checkedAt = now;
  try {
    const gen = await store.metaGeneration(false);
    if (metaGenState.value !== -1 && gen !== metaGenState.value) {
      metaCache.clear();
      dlUrlCache.clear();
      metaMissCache.clear();
      listCache.clear();
      listEpoch++;
    }
    metaGenState.value = gen;
  } catch {
    // advisory only — see doc comment
  }
}

async function statResource(client: TeraboxClient, absPath: string): Promise<Dentry | null> {
  try {
    const item = await itemInfoCached(client, absPath);
    return await itemToDentry(item);
  } catch (error) {
    if (errIsNum(error, -9)) return null;
    throw error;
  }
}

/**
 * statResource, bypassing the 60 s read cache. Precondition evaluation must
 * see live validators: a stale etag satisfies If-Match and lets a lost update
 * through, and a stale mtime rejects a write that RFC 7232 says must pass.
 * Only requests that actually carry conditionals pay for the extra round-trip.
 */
async function statResourceFresh(client: TeraboxClient, absPath: string): Promise<Dentry | null> {
  try {
    return await itemToDentry(await client.itemInfo(absPath, false));
  } catch (error) {
    if (errIsNum(error, -9)) return null;
    throw error;
  }
}

/**
 * Advisory state (lock records, dead properties) for a write that has ALREADY
 * committed upstream. It must never turn a real success into a 500 — and a
 * DELETE that forgot nothing leaves its lock records behind, so a later
 * recreation of the path would resurrect a stale 423.
 */
export async function safeRelocate(store: DavStore, items: RelocateItem[]): Promise<void> {
  // Advisory bookkeeping (locks + dead props after DELETE/MOVE/COPY), but a
  // dropped call leaves real damage: locks stranded at the old path (stale
  // 423s for whatever lands there next) or a lock that never followed a
  // rename. Retry transient failures instead of swallowing the first one.
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await store.relocate(items);
      return;
    } catch (error) {
      if (attempt === 3) {
        console.log(`relocate failed after 3 attempts: ${String(error).slice(0, 200)}`);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 100 * attempt));
    }
  }
}

/*
 * Advisory state (lock records + dead properties) lives in ./davstate behind
 * the DavStore interface — Durable Object when bound, per-isolate memory
 * otherwise. The HTTP layer below only ever talks to a DavStore.
 */

interface IfTerm {
  negated: boolean;
  kind: 'token' | 'etag';
  value: string;
}

/**
 * One paren list plus the Resource-Tag naming the resource its terms
 * belong to (RFC 4918 §10.4.1 tagged-list production); null = untagged,
 * i.e. the Request-URI per §10.4.4.
 */
interface IfList {
  tag: string | null;
  terms: IfTerm[];
}

/** Cap on distinct tagged targets per If header (see checkMutationPreconditions). */
const MAX_IF_TAG_TARGETS = 8;

/**
 * Parse `If: [<tag>] (<token> [etag]) (Not <token2> …)` into OR-ed lists,
 * keeping each list's Resource-Tag. A `<…>` outside the parens counts as a
 * tag only when a list follows it (tagged-list = Resource-tag 1*List); the
 * paren-free forms of §10.4.1 (`If: <token>`, `If: ["etag"]`) are bare
 * terms on the Request-URI. `Not` is matched case-insensitively — the ABNF
 * literals are case-insensitive (RFC 5234 §2.3), so `(not <t>)` and
 * `(NOT <t>)` are negations too.
 */
function parseIfHeader(header: string): IfList[] | null {
  const lists: IfList[] = [];
  const listRe = /\(([^()]*)\)/g;
  let tag: string | null = null;
  let gapFrom = 0;
  let lm: RegExpExecArray | null;
  while ((lm = listRe.exec(header)) !== null) {
    // Text between the previous list and this one: a trailing `<…>` there
    // is this list's Resource-Tag. The tag stays in force for the list's
    // siblings until another tag replaces it (§10.4.1: 1*List per tag).
    const tagMatch = /<([^<>]*)>\s*$/.exec(header.slice(gapFrom, lm.index));
    if (tagMatch) tag = tagMatch[1] ?? null;
    gapFrom = listRe.lastIndex;
    const terms: IfTerm[] = [];
    const termRe = /(Not\s+)?<([^>]*)>|\[([^\]]*)\]/gi;
    let tm: RegExpExecArray | null;
    while ((tm = termRe.exec(lm[1] ?? '')) !== null) {
      if (tm[2] !== undefined) {
        terms.push({ negated: Boolean(tm[1]), kind: 'token', value: tm[2] });
      } else {
        terms.push({ negated: Boolean(tm[1]), kind: 'etag', value: tm[3] ?? '' });
      }
    }
    lists.push({ tag, terms });
  }
  if (lists.length > 0) return lists;
  // RFC 4918 §10.2.1 also legalizes the paren-free forms: a bare
  // `If: <opaquelocktoken:…>` (Tag-list) and `If: ["etag"]` (No-tag-list)
  // are each a single one-term list. Rejecting them with 400 broke clients
  // that send exactly those shapes.
  const bareRe = /(Not\s+)?<([^>]*)>|\[([^\]]*)\]/gi;
  const terms: IfTerm[] = [];
  let tm: RegExpExecArray | null;
  while ((tm = bareRe.exec(header)) !== null) {
    if (tm[2] !== undefined) {
      terms.push({ negated: Boolean(tm[1]), kind: 'token', value: tm[2] });
    } else {
      terms.push({ negated: Boolean(tm[1]), kind: 'etag', value: tm[3] ?? '' });
    }
  }
  return terms.length > 0 ? [{ tag: null, terms }] : null;
}

/**
 * Precondition gate for every mutating method: an unmet `If` answers 412
 * (or 423 when a submitted lock token does not match a live lock on an
 * already-locked resource, which is what mod_dav does and litmus expects),
 * then lock enforcement applies.
 */
/**
 * RFC 7232 conditionals on an unsafe method: If-Match, then If-Unmodified-
 * Since (only when If-Match is absent), then If-None-Match. A client that
 * says "only if unchanged" (`If-Match`, or `If-None-Match: *` for
 * create-only) must get 412 rather than a silent overwrite — before this,
 * those headers were evaluated only on reads, so the write path ignored
 * them entirely. Strong comparison per §2.3.2: a weak `W/…` tag never
 * matches a strong one.
 */
async function checkHttpPreconditions(
  request: Request,
  client: TeraboxClient,
  path: string,
): Promise<Response | null> {
  const ifMatch = request.headers.get('If-Match');
  const ifNoneMatch = request.headers.get('If-None-Match');
  if (ifMatch) {
    const dentry = await statResourceFresh(client, path);
    if (!dentry) return errorResponse('Precondition Failed', 412);
    if (ifMatch.trim() !== '*') {
      // §2.3.2: If-Match uses strong comparison, so a weak validator can
      // never satisfy it. GET/HEAD already enforce this; the write path must
      // agree or a same-second rewrite passes a precondition it should fail.
      const tags = ifMatch.split(',').map((tag) => tag.trim());
      if (dentry.etag.startsWith('W/') || !tags.includes(dentry.etag)) {
        return errorResponse('Precondition Failed', 412);
      }
    }
  } else {
    const ifUnmodified = request.headers.get('If-Unmodified-Since');
    if (ifUnmodified) {
      const since = Date.parse(ifUnmodified);
      if (!Number.isNaN(since)) {
        const dentry = await statResourceFresh(client, path);
        if (dentry && dentry.mtimeMs > since) return errorResponse('Precondition Failed', 412);
      }
    }
  }
  if (ifNoneMatch) {
    const dentry = ifNoneMatch.trim() === '*' || ifNoneMatch.includes('"')
      ? await statResourceFresh(client, path)
      : null;
    if (dentry) {
      if (ifNoneMatch.trim() === '*') return errorResponse('Precondition Failed', 412);
      // §6: an unsafe method with If-None-Match uses the WEAK comparison
      // function, so `W/"abc"` and `"abc"` are the same validator (davfs2
      // emits W/-prefixed tags unless drop_weak_etags is set). Comparing
      // literally would never match and the write would land anyway.
      const strip = (tag: string) => tag.replace(/^W\//, '');
      const tags = ifNoneMatch.split(',').map(strip);
      if (tags.includes(strip(dentry.etag))) return errorResponse('Precondition Failed', 412);
    }
  }
  return null;
}

/**
 * Tokens a client may present as a lock credential: non-negated, token-kind
 * terms only. `(Not <T>)` asserts that T does NOT lock the resource — it is a
 * condition, never a capability. Feeding it to enforcement would let `Not`
 * polarity invert into a successful write-through.
 */
function presentedCredentials(ifHeader: string | null): string[] {
  if (!ifHeader) return [];
  const lists = parseIfHeader(ifHeader);
  if (!lists) return [];
  const out: string[] = [];
  for (const list of lists) {
    for (const term of list.terms) {
      if (term.kind === 'token' && !term.negated) out.push(term.value);
    }
  }
  return out;
}

/**
 * Precondition gate for every mutating method: unmet `If` (and the
 * mod_dav-style invalid-token upgrade) answers 412/423, then lock
 * enforcement applies. Each list is evaluated against the resource it
 * identifies — the Resource-Tag when present, the Request-URI when not
 * (RFC 4918 §10.4.4) — and the header as a whole is true when any list is
 * true (§10.4.3), so a dest-tagged token (§7.5.1) can satisfy a COPY whose
 * Request-URI holds no lock token at all.
 */
async function checkMutationPreconditions(
  request: Request,
  client: TeraboxClient,
  store: DavStore,
  path: string,
  mount: Mount,
  opts?: { enforce?: boolean; lockSemantics?: boolean },
): Promise<Response | null> {
  // HTTP conditionals first (§6 evaluation order): a failing If-Match is a
  // definitive 412 regardless of how the WebDAV If header below evaluates.
  const httpPre = await checkHttpPreconditions(request, client, path);
  if (httpPre) return httpPre;

  const ifHeader = request.headers.get('If');
  const presented = collectTokens(ifHeader);
  const credentials = presentedCredentials(ifHeader);
  let check: TokenCheck | null = null;
  if (ifHeader) {
    const lists = parseIfHeader(ifHeader);
    if (!lists) return errorResponse('Bad Request', 400);
    check = await store.checkTokens(path, presented);
    const applies = new Set(check.applies);
    // Resolve each Resource-Tag exactly like a Destination URI. A tag that
    // names another origin or leaves the mount makes its lists false — a
    // failed condition (§10.4.10), never a 400: the header is well-formed,
    // the resource it names is simply not one whose locks we track.
    const requestOrigin = new URL(request.url);
    const resolveTag = (tag: string): string | null => {
      let url: URL;
      try {
        url = new URL(tag, request.url);
      } catch {
        return null;
      }
      if (url.host !== requestOrigin.host) return null;
      // Same order as routing: strip the (encoded) base from the RAW
      // pathname, then decode — a tag and the identical Request-URI
      // resolve to the same resource under a mount.
      let raw = url.pathname.split(/[?#]/, 1)[0]!;
      if (mount.base) {
        const basePath = mountBasePath(mount.base);
        if (raw === basePath) raw = '/';
        else if (raw.startsWith(basePath + '/')) raw = raw.slice(basePath.length);
        else return null;
      }
      let davPath: string;
      try {
        davPath = decodePathname(raw);
      } catch {
        return null;
      }
      if (davPath.length > 1 && davPath.endsWith('/')) davPath = davPath.slice(0, -1);
      try {
        return mount.toTera(sanitizeDavPath(davPath));
      } catch {
        // sanitizeDavPath throws TeraboxError(-9) for backslash-hidden
        // traversal; a tag naming such a URI resolves to nothing (412).
        return null;
      }
    };
    const resolved: Array<string | null> = lists.map((list) =>
      list.tag === null ? path : resolveTag(list.tag),
    );
    // Round-8 tag support made the per-request work O(distinct tagged
    // targets): one store lookup plus one paced upstream stat each. Cap
    // them (the Free plan allows 50 subrequests total) — 9+ distinct tagged
    // targets in one If is a client bug, and answering 400 beats 500.
    const distinctTargets = new Set(
      lists.flatMap((list, index) => {
        const target = resolved[index]!;
        return list.tag !== null && target !== null && target !== path ? [target] : [];
      }),
    );
    if (distinctTargets.size > MAX_IF_TAG_TARGETS) {
      return errorResponse('Too many tagged If targets', 400);
    }
    // One store lookup per tagged resource: which of the submitted tokens
    // actually apply there (untagged terms reuse the Request-URI result
    // above, byte-for-byte the pre-tag behavior).
    const taggedTokens = new Map<string, Set<string>>();
    lists.forEach((list, index) => {
      const target = resolved[index]!;
      if (list.tag === null || target === null || target === path) return;
      for (const term of list.terms) {
        if (term.kind !== 'token') continue;
        let set = taggedTokens.get(target);
        if (!set) taggedTokens.set(target, (set = new Set()));
        set.add(term.value);
      }
    });
    const taggedApplies = new Map<string, Set<string>>();
    for (const [target, set] of taggedTokens) {
      const checked = await store.checkTokens(target, [...set]);
      taggedApplies.set(target, new Set(checked.applies));
    }
    let anyTrue = false;
    const invalidTokens = new Set<string>();
    const etags = new Map<string, string | null>();
    for (let i = 0; i < lists.length; i += 1) {
      const list = lists[i]!;
      const target = resolved[i]!;
      // An unresolvable Resource-Tag fails its entire list (§10.4.10): no
      // term in it — negated or not — may make the list true. Evaluating
      // terms as plain `false` and then applying `Not` would flip an
      // all-failed list to true and silently ignore the condition.
      if (target === null) continue;
      let listTrue = list.terms.length > 0;
      for (const term of list.terms) {
        let value: boolean;
        if (term.kind === 'token') {
          if (list.tag === null || target === path) {
            value = applies.has(term.value);
            // Only Request-URI terms feed the mod_dav-style invalid-token
            // upgrade (412/423); a tagged token is judged against the
            // resource its tag names (§10.4.10) and must not poison an
            // otherwise-satisfiable header (§10.4.3 OR-of-lists).
            if (!term.negated && !value) invalidTokens.add(term.value);
          } else {
            value = taggedApplies.get(target)?.has(term.value) ?? false;
          }
        } else {
          let etag = etags.get(target);
          if (etag === undefined) {
            const dentry = await statResourceFresh(client, target);
            etag = dentry ? dentry.etag : null;
            etags.set(target, etag);
          }
          value = etag !== null && etag === term.value.trim();
        }
        if (term.negated) value = !value;
        listTrue = listTrue && value;
      }
      if (listTrue) anyTrue = true;
    }
    // A submitted lock token must identify a live lock even in a negated
    // position another list could satisfy — mod_dav rejects the request.
    // `<DAV:no-lock>` is the pseudo-token of the RFCs' own examples: it
    // never identifies a lock, so it fails as a plain condition (412);
    // a real lock-token-shaped value on a locked resource is a lock
    // problem and answers 423. (Untagged terms only — see above.)
    // `lockSemantics` (LOCK): §9.10.6 makes a foreign-token mismatch on a
    // LOCK a 412 (`lock-token-matches-request-uri`) whatever mod_dav does
    // for writes — skip the 423 upgrade and let lockAcquire's own §9.10.6
    // rule answer 412 after this evaluation passes the header as true.
    if (invalidTokens.size > 0 && !opts?.lockSemantics) {
      const lockShaped = [...invalidTokens].some(
        (t) => t.startsWith('opaquelocktoken:') || t.startsWith('urn:uuid:'),
      );
      return lockShaped && check.applying > 0
        ? errorResponse('Locked', 423)
        : errorResponse('Precondition Failed', 412);
    }
    if (!anyTrue) return errorResponse('Precondition Failed', 412);
  }
  if (opts?.enforce === false) return null;
  // RFC 4918 §6: writing a locked resource without its token is 423. Only
  // non-negated terms are credentials — see presentedCredentials().
  const effective = check ?? (await store.checkTokens(path, credentials));
  if (effective.applying === 0) return null;
  if (credentials.some((t) => effective.recordTokens.includes(t))) return null;
  return errorResponse('Locked', 423);
}

/** Lock enforcement alone (for methods without If-semantics, e.g. MKCOL). */
async function enforceWrite(
  request: Request,
  store: DavStore,
  path: string,
): Promise<Response | null> {
  const credentials = presentedCredentials(request.headers.get('If'));
  const check = await store.checkTokens(path, credentials);
  if (check.applying === 0) return null;
  if (credentials.some((t) => check.recordTokens.includes(t))) return null;
  return errorResponse('Locked', 423);
}

/**
 * Collection DELETE/MOVE/overwrite destroys members, so every live lock in
 * the subtree must be presented — not just locks that cover the collection
 * itself. RFC 4918 §9.6.1 (DELETE) and §9.9.4 (MOVE) both require it; a
 * depth-0 lock on `/coll/file` is otherwise invisible to the parent request
 * and the child disappears without its token. COPY is included for the
 * Overwrite pre-delete only (copying a locked member is legal; deleting it
 * is not).
 */
async function enforceMemberLocks(
  request: Request,
  store: DavStore,
  path: string,
  recursive: boolean,
): Promise<Response | null> {
  if (!recursive) return null;
  const presented = presentedCredentials(request.headers.get('If'));
  const locks = await store.subtreeLocks(path);
  return locks.some((r) => !presented.includes(r.token))
    ? errorResponse('Locked', 423)
    : null;
}

function activelockXml(rec: LockRecord, href: string): string {
  // Ceil, not floor: the record was created milliseconds ago with
  // expiresAt = now + 3600s, so the remaining value is 3599.99x — flooring
  // intermittently rendered Second-3599 on the very response that granted a
  // Second-3600 lock (a real sub-second flake, caught by the suite).
  const seconds = Math.max(0, Math.ceil((rec.expiresAt - Date.now()) / 1000));
  // Element order follows the RFC 4918 §14.12 content model exactly
  // (lockscope, locktype, depth, owner?, timeout?, locktoken?, lockroot),
  // and §14.4 defines the depth value in lowercase — strict clients compare
  // it literally. `lockroot` is SHOULDed in every lockdiscovery value.
  const depth = rec.depth === 'Infinity' ? 'infinity' : rec.depth;
  return (
    `<D:activelock>` +
    `<D:lockscope><D:${rec.scope}/></D:lockscope>` +
    `<D:locktype><D:write/></D:locktype>` +
    `<D:depth>${xmlEscape(depth)}</D:depth>` +
    (rec.owner ? ownerElementXml(rec.owner) : '') +
    `<D:timeout>Second-${seconds}</D:timeout>` +
    `<D:locktoken><D:href>${xmlEscape(rec.token)}</D:href></D:locktoken>` +
    `<D:lockroot><D:href>${xmlEscape(rec.rootHref ?? href)}</D:href></D:lockroot>` +
    `</D:activelock>`
  );
}

/**
 * Re-emit a stored lock owner without ever ill-forming the response. Lock
 * owners arrive as client XML and are stored for the lock's lifetime; a
 * record whose markup no longer parses (legacy records persisted before the
 * LOCK-body validation existed, or an exotic prefix we could not
 * self-contain) degrades to escaped text instead of breaking every PROPFIND
 * 207 that carries this lockdiscovery.
 */
function ownerElementXml(owner: string): string {
  const wrapped = `<D:owner xmlns:D="${DAV_NS}">${owner}</D:owner>`;
  return validateXml(wrapped) === null ? wrapped : `<D:owner>${xmlEscape(owner)}</D:owner>`;
}

function lockdiscoveryMarkup(locks: LockRecord[], href: string): string {
  if (locks.length === 0) return '<D:lockdiscovery/>';
  return `<D:lockdiscovery>${locks.map((rec) => activelockXml(rec, href)).join('')}</D:lockdiscovery>`;
}

/** Advisory-lock support advertised in `supportedlock` (gdrive parity). */
const SUPPORTED_LOCK =
  '<D:supportedlock><D:lockentry><D:lockscope><D:exclusive/><D:shared/></D:lockscope>' +
  '<D:locktype><D:write/></D:locktype></D:lockentry></D:supportedlock>';

/** Live DAV props this server can answer, keyed by local name. */
const STATIC_PROPS: Record<string, (r: DavResource) => string> = {
  resourcetype: (r) => `<D:resourcetype>${r.isDir ? '<D:collection/>' : ''}</D:resourcetype>`,
  getcontentlength: (r) => `<D:getcontentlength>${r.size}</D:getcontentlength>`,
  getcontenttype: (r) => `<D:getcontenttype>${xmlEscape(r.contentType)}</D:getcontenttype>`,
  getlastmodified: (r) => `<D:getlastmodified>${rfc1123(r.mtimeMs)}</D:getlastmodified>`,
  getetag: (r) => `<D:getetag>${xmlEscape(r.etag)}</D:getetag>`,
  displayname: (r) => `<D:displayname>${xmlEscape(displayNameOf(r))}</D:displayname>`,
  creationdate: (r) => `<D:creationdate>${new Date(r.mtimeMs).toISOString()}</D:creationdate>`,
  ishidden: () => '<D:ishidden>0</D:ishidden>',
  supportedlock: () => SUPPORTED_LOCK,
  // lockdiscovery is served from the live lock store per resource path.
};

/** Order used for allprop / the names-only view (lockdiscovery appended). */
const ALLPROP_ORDER = [
  'resourcetype',
  'getcontentlength',
  'getcontenttype',
  'getlastmodified',
  'getetag',
  'displayname',
  'creationdate',
  'ishidden',
  'supportedlock',
];

function displayNameOf(r: DavResource): string {
  const segments = r.href.split('/').filter(Boolean);
  const last = segments[segments.length - 1];
  if (!last) return '/';
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

export interface PropQuery {
  kind: 'all' | 'names' | 'list';
  /** Requested elements: expanded names plus self-contained markup. */
  requested: PropElement[];
  /** The client named more distinct properties than the server will emit. */
  tooMany?: boolean;
}

/**
 * Parse a PROPFIND body (the body must already have passed validateXml).
 * Unparseable/empty bodies fall back to allprop, which is always legal.
 */
export function parsePropfindBody(xml: string): PropQuery {
  const all: PropQuery = { kind: 'all', requested: [] };
  const body = xml.trim();
  if (!body) return all;
  if (/<(?:[A-Za-z0-9_]+:)?allprop[\s/>]/.test(body)) return all;
  if (/<(?:[A-Za-z0-9_]+:)?propname[\s/>]/.test(body)) {
    return { kind: 'names', requested: [] };
  }
  // First <...prop> element (the tag itself: "propfind"/"propname" fail the
  // trailing ">" / whitespace requirement and can never match here).
  const open = body.match(/<([A-Za-z_][\w.-]*:)?prop(?:\s[^>]*)?>/);
  if (!open || open.index === undefined) return all;
  const inner = body.slice(open.index + open[0].length);
  // Bind the close to the open tag's own prefix: a dead property named
  // `prop` in another namespace (`<X:prop>…</X:prop>` inside <D:prop>) must
  // not terminate the container — the prefix-agnostic match cut the markup
  // in half and echoed an unclosed element into the 207.
  const pfx = (open[1] ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const close = inner.match(new RegExp(`</${pfx}prop\\s*>`));
  if (!close || close.index === undefined) return all;

  const parsed = parsePropElements(inner.slice(0, close.index), collectXmlScope(body));
  if (parsed.length === 0) return all;
  // Dedupe by expanded name, then bound the set. Every requested element is
  // re-emitted once per response entry, so an unbounded (or heavily repeated)
  // body turns one PROPFIND into an O(props × children) string build.
  const seen = new Set<string>();
  const requested: PropElement[] = [];
  for (const el of parsed) {
    if (seen.has(el.key)) continue;
    seen.add(el.key);
    requested.push(el);
  }
  if (requested.length > MAX_PROPFIND_PROPS) {
    return { kind: 'list', requested: [], tooMany: true };
  }
  return { kind: 'list', requested };
}

/** Empty name element for a dead property, for the propname view. */
function deadNameElement(key: string): string {
  const m = /^\{([^}]*)\}(.+)$/.exec(key);
  if (!m) return `<${xmlEscape(key)}/>`;
  const ns = m[1] ?? '';
  const local = m[2] ?? '';
  if (ns === '' || ns === DAV_NS) return `<${local} xmlns="${xmlEscape(ns)}"/>`;
  return `<X:${local} xmlns:X="${xmlEscape(ns)}"/>`;
}

function multistatus(
  resource: DavResource,
  children: DavResource[],
  query: PropQuery,
  states: Record<string, PathState>,
): Response {
  const parts: string[] = [];
  parts.push(`<?xml version="1.0" encoding="utf-8"?>`);
  parts.push(`<D:multistatus xmlns:D="${DAV_NS}">`);

  const emit = (r: DavResource) => {
    parts.push(`<D:response>`);
    parts.push(`<D:href>${xmlEscape(r.href)}</D:href>`);
    const state = states[r.absPath];
    const locks = state?.locks ?? [];
    const dead = state?.props;

    if (query.kind === 'all') {
      parts.push(`<D:propstat>`);
      parts.push(`<D:prop>`);
      for (const name of ALLPROP_ORDER) parts.push(STATIC_PROPS[name]?.(r) ?? '');
      parts.push(lockdiscoveryMarkup(locks, r.href));
      if (dead) for (const markup of Object.values(dead)) parts.push(markup);
      parts.push(`</D:prop>`);
      parts.push(`<D:status>HTTP/1.1 200 OK</D:status>`);
      parts.push(`</D:propstat>`);
    } else if (query.kind === 'names') {
      parts.push(`<D:propstat>`);
      parts.push(`<D:prop>`);
      for (const name of ALLPROP_ORDER) parts.push(`<D:${name}/>`);
      parts.push(`<D:lockdiscovery/>`);
      if (dead) for (const key of Object.keys(dead)) parts.push(deadNameElement(key));
      parts.push(`</D:prop>`);
      parts.push(`<D:status>HTTP/1.1 200 OK</D:status>`);
      parts.push(`</D:propstat>`);
    } else {
      const ok: string[] = [];
      const missing: string[] = [];
      for (const el of query.requested) {
        if (el.key === `{${DAV_NS}}lockdiscovery`) {
          ok.push(lockdiscoveryMarkup(locks, r.href));
          continue;
        }
        const build = el.key.startsWith(`{${DAV_NS}}`) ? STATIC_PROPS[el.local] : undefined;
        if (build) {
          ok.push(build(r));
          continue;
        }
        const stored = dead?.[el.key];
        if (stored !== undefined) {
          ok.push(stored);
          continue;
        }
        missing.push(el.markup);
      }
      if (ok.length > 0) {
        parts.push(
          `<D:propstat><D:prop>${ok.join('')}</D:prop>` +
            `<D:status>HTTP/1.1 200 OK</D:status></D:propstat>`,
        );
      }
      if (missing.length > 0) {
        parts.push(
          `<D:propstat><D:prop>${missing.join('')}</D:prop>` +
            `<D:status>HTTP/1.1 404 Not Found</D:status></D:propstat>`,
        );
      }
      if (ok.length === 0 && missing.length === 0) {
        parts.push(`<D:propstat><D:prop/><D:status>HTTP/1.1 404 Not Found</D:status></D:propstat>`);
      }
    }

    parts.push(`</D:response>`);
  };

  emit(resource);
  for (const child of children) emit(child);

  parts.push(`</D:multistatus>`);
  return new Response(parts.join(''), {
    status: 207,
    headers: {
      'Content-Type': 'application/xml; charset="utf-8"',
      'Cache-Control': 'no-store',
    },
  });
}

/**
 * RFC 4918 WebDAV handler. The Terabox root maps to WebDAV "/".
 * Large-`Depth` listings are treated as children-only (same policy as the
 * Google Drive WebDAV worker).
 */
export async function handleWebDav(
  request: Request,
  client: TeraboxClient,
  opts?: { basePath?: string; rootId?: string },
  store: DavStore & UploadStore = createDavStore({}),
): Promise<Response> {
  const mount = makeMount(opts);
  const url = new URL(request.url);
  const method = request.method.toUpperCase();
  // Account-wide pacing: every isolate queues upstream slots through the
  // DAV_STATE DO, so the aggregate rate is 1 / MIN_GAP_MS no matter how many
  // isolates Cloudflare runs. Advisory: the memory fallback has no apiSlot,
  // and pace() keeps its isolate-local floor either way.
  client.apiSlotReserver = store.apiSlot ? (minGapMs) => store.apiSlot!(minGapMs) : undefined;

  // Base path (gdrive parity): the surface only exists below `mount.base`.
  // The bare base redirects to its slash form; anything else outside 404s.
  // Both sides of the comparison are percent-encoded by the same URL
  // algorithm (see mountBasePath) — a raw non-ASCII PATH never matches
  // the encoded pathname the request actually carries.
  let pathname = url.pathname;
  if (mount.base) {
    const basePath = mountBasePath(mount.base);
    if (pathname === basePath) {
      const redirect = new URL(request.url);
      redirect.pathname = basePath + '/';
      return Response.redirect(redirect.toString(), 301);
    }
    if (!pathname.startsWith(basePath + '/')) return errorResponse('Not Found', 404);
    pathname = pathname.slice(basePath.length);
  }

  let davPath: string;
  try {
    davPath = decodePathname(pathname);
  } catch (error) {
    return errorResponse(error instanceof Error ? error.message : 'Bad Request', 400);
  }
  if (davPath.length > 1 && davPath.endsWith('/')) davPath = davPath.slice(0, -1);

  // Resumable-upload control plane: `/.resumable/...` under the base path.
  // These drive Terabox's native multipart across many small HTTP requests so
  // a single body never exceeds Cloudflare's ~100 MB account-plan edge cap
  // (which would 413 before this Worker ever runs).
  //
  // Gated on METHOD × ROUTE SHAPE after path decoding, not on a bare textual
  // prefix: the old prefix match owned every method on `/.resumable`, so a
  // real resource with that name was listed by PROPFIND yet 404 at its own
  // href (GET) and uncreatable (PUT of the literal name). Everything that is
  // not one of the four control routes — GET/PROPFIND/OPTIONS/HEAD of the
  // resource, PUT of the root name, DELETE of the root name — now falls
  // through to WebDAV. The POST routes remain a deliberate root-namespace
  // reservation (documented in handleResumable); uploadIds are base64-ish
  // and may contain `/`, so the shapes are greedy like the handler's own
  // regexes.
  if (davPath === '/.resumable') {
    if (method === 'POST') return handleResumable(request, client, store, davPath, mount); // begin
  } else if (davPath.startsWith('/.resumable/')) {
    const rest = davPath.slice('/.resumable'.length);
    if (method === 'PUT' && /^\/.+\/\d+$/.test(rest)) {
      return handleResumable(request, client, store, davPath, mount); // chunk upload
    }
    if (method === 'DELETE' && rest.length > 1) {
      return handleResumable(request, client, store, davPath, mount); // cancel
    }
    if (method === 'POST' && /^\/.+\/finalize$/.test(rest)) {
      return handleResumable(request, client, store, davPath, mount); // finalize
    }
  }

  // Emoji names are illegal upstream (-7 at creation): the rewrite drops
  // them from state-changing paths (create + delete address
  // OUR-created names coherently), read paths stay raw so names created
  // elsewhere keep working via their listed hrefs. MOVE/COPY sources stay
  // raw too (they read an existing resource); only their Destination is
  // rewritten, inside handleMoveCopy.
  const writeIntent = method === 'PUT' || method === 'MKCOL' || method === 'DELETE';
  // Writes are sanitized before they reach upstream, so the reserved-name
  // check must run on the SANITIZED path too: `/.DAV☀` otherwise passes the
  // raw check and creates a real `.DAV` collection upstream.
  const upstreamDavPath = writeIntent ? upstreamSafeDavPath(davPath) : davPath;
  const absPath = mount.toTera(upstreamDavPath);

  // Reserved metadata segment (litmus 0.18 `protected` suite; the
  // CVE-2026-42535 class in mod_dav_fs): a path whose segment is `.DAV`
  // — case-insensitively, so `.dav`/`.Dav` cannot shadow it — is never
  // reachable by ANY method (OPTIONS excepted, being harmless discovery).
  // This worker keeps no server-internal store under `.DAV` today, but
  // reserving the name keeps clients from planting a decoy directory that
  // a future metadata implementation — or a downstream server — would then
  // trust; every litmus protected status set admits 403 as the rejection.
  if (method !== 'OPTIONS' && isReservedDavSegment(upstreamDavPath)) {
    return errorResponse('Forbidden', 403);
  }

  // Cross-isolate freshness: drop anything another isolate invalidated. Kept
  // below the resumable routes and after OPTIONS, which never read a cache —
  // a 4 GiB upload is ~1025 chunk PUTs and each one would otherwise pay a DO
  // read per second for data it never consults (SPEC: generation sync).
  if (method !== 'OPTIONS') await syncMetaGeneration(store);

  switch (method) {
    case 'OPTIONS':
      return new Response(null, {
        status: 204,
        headers: {
          Allow: ALLOW_HEADER,
          DAV: '1, 2',
          'MS-Author-Via': 'DAV',
        },
      });

    case 'PROPFIND':
      return handlePropfind(request, client, store, absPath, mount);

    case 'PROPPATCH':
      return handleProppatch(request, client, store, absPath, mount);

    case 'LOCK':
      return handleLock(request, client, store, absPath, mount);

    case 'UNLOCK':
      return handleUnlock(request, store, absPath);

    case 'MKCOL':
      return handleMkcol(request, client, store, absPath, mount);

    case 'GET':
    case 'HEAD':
      return handleGet(request, client, absPath, method === 'HEAD', mountBasePath(mount.base));

    case 'PUT':
      return handlePut(request, client, store, absPath, mount);

    case 'DELETE':
      return handleDelete(request, client, store, absPath, mount);

    case 'MOVE':
    case 'COPY':
      return handleMoveCopy(request, client, store, absPath, method, mount);

    default:
      // RFC 7231 §6.5.5: a 405 carries Allow so the client learns what works.
      return errorResponse('Method Not Allowed', 405, undefined, { Allow: ALLOW_HEADER });
  }
}

/**
 * Resumable-upload control plane for bodies larger than Cloudflare's ~100 MB
 * account-plan edge cap. Drives Terabox's native multipart (precreate →
 * superfile2 chunks → create) across many small HTTP requests so no single
 * request body ever trips the 413. Session state lives in the Durable Object
 * so any isolate can serve the next chunk.
 *
 *   POST /.resumable                      begin: { path, size } → { uploadId, chunkSize, chunkCount }
 *   PUT  /.resumable/:id/:index           one chunk (raw body) → { md5 }
 *   POST /.resumable/:id/finalize         create + verify → 201/204
 *   DELETE /.resumable/:id                cancel a session → 204 (404 unknown)
 */
async function handleResumable(
  request: Request,
  client: TeraboxClient,
  store: DavStore & UploadStore,
  pathname: string,
  mount: Mount,
): Promise<Response> {
  const method = request.method.toUpperCase();
  const rest = pathname.slice('/.resumable'.length);

  // POST /.resumable — begin a session.
  if (rest === '' && method === 'POST') {
    let body: { path?: string; size?: number; mtimeMs?: number; overwriteMode?: number };
    // A begin body is a tiny JSON object; cap it hard (64 KiB) so a
    // Content-Length-less stream cannot buffer unbounded in the isolate
    // before JSON.parse runs — the same premise as the XML body cap.
    const rawBody = await readTextCapped(request, RESUMABLE_BEGIN_MAX);
    if (rawBody === null) return errorResponse('Payload Too Large', 413);
    try {
      body = JSON.parse(rawBody) as typeof body;
    } catch {
      return errorResponse('Invalid JSON', 400);
    }
    const davPath = typeof body.path === 'string' ? body.path : '';
    // Integer size only: a fractional `size` would make every chunk PUT fail
    // its exact-length check forever ("expected 1.5"), wedging the session.
    const size = typeof body.size === 'number' && Number.isInteger(body.size) && body.size >= 0
      ? body.size
      : -1;
    if (!davPath.startsWith('/') || size < 0) return errorResponse('path and size required', 400);
    // The JSON path is already percent-decoded, but still needs `.`/`..`
    // collapsing — otherwise a crafted `..` walks above a ROOT_ID mount.
    // Emoji names are dropped exactly like PUT/MKCOL: this is a
    // write, and upstream refuses emoji at creation (-7).
    let absPath: string;
    try {
      const safeDavPath = upstreamSafeDavPath(sanitizeDavPath(davPath));
      // Same reservation as every other write: the sanitized name must not
      // plant a `.DAV` segment (see the raw-path check in handleWebDav).
      if (isReservedDavSegment(safeDavPath)) return errorResponse('Forbidden', 403);
      absPath = mount.toTera(safeDavPath);
    } catch {
      return errorResponse('Invalid path encoding', 400);
    }
    if (mount.isRoot(absPath) || absPath === '') return errorResponse('Forbidden', 403);

    // Resumable upload is a write: it must respect locks and HTTP
    // preconditions exactly like PUT (the resource is created at finalize).
    const pre = await checkMutationPreconditions(request, client, store, absPath, mount);
    if (pre) return pre;

    const parentCheck = await requireParent(client, absPath);
    if (parentCheck) return parentCheck;

    // Mirror handlePut: only errno -9 ("doesn't exist") makes the target
    // creatable — a network/gate failure must propagate, not be silently
    // reinterpreted as a fresh create (which then misreports later).
    let existing: { isDir: boolean } | null = null;
    try {
      existing = await statResourceFresh(client, absPath);
    } catch (error) {
      if (!errIsNum(error, -9)) throw error;
      existing = null;
    }
    // Resumable upload onto a collection is a method mismatch (RFC 7231).
    if (existing && existing.isDir) return errorResponse('Method Not Allowed', 405, undefined, { Allow: ALLOW_HEADER });
    const existed = Boolean(existing);
    const mtimeMs = typeof body.mtimeMs === 'number' && Number.isFinite(body.mtimeMs)
      ? body.mtimeMs
      : Date.now();
    // The conflict policy is never the client's choice: rtype 1 (rename on
    // conflict) would make Terabox write `file(1).txt` while we answer 204
    // at the requested path — a success reported for a path never touched.
    // Mirror PUT exactly: existing → overwrite, new → create-only.
    const overwriteMode = existed ? 3 : 0;

    const begun = await client.beginResumable(absPath, size, mtimeMs);
    try {
      await store.init({
        path: absPath,
        size,
        mtimeMs,
        uploadId: begun.uploadId,
        uploadSign: begun.uploadSign,
        chunkSize: begun.chunkSize,
        chunkCount: begun.chunkCount,
        chunkMd5s: new Array(begun.chunkCount).fill(null),
        hosts: begun.hosts,
        overwriteMode,
        createdAt: Date.now(),
      });
    } catch (err) {
      // Advisory-state safety cap (see MAX_UPLOAD_SESSIONS): 507, RFC 4918 §7.1.
      if (err instanceof DavLimitError) return errorResponse('Insufficient Storage', 507);
      throw err;
    }
    return Response.json({
      uploadId: begun.uploadId,
      chunkSize: begun.chunkSize,
      chunkCount: begun.chunkCount,
    });
  }

  // PUT /.resumable/:id/:index — one chunk (raw body). The uploadId is
  // base64-ish (may contain `:`, `=`, `+`, `/`), so greedily match it and
  // anchor only the leading slash and trailing /index.
  const chunkMatch = /^\/(.+)\/(\d+)$/.exec(rest);
  if (chunkMatch && method === 'PUT') {
    const [, uploadId, indexRaw] = chunkMatch;
    const index = Number(indexRaw);
    const session = await store.get(uploadId!);
    if (!session) return errorResponse('Unknown upload session', 404);
    if (!Number.isInteger(index) || index < 0 || index >= session.chunkCount) {
      return errorResponse('Chunk index out of range', 400);
    }
    const isLast = index === session.chunkCount - 1;
    const expectedLast = session.size - session.chunkSize * (session.chunkCount - 1);
    const expected = isLast ? expectedLast : session.chunkSize;
    // Refuse an over-long body from its Content-Length BEFORE buffering it:
    // otherwise a client can push the ~100 MB edge limit into a 4 MiB-chunk
    // session just to earn a 400, spending isolate memory on the way.
    const declaredHeader = request.headers.get('Content-Length');
    const declared = declaredHeader === null ? Number.NaN : Number(declaredHeader);
    if (Number.isFinite(declared) && declared !== expected) {
      return errorResponse(`Chunk size mismatch: got ${declared}, expected ${expected}`, 400);
    }
    const bytes = await readBytesCapped(request, expected + 1);
    if (bytes === null || bytes.byteLength > expected) {
      // Reached when the client streams MORE than expected with no
      // Content-Length (the declared fast-path above never fired) — stop at
      // expected+1 instead of buffering up to the runtime request cap.
      return errorResponse(`Chunk size mismatch: body exceeds ${expected} bytes`, 400);
    }
    // Last chunk may be short; all others must be exactly chunkSize.
    if (bytes.byteLength !== expected) {
      return errorResponse(
        `Chunk size mismatch: got ${bytes.byteLength}, expected ${expected}`,
        400,
      );
    }

    // Try each candidate host until one accepts (wrong-cluster 403 parity
    // with the non-resumable path). Prefer the host that accepted the last
    // chunk so a bad leading candidate isn't retried on every request; fall
    // back to the session's ordered list.
    const orderedHosts = session.activeHost
      ? [session.activeHost, ...session.hosts.filter((h) => h !== session.activeHost)]
      : session.hosts;
    let md5 = '';
    let acceptedHost = '';
    let lastError: unknown;
    for (const host of orderedHosts) {
      try {
        md5 = await client.uploadResumableChunk(host, session.path, session.uploadId, session.uploadSign, index, bytes);
        acceptedHost = host;
        break;
      } catch (error) {
        lastError = error;
        // Every error here comes from THIS host (the loop body talks to
        // nothing else): a 200-with-error-body, an empty md5 or a cluster
        // refusal must all advance the ladder. Gating on `httpStatus` let a
        // non-HTTP failure abort the failover the ladder exists for.
        if (error instanceof TeraboxError) continue;
        throw error;
      }
    }
    if (!md5) throw lastError ?? new TeraboxError(-5, 'No upload host accepted the chunk');
    await store.recordChunk(session.uploadId, index, md5, acceptedHost);
    return Response.json({ md5 });
  }

  // DELETE /.resumable/:id — cancel an upload session. Without this the
  // only way out of an abandoned upload was the 24 h TTL sweep, which kept
  // every uploaded chunk's md5 list (and the memory) alive that long.
  const cancelMatch = /^\/(.+)$/.exec(rest);
  if (cancelMatch && method === 'DELETE') {
    const [, uploadId] = cancelMatch;
    const session = await store.get(uploadId!);
    if (!session) return errorResponse('Unknown upload session', 404);
    await store.delete(session.uploadId);
    return new Response(null, { status: 204 });
  }

  // POST /.resumable/:id/finalize — create + verify. Same base64-ish id.
  const finalizeMatch = /^\/(.+)\/finalize$/.exec(rest);
  if (finalizeMatch && method === 'POST') {
    const [, uploadId] = finalizeMatch;
    const session = await store.get(uploadId!);
    if (!session) return errorResponse('Unknown upload session', 404);
    // Atomic claim. The old check (read `finalized`, then go) let two
    // concurrent finalize POSTs — a client retry racing a slow create — both
    // pass and race a second create, whose loser got -8 (path conflict) for a
    // file that DID land. The claim also replays a completed finalize, so a
    // lost-response retry answers with the original status instead of 404.
    const claim = await store.claimFinalize(session.uploadId);
    if (claim.kind === 'unknown') return errorResponse('Unknown upload session', 404);
    if (claim.kind === 'replay') return new Response(null, { status: claim.status });
    if (claim.kind === 'busy') {
      // Another request owns the finalize. Wait for its verdict instead of
      // racing it; if it fails and releases the claim, take it over.
      let owned = false;
      for (let attempt = 0; attempt < 16 && !owned; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        const current = await store.get(session.uploadId);
        if (!current) return errorResponse('Unknown upload session', 404);
        if (current.finalized !== undefined) return new Response(null, { status: current.finalized });
        if (current.finalizing === undefined) {
          const retried = await store.claimFinalize(session.uploadId);
          if (retried.kind === 'owned') owned = true;
          else if (retried.kind === 'replay') return new Response(null, { status: retried.status });
        }
      }
      if (!owned) return errorResponse('Finalize already in progress', 409);
    }
    // This request holds the claim: every exit below must either record the
    // verdict (marked) or hand the claim back in `finally`, or a retry would
    // sit out the stale-claim TTL on a session nobody is working on.
    let marked = false;
    try {
      // This branch is what actually creates the resource, so it is the
      // write that must respect a lock taken after `begin` AND any If /
      // If-Match conditionals the client sent with the finalize POST —
      // evaluated with the shared precondition gate (begin already checked
      // once, but the resource may have changed since; the comment above
      // promised full If handling and enforceWrite alone never delivered it).
      const pre = await checkMutationPreconditions(request, client, store, session.path, mount);
      if (pre) return pre;
      const missing = session.chunkMd5s.findIndex((m) => m === null);
      if (missing !== -1) return errorResponse(`Chunk ${missing} not uploaded`, 409);
      const chunkMd5s = session.chunkMd5s as string[];
      // The begin-time existence verdict can go stale (target deleted or
      // created between begin and finalize). RFC 4918 §9.6.1: 201 = created,
      // 204 = replaced — decided by a fresh stat taken right before THIS
      // create, not by a snapshot from minutes ago.
      const existedNow = (await statResource(client, session.path)) !== null;
      try {
        await client.finalizeResumable(
          session.path,
          session.uploadId,
          session.uploadSign,
          session.size,
          session.mtimeMs,
          chunkMd5s,
          session.overwriteMode,
        );
      } catch (error) {
        // Same conflict mapping as handlePut: -8 (path conflict) and -11 are
        // resource-exists conditions, not server faults.
        if (errIsNum(error, -8) || errIsNum(error, -11)) return errorResponse('Conflict', 409);
        if (error instanceof TeraboxError && error.integrity) {
          // The file exists upstream but failed the control-md5 comparison, so
          // re-running create would produce the same mismatch forever (and a
          // create-only session would answer -8 → 409, poisoning the retry).
          // Record the failure so a retry replays it instead of re-creating.
          try {
            await store.markFinalized(session.uploadId, 502);
            marked = true;
          } catch (markError) {
            console.log(`markFinalized(502) failed for ${session.uploadId}: ${String(markError).slice(0, 200)}`);
          }
          await invalidateMeta(session.path, store);
          return errorResponse('Integrity check failed', 502);
        }
        throw error;
      }
      // Keep the session (marked finalized) rather than deleting it, so a
      // lost-response retry replays the same status; the TTL sweep reaps it.
      // Best-effort: the file already exists on Terabox at this point, so a
      // failure in advisory state (a DO still running pre-deploy code, a
      // transient storage error) must not turn a completed upload into a 500.
      const status = existedNow ? 204 : 201;
      try {
        await store.markFinalized(session.uploadId, status);
        marked = true;
      } catch (error) {
        console.log(`markFinalized failed for ${session.uploadId}: ${String(error).slice(0, 200)}`);
      }
      await invalidateMeta(session.path, store);
      return new Response(null, { status });
    } finally {
      if (!marked) {
        try {
          await store.releaseFinalize(session.uploadId);
        } catch (error) {
          console.log(`releaseFinalize failed for ${session.uploadId}: ${String(error).slice(0, 200)}`);
        }
      }
    }
  }

  return errorResponse('Not Found', 404);
}

async function handlePropfind(
  request: Request,
  client: TeraboxClient,
  store: DavStore,
  absPath: string,
  mount: Mount,
): Promise<Response> {
  const depth = request.headers.get('Depth') || '1';
  const body = await readTextCapped(request);
  if (body === null) return errorResponse('Payload Too Large', 413);
  if (body.trim()) {
    // RFC 4918 §9.1: a malformed or namespace-invalid body is a 400,
    // never a silent allprop (litmus propfind_invalid/propfind_invalid2).
    const xmlError = validateXml(body);
    if (xmlError) return errorResponse(`Invalid XML: ${xmlError}`, 400);
  }
  const query = parsePropfindBody(body);
  if (query.tooMany) {
    return errorResponse(`Too many properties (max ${MAX_PROPFIND_PROPS})`, 400);
  }
  const resource = await statResource(client, absPath);
  if (!resource) return errorResponse('Not Found', 404);

  const href = encodeHref(mount.href(absPath), resource.isDir);
  if (depth === '0') {
    const states = await store.describe([absPath]);
    return multistatus({ ...resource, href, absPath }, [], query, states);
  }

  // Depth "1" and anything else (infinity/missing) → children only.
  if (absPath !== '/' && !resource.isDir) {
    const states = await store.describe([absPath]);
    return multistatus({ ...resource, href, absPath }, [], query, states);
  }
  if (absPath === '/' && !resource.isDir) {
    // Should not happen: the root is always a collection.
    const states = await store.describe([absPath]);
    return multistatus({ ...resource, href, absPath }, [], query, states);
  }

  let children: DavResource[] = [];
  try {
    const items = await listCached(client, absPath);
    children = await Promise.all(
      items.map(async (item) => {
        const dent = await itemToDentry(item);
        const childPath = joinPath(absPath, dent.name);
        return {
          ...dent,
          absPath: childPath,
          href: encodeHref(mount.href(childPath), dent.isDir),
        };
      }),
    );
  } catch (error) {
    if (errIsNum(error, -9)) return errorResponse('Not Found', 404);
    throw error;
  }

  // One store round-trip covers locks + dead props for the whole listing.
  const states = await store.describe([absPath, ...children.map((c) => c.absPath)]);
  return multistatus({ ...resource, href, isDir: true, absPath }, children, query, states);
}

async function handleMkcol(
  request: Request,
  client: TeraboxClient,
  store: DavStore,
  absPath: string,
  mount: Mount,
): Promise<Response> {
  if (mount.isRoot(absPath) || absPath === '') return errorResponse('Forbidden', 403);
  // RFC 4918 §9.3.1: a non-empty MKCOL body must be refused with 415
  // (litmus checks this), not silently ignored.
  const body = await readTextCapped(request);
  if (body === null) return errorResponse('Payload Too Large', 413);
  if (body.length > 0) return errorResponse('Unsupported Media Type', 415);
  const existing = await statResourceFresh(client, absPath);
  if (existing) {
    return new Response(
      '<D:error xmlns:D="DAV:"><D:exception>MethodNotAllowed</D:exception>' +
        '<D:message>The resource you tried to create already exists</D:message></D:error>',
      { status: 405, headers: { 'Content-Type': 'application/xml; charset=utf-8', Allow: ALLOW_HEADER } },
    );
  }
  // RFC 4918 §9.3.1: an intermediate collection must already exist (409).
  const parentCheck = await requireParent(client, absPath);
  if (parentCheck) return parentCheck;
  const pre = await checkMutationPreconditions(request, client, store, absPath, mount);
  if (pre) return pre;
  try {
    await client.mkdir(absPath);
  } catch (error) {
    if (errIsNum(error, -8)) return errorResponse('Method Not Allowed', 405, undefined, { Allow: ALLOW_HEADER });
    throw error;
  }
  await invalidateMeta(absPath, store);
  return new Response(null, { status: 201 });
}

/**
 * Verdict for an upstream 206 that arrived although the client asked for the
 * whole entity: the total length when the body is provably complete (safe to
 * re-state as 200), or null when it is a genuine partial (it must never be
 * streamed as a complete file — the caller rejects the candidate instead).
 */
function unrequestedPartialIsFull(upstream: Response, size: number): number | null {
  const contentRange = upstream.headers.get('Content-Range');
  const declared = upstream.headers.get('Content-Length');
  const length = declared === null ? Number.NaN : Number(declared);
  if (contentRange) {
    const m = /^bytes\s+(\d+)-(\d+)\/(\d+)$/.exec(contentRange.trim());
    if (!m) return null;
    const start = Number(m[1]);
    const end = Number(m[2]);
    const total = Number(m[3]);
    // Self-consistent full extent, and a Content-Length that agrees with it.
    if (start !== 0 || total === 0 || end !== total - 1) return null;
    if (declared !== null && length !== total) return null;
    return total;
  }
  // No extent given: only a body whose length matches the known size is safe.
  return Number.isFinite(length) && length > 0 && length === size ? length : null;
}

/**
 * RFC 6266 attachment header with an ASCII fallback and the RFC 5987
 * UTF-8 form (`filename*`), so `résumé notes.txt` downloads under its
 * real name in every browser.
 */
export function contentDispositionAttachment(fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(fileName)
    .replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

async function handleGet(
  request: Request,
  client: TeraboxClient,
  absPath: string,
  isHead: boolean,
  basePath = '',
): Promise<Response> {
  let item;
  try {
    item = await itemInfoCached(client, absPath);
  } catch (error) {
    if (errIsNum(error, -9)) return errorResponse('Not Found', 404);
    throw error;
  }
  // RFC 7231 §6.5.5: every 405 carries Allow — the collection root is the
  // most-probed 405 on this surface. A *browser* navigation (Accept
  // text/html) gets the viewer page instead — canonical slash form first,
  // because the page resolves child hrefs relative to its own URL. Every
  // WebDAV client (Accept */* or XML) keeps the 405, pinned in
  // test/viewer.test.ts and covered by litmus.
  if ((item.isdir || 0) > 0) {
    if (!isHead && wantsViewer(request)) {
      const pathname = new URL(request.url).pathname;
      if (!pathname.endsWith('/')) return viewerRedirect(request);
      return viewerResponse(basePath);
    }
    return errorResponse('Method Not Allowed', 405, undefined, { Allow: ALLOW_HEADER });
  }

  const lastModifiedMs = safeMtimeSeconds(item) * 1000;
  // Backup semantics: a browser GET of a file always *downloads* it —
  // there is no in-page preview anymore, and opening a raw URL in a tab
  // would just show the bytes. WebDAV clients ignore the header.
  const downloadName = item.server_filename || absPath.split('/').pop() || 'download';
  const headers = new Headers({
    'Content-Type': contentTypeFor(item.server_filename || ''),
    'Content-Disposition': contentDispositionAttachment(downloadName),
    'Last-Modified': rfc1123(lastModifiedMs),
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
    // Account content served from the authenticated API origin: sandbox the
    // document so an attacker-influenced HTML file cannot run script (and
    // replay the browser-cached Basic credentials against this origin), and
    // block every subresource load. `default-src 'none'` does not govern a
    // direct image/PDF navigation, and WebDAV clients ignore both headers.
    'Content-Security-Policy': "sandbox; default-src 'none'",
  });
  const etag = etagFor(item);
  headers.set('ETag', etag);

  // RFC 7232 §6 order: steps 1–2 gate even safe methods — a client asking
  // "only if unchanged" must get412, not the changed bytes. §5 precedence
  // keeps404 above them: this point is only reached when the resource
  // exists (the itemInfo 404 returns earlier).
  const ifMatch = request.headers.get('If-Match');
  if (ifMatch) {
    // §2.3.2 strong comparison: a weak validator never matches — an md5-less
    // etag (W/"…") fails every If-Match but `*`.
    if (ifMatch.trim() !== '*') {
      const tags = ifMatch.split(',').map((tag) => tag.trim());
      if (etag.startsWith('W/') || !tags.includes(etag)) {
        return errorResponse('Precondition Failed', 412);
      }
    }
  } else {
    const ifUnmodified = request.headers.get('If-Unmodified-Since');
    if (ifUnmodified) {
      const since = Date.parse(ifUnmodified);
      if (!Number.isNaN(since) && lastModifiedMs > since) {
        return errorResponse('Precondition Failed', 412);
      }
    }
  }

  // Conditional GET: validators answer before a download link is minted.
  const inm = request.headers.get('If-None-Match');
  if (inm) {
    // §3.2 weak comparison: W/"x" and "x" are the same validator — normalize
    // both sides so a client echoing (or stripping) the weak md5-less tag
    // revalidates the same.
    const stripWeak = (tag: string) => tag.replace(/^W\//, '');
    const tags = inm.split(',').map((tag) => stripWeak(tag.trim()));
    if (inm.trim() === '*' || tags.includes(stripWeak(etag))) {
      return new Response(null, {
        status: 304,
        headers: { ETag: etag, 'Last-Modified': rfc1123(lastModifiedMs), 'Cache-Control': 'no-store' },
      });
    }
  }
  const ims = request.headers.get('If-Modified-Since');
  if (!inm && ims) {
    const since = Date.parse(ims);
    if (!Number.isNaN(since) && lastModifiedMs <= since) {
      return new Response(null, {
        status: 304,
        headers: {
          'Last-Modified': rfc1123(lastModifiedMs),
          ETag: etag,
          'Cache-Control': 'no-store',
        },
      });
    }
  }

  let range = request.headers.get('Range');
  const ifRange = request.headers.get('If-Range');
  if (range && ifRange) {
    // RFC 7233 §3.2: the comparison is an EXACT match — deliberately NOT the
    // "earlier or equal" of If-Unmodified-Since — and strong. A date newer
    // than what we sent (or an mtime that rolled back) is stale, and a weak
    // md5-less etag can never authorize a splice: either would mix fresh
    // bytes into the client's old partial copy.
    const fresh = ifRange.includes('"')
      ? !etag.startsWith('W/') && ifRange === etag
      : !Number.isNaN(Date.parse(ifRange)) && Date.parse(rfc1123(lastModifiedMs)) === Date.parse(ifRange);
    if (!fresh) range = null;
  }
  if (range) {
    // Validate against the size itemInfo already gave us: an unsatisfiable
    // range answers 416 authoritatively without touching the ladder. (The
    // CDN verdict for out-of-bounds ranges varies by cluster — some answer
    // 400141 gates — and the fallback dlinks are gated anyway.) Anything we
    // can't parse is ignored and the full entity is served (RFC 7233 §3.1).
    const spec = /^bytes=(\d*)-(\d*)$/i.exec(range); // ABNF is case-insensitive (RFC 7230 §3.2.2)
    const size = item.size || 0;
    let unsatisfiable = false;
    if (!spec || (spec[1] === '' && spec[2] === '')) {
      range = null;
    } else if (spec[1] === '') {
      const suffix = Number(spec[2]);
      unsatisfiable = suffix === 0 || size === 0;
    } else {
      const first = Number(spec[1]);
      // RFC 9110 §14.1.1: a byte-range-spec whose last position precedes its
      // first is invalid and the WHOLE header is ignored (200 full entity).
      // Treating it as satisfiable produced `206 Content-Range: bytes 5-3/10`
      // from the HEAD fast path and an upstream 416 for GET.
      if (spec[2] !== '' && Number(spec[2]) < first) {
        range = null;
      } else {
        unsatisfiable = first >= size;
      }
    }
    if (unsatisfiable) {
      return new Response(null, {
        status: 416,
        headers: {
          ...Object.fromEntries(headers),
          'Content-Range': `bytes */${size}`,
        },
      });
    }
    if (spec && range) {
      // Canonicalize: our parse is case-insensitive, but the origin matches
      // `bytes=` literally when slicing — a satisfied `BYTES=0-2` must ride
      // upstream as `bytes=0-2` or the range silently degrades to a full
      // 200 body.
      range = `bytes=${spec[1]}-${spec[2]}`;
    }
  }

  // HEAD is a metadata probe: the item already carries the authoritative size,
  // mtime and ETag, so minting a download link and opening the CDN body only
  // to cancel it just to echo headers bought nothing. Live measurement on a
  // 64 KiB file: HEAD 390-780 ms vs 115-184 ms for a ranged GET through the
  // cached path. Answer from stat, and skip the ladder entirely.
  if (isHead) {
    const size = item.size || 0;
    const spec = range ? /^bytes=(\d*)-(\d*)$/i.exec(range) : null;
    if (range && spec) {
      // `spec` is the canonical form rebuilt above, so the arithmetic cannot
      // disagree with the satisfiability check that already ran.
      const start = spec[1] === '' ? Math.max(0, size - Number(spec[2])) : Number(spec[1]);
      const last = spec[1] === '' || spec[2] === '' ? size - 1 : Number(spec[2]);
      const end = Math.min(last, size - 1);
      headers.set('Content-Length', String(Math.max(0, end - start + 1)));
      headers.set('Content-Range', `bytes ${start}-${end}/${size}`);
      return new Response(null, { status: 206, headers });
    }
    headers.set('Content-Length', String(size));
    return new Response(null, { status: 200, headers });
  }

  let lastError: unknown = new TeraboxError(-5, 'No usable download link');
  /** Final post-302 capability URL of the last fetch that got a verdict —
   *  set per tryUrl call, so a truthy tryUrl result always pairs with the
   *  URL that actually served (the download-URL cache keys on that). */
  let servedUrl: string | undefined;
  /** Whether that served URL hopped to a host the session must never reach
   *  (recorded per fetch; cached and replayed as the cookieless boundary). */
  let servedCookieless = false;
  /** Try one candidate; resolves the ready-to-stream Response or records why it failed. */
  const tryUrl = async (
    downloadUrl: string,
    opts?: ResolvedFetchOpts,
  ): Promise<Response | undefined> => {
    try {
      // Paced, cookie-authenticated stream fetch: retries a jsToken gate once
      // and raises an errno-shaped body as TeraboxError instead of streaming it.
      const { response: upstream, finalUrl, cookieless } = await client.fetchDownload(downloadUrl, range, opts);
      servedUrl = finalUrl;
      servedCookieless = cookieless;
      if (upstream.status === 416) {
        // Range not satisfiable: pass the CDN's verdict through instead of
        // burning the remaining ladder phases on ranges it will also refuse.
        // Only when a range was actually asked for — a 416 answer to a full
        // GET is an upstream fault, and the ladder should keep trying.
        if (range) {
          const contentRange = upstream.headers.get('Content-Range');
          if (contentRange) headers.set('Content-Range', contentRange);
          const contentLength = upstream.headers.get('Content-Length');
          if (contentLength) headers.set('Content-Length', contentLength);
          return new Response(upstream.body, { status: 416, headers });
        }
        lastError = new TeraboxError(-5, 'Terabox answered 416 to a full GET');
        void upstream.body?.cancel().catch(() => undefined);
        return undefined;
      }
      if (!upstream.ok && upstream.status !== 206) {
        lastError = new TeraboxError(-5, `Terabox download http error ${upstream.status}`);
        void upstream.body?.cancel().catch(() => undefined);
        return undefined;
      }

      const contentLength = upstream.headers.get('Content-Length');
      if (contentLength) headers.set('Content-Length', contentLength);
      if (range) {
        const contentRange = upstream.headers.get('Content-Range');
        if (contentRange) headers.set('Content-Range', contentRange);
      }
      // RFC 7233 §4.1: a server must not answer 206 to a request that did not
      // ask for a range. The PCS route flaps into exactly that, and davfs2
      // captures an etag only from an exactly-200 GET — one unrequested 206
      // nulls the client's stored validator and every later open re-downloads
      // the whole file (docs/davfs2-etag-hang-investigation.md). Normalize:
      // an unrequested 206 whose body is provably the whole entity is
      // re-stated as 200; a genuinely partial body is rejected outright —
      // never streamed as a complete file — so the ladder moves to the next
      // candidate. A 206 that *was* asked for passes through verbatim.
      let status = upstream.status;
      if (status === 206 && !range) {
        const fullLength = unrequestedPartialIsFull(upstream, item.size || 0);
        if (fullLength === null) {
          headers.delete('Content-Length');
          headers.delete('Content-Range');
          void upstream.body?.cancel().catch(() => undefined);
          lastError = new TeraboxError(-5, 'Terabox served a partial body for a full GET');
          return undefined;
        }
        status = 200;
        headers.set('Content-Length', String(fullLength));
        headers.delete('Content-Range');
      } else if (status === 200) {
        // A full entity may satisfy a ranged request (RFC 7233 §3.1) but must
        // not carry a Content-Range that describes only part of it.
        headers.delete('Content-Range');
      }
      // HEAD never hands the entity to the client — release the upstream
      // stream instead of leaving it for the runtime to reap mid-flight.
      if (isHead) {
        void upstream.body?.cancel().catch(() => undefined);
        return new Response(null, { status, headers });
      }
      return new Response(upstream.body, { status, headers });
    } catch (error) {
      lastError = error;
      return undefined;
    }
  };

  /** A candidate that served: remember its capability URL so the next open
   *  skips the mint chain (identity-validated, write-invalidated, self-healing). */
  const serveSucceeded = (res: Response): Response => {
    if (servedUrl) dlUrlCacheWrite(absPath, item, servedUrl, servedCookieless);
    return res;
  };

  // Phase 0: a previously served capability URL — one direct CDN fetch, no
  // filemetas re-mint, no PCS round-trip, no pacing floor. Dropped on any
  // refusal so the ladder below (and a refreshed cache entry) takes over.
  // The cookieless boundary recorded at mint time replays with the fetch: a
  // post-302 URL lives on a CDN host the session must never reach. A hit
  // slides the TTL but does NOT rewrite the entry — the replay computes its
  // own hopped/cookieless pair (a rotating capability URL may even hop to a
  // NEW finalUrl), and writing that back would replace the mint-time
  // boundary — and URL — with a response this path did not re-validate.
  const cached = dlUrlCacheGet(absPath, item);
  if (cached) {
    const res = await tryUrl(cached.url, { resolved: true, cookieless: cached.cookieless });
    if (res) {
      dlUrlCacheTouch(absPath);
      return res;
    }
    dlUrlCache.delete(absPath);
  }

  // Phase 1: the PCS app-protocol route (mobile/desktop parity) — cookie in,
  // 302 straight to the CDN, no /file/<hash> dlink hop (that hop gates
  // datacenter IPs with 400141 "need verify"). No minting, so the happy path
  // costs a single upstream call.
  for (const url of client.pcsDownloadUrls(absPath)) {
    const res = await tryUrl(url);
    if (res) return serveSucceeded(res);
  }
  // Phase 2: the official /api/download dlink (token-bearing, Alist parity) —
  // minted lazily so the fast path never pays for home/info + sign.
  if (item.fs_id) {
    try {
      const official = await client.downloadLink(String(item.fs_id));
      if (official) {
        const res = await tryUrl(official);
        if (res) return serveSucceeded(res);
      }
    } catch {
      // official mint failed (sign/home info) — the filemetas dlink still may work
    }
  }
  // Phase 3: the plain filemetas dlink; every flavour gated rethrows the last error.
  if (item.dlink) {
    const res = await tryUrl(item.dlink);
    if (res) return serveSucceeded(res);
  }
  throw lastError;
}

async function handlePut(
  request: Request,
  client: TeraboxClient,
  store: DavStore,
  absPath: string,
  mount: Mount,
): Promise<Response> {
  if (mount.isRoot(absPath) || absPath === '') return errorResponse('Forbidden', 403);

  // PUT replaces the whole entity. A ranged PUT fragment cannot be honored
  // as an object body (RFC 9110 §14.4: reject rather than store it whole).
  if (request.headers.get('Content-Range')) {
    return errorResponse('Content-Range is not supported on PUT', 400);
  }

  const pre = await checkMutationPreconditions(request, client, store, absPath, mount);
  if (pre) return pre;

  // RFC 4918 §9.7.1: creation needs existing intermediate collections (409).
  const parentCheck = await requireParent(client, absPath);
  if (parentCheck) return parentCheck;

  let existing: { isDir: boolean } | null = null;
  try {
    existing = await statResourceFresh(client, absPath);
  } catch (error) {
    // Only "doesn't exist" makes the target creatable; a network/gate
    // failure (-5, -6, …) must propagate instead of being silently
    // reinterpreted as an overwrite (which then misreports as 409).
    if (!errIsNum(error, -9)) throw error;
    existing = null;
  }
  // PUT onto a collection is a method mismatch (RFC 7231 §6.5.5).
  if (existing && existing.isDir) return errorResponse('Method Not Allowed', 405, undefined, { Allow: ALLOW_HEADER });
  const existed = Boolean(existing);

  // A KNOWN size above the threshold streams through Terabox's multipart
  // pipeline (precreate → superfile2 chunks → create) so a body the edge
  // happily delivers (~100 MB on this plan) never has to coexist with the
  // isolate's other 128 MB. An unknown size cannot precreate, so it still
  // buffers — under a hard cap. The stat above runs first in both paths so
  // 405/409 answer before a single body byte is pulled.
  const declared = Number(request.headers.get('content-length'));
  const streaming = Number.isFinite(declared) && declared > STREAM_PUT_MIN;
  let bytes: Uint8Array | null = null;
  if (!streaming) {
    bytes = await readBytesCapped(request, PUT_BUFFER_MAX);
    if (bytes === null) return errorResponse('Payload Too Large', 413);
  }

  try {
    if (streaming) {
      const body = request.body;
      if (!body) throw new TeraboxError(2, 'Missing request body');
      await client.uploadStream(absPath, declared, Date.now(), body, existed ? 3 : 0);
    } else {
      await client.upload(absPath, bytes!.byteLength, Date.now(), bytes!, existed ? 3 : 0);
    }
  } catch (error) {
    // Only observable while streaming: the body stopped short of its
    // Content-Length. Finalizing would publish a truncated file, so this is
    // a client-side fault (400) — NOT -9's usual 404 "target missing".
    if (streaming && errIsNum(error, -9)) return errorResponse('Bad Request', 400);
    if (errIsNum(error, -8)) {
      // A path conflict already counts as the resource existing; report a CONFLICT.
      return errorResponse('Conflict', 409);
    }
    if (errIsNum(error, -11)) {
      return errorResponse('Conflict', 409);
    }
    if (error instanceof TeraboxError && error.integrity) {
      // create() already replaced the old content upstream, so the cached
      // entry describes a file that no longer exists — drop it even though
      // the response is an error.
      await invalidateMeta(absPath, store);
      return errorResponse('Integrity check failed', 502);
    }
    throw error;
  }

  await invalidateMeta(absPath, store);
  return new Response(null, { status: existed ? 204 : 201 });
}

async function handleDelete(
  request: Request,
  client: TeraboxClient,
  store: DavStore,
  absPath: string,
  mount: Mount,
): Promise<Response> {
  if (mount.isRoot(absPath) || absPath === '') return errorResponse('Forbidden', 403);
  const resource = await statResourceFresh(client, absPath);
  if (!resource) return errorResponse('Not Found', 404);
  const pre = await checkMutationPreconditions(request, client, store, absPath, mount);
  if (pre) return pre;
  const memberLock = await enforceMemberLocks(request, store, absPath, resource.isDir);
  if (memberLock) return memberLock;
  await client.fileOperation('delete', [{ path: absPath }]);
  await safeRelocate(store, [{ src: absPath, mode: 'forget', recursive: resource.isDir }]);
  await invalidateMeta(absPath, store);
  return new Response(null, { status: 204 });
}

async function handleMoveCopy(
  request: Request,
  client: TeraboxClient,
  store: DavStore,
  srcPath: string,
  method: 'MOVE' | 'COPY',
  mount: Mount,
): Promise<Response> {
  const destinationHeader = request.headers.get('Destination');
  if (!destinationHeader) return errorResponse('Bad Request', 400);
  const rawDestination = destinationHeader.trim();
  let destDav: string;
  let destUrl: URL | null = null;
  try {
    destUrl = new URL(rawDestination);
    destDav = decodePathname(destUrl.pathname);
  } catch {
    // RFC 4918 §10.3: an absolute-path Destination (no scheme/host) is legal.
    if (!rawDestination.startsWith('/')) return errorResponse('Bad Request', 400);
    try {
      // Query and fragment are not path components (RFC 3986 §3.4/§3.5):
      // keeping them would silently create a node literally named
      // `/moved.txt?x=1` while the client looks for `/moved.txt`.
      destDav = decodePathname(rawDestination.split(/[?#]/, 1)[0]!);
    } catch {
      return errorResponse('Bad Request', 400);
    }
  }
  // RFC 4918 §10.3 contemplates 502 when the Destination names another
  // server. Silently treating a foreign host as a local path would move the
  // file somewhere the client never asked for and hide the bug entirely.
  if (destUrl && destUrl.host !== new URL(request.url).host) {
    return errorResponse('Destination on another server', 502);
  }
  // The Destination carries the base path like any other URL; a target
  // outside the mounted surface is not ours to write to.
  // `new URL('//other.host/x')` throws without a base: a protocol-relative
  // reference names ANOTHER origin, and the path branch below would treat
  // `/other.host/x` as a local path — moving the file somewhere the client
  // never asked for and bypassing the foreign-host check entirely.
  if (!destUrl && rawDestination.startsWith('//')) {
    const resolved = new URL(rawDestination, request.url);
    if (resolved.host !== new URL(request.url).host) {
      return errorResponse('Destination on another server', 502);
    }
    destDav = decodePathname(resolved.pathname);
  }
  if (mount.base) {
    if (destDav === mount.base) destDav = '/';
    else if (destDav.startsWith(mount.base + '/')) destDav = destDav.slice(mount.base.length);
    else return errorResponse('Not Found', 404);
  }
  if (destDav.length > 1 && destDav.endsWith('/')) destDav = destDav.slice(0, -1);
  if (isReservedDavSegment(destDav)) return errorResponse('Forbidden', 403);
  // The destination of a MOVE/COPY is a write: emoji names would be
  // refused upstream (-7), so they arrive stripped.
  const destPath = mount.toTera(upstreamSafeDavPath(destDav));
  if (mount.isRoot(destPath) || destPath === '') return errorResponse('Forbidden', 403);

  const overwrite = (request.headers.get('Overwrite') || 'T').toUpperCase() === 'T';
  const same = joinPath(srcPath) === joinPath(destPath);

  // The mounted surface itself is not a movable/copiable resource — without
  // this, a root source reaches the containment test below as `/`, whose
  // prefix becomes `//`, so no destination is ever recognised as a member.
  if (mount.isRoot(srcPath) || srcPath === '') return errorResponse('Forbidden', 403);

  if (same) {
    if (method === 'MOVE') return new Response(null, { status: 204 });
    return errorResponse('Forbidden', 403);
  }

  const srcResource = await statResourceFresh(client, srcPath);
  if (!srcResource) return errorResponse('Not Found', 404);

  // RFC 4918 §9.9.3/§9.9.4: a collection must not be copied or moved into
  // its own descendant tree — Terabox would either duplicate the tree
  // server-side or loop, so reject before touching the API. The reverse
  // direction matters just as much: a destination that is an ANCESTOR of
  // the source is an existing collection, so Overwrite: T would pre-delete
  // that subtree first — destroying the source along with it — and then
  // fail the move. Answer 409 before anything is removed.
  {
    const srcNorm = joinPath(srcPath);
    const destNorm = joinPath(destPath);
    if (destNorm === '/' || srcNorm === '/' || destNorm.startsWith(srcNorm + '/') ||
        srcNorm.startsWith(destNorm + '/')) {
      return errorResponse('Conflict', 409);
    }
  }

  // `If` conditions always target the request resource. A lock on the
  // source blocks MOVE but never COPY — copying a locked resource without
  // its token is fine (litmus locks/copy), overwriting a locked target is
  // not, so the destination is enforced separately for both methods.
  const pre = await checkMutationPreconditions(request, client, store, srcPath, mount, {
    enforce: method === 'MOVE',
  });
  if (pre) return pre;
  // MOVE relocates the whole tree: locked members block it without their
  // tokens. COPY only reads them, so their locks do not apply.
  if (method === 'MOVE') {
    const srcMembers = await enforceMemberLocks(request, store, srcPath, srcResource.isDir);
    if (srcMembers) return srcMembers;
  }

  const destResource = await statResourceFresh(client, destPath);
  const destLock = await enforceWrite(request, store, destPath);
  if (destLock) return destLock;
  if (destResource && !overwrite) return errorResponse('Precondition Failed', 412);
  // Overwrite pre-deletes the destination tree (both methods): its locked
  // members need their tokens even though no `If` names them.
  if (destResource) {
    const destMembers = await enforceMemberLocks(request, store, destPath, destResource.isDir);
    if (destMembers) return destMembers;
  }

  // RFC 4918 §9.9.3: the destination's parent collection must exist (409).
  const parentCheck = await requireParent(client, destPath);
  if (parentCheck) return parentCheck;

  if (destResource) {
    // Terabox's filemanager refuses to replace an existing target: `ondup`
    // is documented but ignored server-side (live answers -8 "The file
    // already exists"; bclone never sets it either). WebDAV Overwrite: T
    // therefore clears the target first — if the move then fails, the old
    // node is recoverable from the recycle bin, never destroyed.
    await client.fileOperation('delete', [{ path: destPath }]);
    await safeRelocate(store, [{ src: destPath, mode: 'forget', recursive: destResource.isDir }]);
    // One generation bump for the whole MOVE/COPY is enough (see invalidateMeta).
    await invalidateMeta(destPath, store, false);
  }

  const recursive = srcResource.isDir;
  const depthHeader = (request.headers.get('Depth') || '').toLowerCase();
  if (method === 'COPY' && recursive && depthHeader === '0') {
    // Depth: 0 on a collection: only the (empty) collection is created,
    // never its members (litmus copy_shallow).
    await client.mkdir(destPath);
    await safeRelocate(store, [{ src: srcPath, dest: destPath, mode: 'copy', recursive: false }]);
    await invalidateMeta(destPath, store);
    return new Response(null, { status: destResource && overwrite ? 204 : 201 });
  }

  const { dir, base } = splitPath(destPath);
  await client.fileOperation(method === 'MOVE' ? 'move' : 'copy', [
    {
      path: srcPath,
      dest: dir === '/' ? '/' : dir,
      newname: base,
    },
  ]);

  await safeRelocate(store, [
    {
      src: srcPath,
      dest: destPath,
      mode: method === 'MOVE' ? 'move' : 'copy',
      // Locks move with the resource on MOVE; a COPY never carries locks.
      withLocks: method === 'MOVE',
      recursive,
    },
  ]);

  await invalidateMeta(srcPath, store, false);
  await invalidateMeta(destPath, store);
  return new Response(null, { status: destResource && overwrite ? 204 : 201 });
}

/**
 * LOCK: real lock records in the state store (Durable Object when bound —
 * one serialized instance for the whole account, so every isolate agrees).
 * Refreshes extend the matched record, including a refresh aimed at a child
 * of an Infinity-locked collection; an already-locked resource rejects
 * non-owners with 423; a shared lock only stacks on other shared locks.
 */
async function handleLock(
  request: Request,
  client: TeraboxClient,
  store: DavStore,
  absPath: string,
  mount: Mount,
): Promise<Response> {
  if (mount.isRoot(absPath) || absPath === '') return errorResponse('Forbidden', 403);
  const body = await readTextCapped(request);
  if (body === null) return errorResponse('Payload Too Large', 413);
  // A Resource-Tag (`<http://host/x>`, RFC 4918 §10.4.1) is not a lock
  // token: it must not satisfy the gates below, or a body-less LOCK would
  // mint a brand-new lock (§9.10.1 makes a body-less LOCK a refresh, and a
  // refresh needs an actual lock token). Only paren-list terms are
  // presented tokens; the old `scheme://` text filter missed relative tags
  // like `</a>`. A malformed If answers 400 here, like every other method.
  const ifHeader = request.headers.get('If');
  // An absent AND an empty `If:` header are both "no If header" — PUT has
  // always ignored `If:` with an empty value (`if (ifHeader)` truthiness);
  // LOCK must not 400 where PUT skips, so parse only non-empty values.
  const parsedIf = ifHeader ? parseIfHeader(ifHeader) : [];
  if (parsedIf === null) return errorResponse('Bad Request', 400);
  const presentedLocks = parsedIf.flatMap((list) =>
    list.terms
      // A negated term is never a refresh credential: `If: (Not <T>)`
      // asserts T does NOT lock this resource, so feeding T (when it
      // DOES lock) into the gate below would let `Not` polarity invert
      // into a successful refresh (RFC 4918 §10.4.1). Etag terms are
      // conditions, not credentials, and are likewise dropped here —
      // the create path below evaluates the whole header properly.
      .filter((t) => t.kind === 'token' && !t.negated)
      .map((t) => t.value)
      // A scheme://-shaped value is a Resource-Tag / URL name (§10.4.1),
      // never a lock token — same exclusion the old text filter applied,
      // now after the parse so relative tags reach the refresh check
      // below instead of sneaking past the body-less gate as tokens.
      .filter((value) => !/^[a-z][a-z0-9+.-]*:\/\//i.test(value)),
  );
  // RFC 4918 §9.10: a LOCK body is XML; validate it exactly like PROPFIND /
  // PROPPATCH. Without this a client could persist ill-formed markup as the
  // lock owner and break every other client's lockdiscovery PROPFIND 207.
  if (body.trim()) {
    const xmlError = validateXml(body);
    if (xmlError) return errorResponse(`Invalid XML: ${xmlError}`, 400);
    // RFC 4918 §9.10.1: a body-carrying LOCK creates a lock, so lockscope
    // is REQUIRED — even when an If header is present (a refresh carries
    // no body). Previously an If presence skipped this check and minted a
    // default exclusive lock the client never asked for (the same
    // grant-it-anyway flaw the missing-scope 400 exists to prevent).
    const scopeBlock = body.match(
      /<(?:[A-Za-z_][\w.-]*:)?lockscope(?:\s[^>]*)?>[\s\S]*?<\/(?:[A-Za-z_][\w.-]*:)?lockscope\s*>/,
    );
    if (!scopeBlock) return errorResponse('lockscope missing', 400);
    // §10.4 / §6: a create-LOCK is subject to If (and If-Match/If-None-
    // Match) exactly like every other mutating method — evaluate with the
    // shared evaluator, enforcement off (locking itself is handled below
    // by lockAcquire). Without this a false condition (`If: (["stale"])`,
    // `(<DAV:no-lock>)`) minted the lock anyway while PUT answered 412.
    const pre = await checkMutationPreconditions(
      request,
      client,
      store,
      absPath,
      mount,
      { enforce: false, lockSemantics: true },
    );
    if (pre) return pre;
  } else if (!ifHeader) {
    return errorResponse('lockinfo body required', 400);
  } else if (presentedLocks.length === 0) {
    // The client sent an If condition but it yielded no usable refresh
    // credential (etag terms only, Resource-Tags, negated-only lists):
    // the precondition for a body-less refresh is unmet → §9.10.6 412.
    // A 400 here claimed "malformed request" for a well-formed header —
    // PUT answers 412 for exactly these shapes.
    return errorResponse('Precondition Failed', 412);
  } else {
    // §9.10.1: a body-less LOCK is a refresh, never a create. A presented
    // token that applies to no live lock covering this URI is not a valid
    // refresh credential — without this check the acquire path below would
    // mint a brand-new lock from a bare `If: </relative>` or a bogus token.
    // `applies` (not `recordTokens`) is the right membership: on the memory
    // fallback it carries the never-brick volatile grace, exactly what PUT
    // enforcement honors, so the same token that may write a locked file
    // may also refresh it after its record was lost to an isolate rotation.
    // KNOWN RESIDUAL (memory fallback only): the grace verifies by pattern
    // (uuid + expiry, isOurUnexpiredToken), so on the record-less memory
    // store a CLIENT-FORGED pattern-token is indistinguishable from a real
    // one whose record was lost — both re-establish via lockAcquire. That
    // is inherent to pattern-grace; production always binds DAV_STATE
    // (volatile=false → applies ⊆ recordTokens → forged → 412, pinned in
    // test/davstate.test.ts "well-formed never-issued token on the DO path").
    // RFC 4918 §9.10.6: this mismatch is the `lock-token-matches-request-uri`
    // precondition — the status is 412, not 409 (409 is UNLOCK's
    // `lock-token-matches-lock-discovery` and the missing-intermediate case).
    const refresh = await store.checkTokens(absPath, presentedLocks);
    if (refresh.applies.length === 0) {
      return errorResponse('Precondition Failed', 412);
    }
  }
  const resource = await statResource(client, absPath);

  const timeout = request.headers.get('Timeout') || '';
  const secondsText = timeout.match(/Second-(\d+)/i)?.[1];
  const seconds = secondsText
    ? Math.min(Math.max(parseInt(secondsText, 10), 1), 604800)
    : 3600;

  const scopeBlock = body.match(
    /<(?:[A-Za-z_][\w.-]*:)?lockscope(?:\s[^>]*)?>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?lockscope\s*>/,
  );
  // Prefixes may contain '-' and '.' (XML NameChar), which the old
  // `[A-Za-z0-9_]*` class missed — such a shared request was granted as
  // EXCLUSIVE, wedging every other client's shared lock.
  const shared = /<(?:[A-Za-z_][\w.-]*:)?shared(?:\s[^>]*)?\/?>/.test(scopeBlock?.[1] ?? '');
  const ownerBlock = body.match(
    /<(?:[A-Za-z0-9_]+:)?owner(?:\s[^>]*)?>([\s\S]*?)<\/(?:[A-Za-z0-9_]+:)?owner\s*>/,
  );
  let owner = ownerBlock?.[1] ?? '';
  // Owner markup is re-emitted inside our own <D:owner> in every later
  // lockdiscovery — hoist any prefix the client declared higher up in the
  // request body into the fragment itself so it stays self-contained.
  if (owner.includes('<')) owner = selfContain(owner, collectXmlScope(body));
  // RFC 4918 §9.10.3: Depth on LOCK must be "0" or "infinity" — any other
  // value MUST NOT be used, and silently widening it to Infinity would hand
  // out a hierarchy-wide lock the client never asked for. Absent = infinity
  // (the RFC default for LOCK).
  const rawDepth = request.headers.get('Depth');
  let depth: '0' | 'Infinity';
  if (rawDepth === null) {
    depth = 'Infinity';
  } else {
    const d = rawDepth.trim().toLowerCase();
    if (d !== '0' && d !== 'infinity') {
      return errorResponse('Depth on LOCK must be 0 or infinity', 400);
    }
    depth = d === '0' ? '0' : 'Infinity';
  }

  let outcome: LockOutcome;
  try {
    outcome = await store.lockAcquire(absPath, {
      shared,
      depth,
      owner,
      presented: presentedLocks,
      seconds,
      rootHref: encodeHref(mount.href(absPath), resource?.isDir ?? false),
    });
  } catch (err) {
    // Advisory-state safety cap (see DavLimitError): 507, RFC 4918 §7.1.
    if (err instanceof DavLimitError) return errorResponse('Insufficient Storage', 507);
    throw err;
  }
  if (!outcome.ok) {
    // §9.10.6: an If naming a lock that does not cover this URI is a failed
    // precondition (412); an actual lock conflict is 423. Preconditions are
    // evaluated first, exactly as on PUT.
    if (outcome.precondition) return errorResponse('Precondition Failed', 412);
    return errorResponse('Locked', 423);
  }
  if (!outcome.record) return errorResponse('Internal Server Error', 500);

  return lockResponse(
    outcome.record,
    outcome.refreshed || resource ? 200 : 201,
    encodeHref(mount.href(absPath), resource?.isDir ?? false),
  );
}

function lockResponse(rec: LockRecord, status: number, href: string): Response {
  const xml =
    `<?xml version="1.0" encoding="utf-8"?>` +
    `<D:prop xmlns:D="${DAV_NS}"><D:lockdiscovery>${activelockXml(rec, href)}</D:lockdiscovery></D:prop>`;
  return new Response(xml, {
    status,
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Lock-Token': `<${rec.token}>`,
      'Cache-Control': 'no-store',
    },
  });
}

/** UNLOCK removes exactly the token named in Lock-Token (RFC 4918 §9.11). */
async function handleUnlock(request: Request, store: DavStore, absPath: string): Promise<Response> {
  const header = request.headers.get('Lock-Token') || '';
  const token = header.match(/<([^<>\s]+)>/)?.[1];
  if (!token) return errorResponse('Bad Request', 400);
  const outcome = await store.unlock(absPath, token);
  // 'lapsed' = our own still-valid token with no record left (rotation):
  // the lock is gone, so succeeding is the graceful answer. 'nomatch' —
  // a foreign or forged token — is a 409 per RFC 4918 §9.11.
  if (outcome === 'nomatch') {
    return errorResponse('Lock Token Does Not Match Any Lock on this Resource', 409);
  }
  return new Response(null, { status: 204 });
}

/**
 * PROPPATCH: sets/removes are applied to the dead-prop store (Durable
 * Object when bound) and echoed in a well-formed 207; PROPFIND then serves
 * the stored values (litmus propget). DAV live props are never patchable
 * (403 propstat).
 */
async function handleProppatch(
  request: Request,
  client: TeraboxClient,
  store: DavStore,
  absPath: string,
  mount: Mount,
): Promise<Response> {
  const body = await readTextCapped(request);
  if (body === null) return errorResponse('Payload Too Large', 413);
  if (body.trim()) {
    const xmlError = validateXml(body);
    if (xmlError) return errorResponse(`Invalid XML: ${xmlError}`, 400);
  }
  const resource = await statResource(client, absPath);
  if (!resource) return errorResponse('Not Found', 404);
  const pre = await checkMutationPreconditions(request, client, store, absPath, mount);
  if (pre) return pre;

  const scope = collectXmlScope(body);
  const ops: PropPatchOp[] = [];
  const propstats: string[] = [];
  // Capture the operation element's own namespace prefix: a dead property
  // named `set`/`remove` in ANOTHER namespace (`<X:set>…</X:set>` inside
  // <D:prop>) must not terminate the <D:set> block — the old prefix-agnostic
  // close match cut the stored markup in half (ill-formed markup surviving
  // as a dead prop). An operation's own close tag always shares its prefix.
  const opRe = /<(?:([A-Za-z_][\w.-]*):)?(set|remove)(?:\s[^>]*)?>/g;
  let om: RegExpExecArray | null;
  while ((om = opRe.exec(body)) !== null) {
    const prefix = (om[1] ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const op = om[2]!;
    const rest = body.slice(opRe.lastIndex);
    const closeRe = new RegExp(`</${prefix ? `${prefix}:` : ''}${op}\\s*>`);
    const cm = rest.match(closeRe);
    if (!cm || cm.index === undefined) continue;
    const inner = rest.slice(0, cm.index);
    opRe.lastIndex += cm.index + cm[0].length;
    const propOpen = inner.match(/<([A-Za-z_][\w.-]*:)?prop(?:\s[^>]*)?>/);
    if (!propOpen || propOpen.index === undefined) continue;
    const after = inner.slice(propOpen.index + propOpen[0].length);
    // Same prefix binding as parsePropfindBody: a property named `prop` in
    // another namespace must not cut the <D:prop> block short (the truncated
    // fragment is what gets STORED as the dead property).
    const propPfx = (propOpen[1] ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const propClose = after.match(new RegExp(`</${propPfx}prop\\s*>`));
    const fragment =
      propClose && propClose.index !== undefined ? after.slice(0, propClose.index) : after;
    const elements = parsePropElements(fragment, scope);
    const live: string[] = [];
    for (const el of elements) {
      // DAV live props are not dead properties: they can neither be set
      // nor removed (RFC 4918 §4.4).
      if (el.key.startsWith(`{${DAV_NS}}`)) {
        live.push(el.markup);
        continue;
      }
      ops.push({ op: op === 'set' ? 'set' : 'remove', key: el.key, markup: el.markup });
    }
    if (live.length > 0) {
      propstats.push(
        `<D:propstat><D:prop>${live.join('')}</D:prop>` +
          `<D:status>HTTP/1.1 403 Forbidden</D:status></D:propstat>`,
      );
    }
    const dead = elements.filter((el) => !el.key.startsWith(`{${DAV_NS}}`));
    if (dead.length > 0) {
      propstats.push(
        `<D:propstat><D:prop>${dead.map((el) => el.markup).join('')}</D:prop>` +
          `<D:status>HTTP/1.1 200 OK</D:status></D:propstat>`,
      );
    }
  }
  if (ops.length > 0) {
    try {
      await store.propPatch(absPath, ops);
    } catch (err) {
      // Advisory-state safety cap (see DavLimitError): 507, RFC 4918 §7.1.
      if (err instanceof DavLimitError) return errorResponse('Insufficient Storage', 507);
      throw err;
    }
  }
  if (propstats.length === 0) {
    propstats.push(`<D:propstat><D:prop/><D:status>HTTP/1.1 200 OK</D:status></D:propstat>`);
  }

  const href = encodeHref(mount.href(absPath), resource.isDir);
  const xml =
    `<?xml version="1.0" encoding="utf-8"?>` +
    `<D:multistatus xmlns:D="${DAV_NS}"><D:response><D:href>${xmlEscape(href)}</D:href>` +
    `${propstats.join('')}</D:response></D:multistatus>`;
  return new Response(xml, {
    status: 207,
    headers: { 'Content-Type': 'application/xml; charset="utf-8"', 'Cache-Control': 'no-store' },
  });
}

/**
 * RFC 4918 §9.3.1/§9.7.1/§9.9.3: MKCOL, PUT and MOVE/COPY targets need an
 * existing parent collection (409). Clients build the tree level by level.
 */
async function requireParent(client: TeraboxClient, absPath: string): Promise<Response | null> {
  const { dir } = splitPath(absPath);
  if (!dir || dir === '/' || dir === absPath) return null;
  const parent = await statResource(client, dir);
  if (!parent || !parent.isDir) return errorResponse('Conflict', 409);
  return null;
}

export function errorResponse(
  message: string,
  status: number,
  extra?: Record<string, unknown>,
  headers?: Record<string, string>,
): Response {
  return new Response(JSON.stringify({ error: message, ...extra }), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...headers,
    },
  });
}