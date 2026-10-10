import { TeraboxClient, TeraboxError, errIsNum } from './terabox';
import { joinPath, splitPath } from './sign';
import type { Dentry, TeraboxItem } from './types';

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

export function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** WebDAV href (URL-encoded, trailing slash for collections). */
export function encodeHref(path: string, isDir: boolean): string {
  const segments = String(path || '/').split('/').filter(Boolean).map(encodeURIComponent);
  if (segments.length === 0) return isDir ? '/' : '';
  return '/' + segments.join('/') + (isDir ? '/' : '');
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
      name = decodeURIComponent(segment.replace(/\+/g, '%20'));
    } catch {
      throw new TeraboxError(-9, 'Invalid path encoding');
    }
    parts.push(name);
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

async function itemToDentry(item: TeraboxItem): Promise<Dentry> {
  return {
    name: item.server_filename || '',
    path: item.path || '',
    isDir: (item.isdir || 0) > 0,
    size: item.size || 0,
    mtimeMs: (item.server_mtime || 0) * 1000,
    etag: item.md5 ? `"${item.md5}"` : `"${item.server_mtime}-${item.size}-${item.isdir}"`,
    contentType: (item.isdir || 0) > 0 ? 'httpd/unix-directory' : contentTypeFor(item.server_filename || ''),
  };
}

export interface DavResource {
  href: string;
  isDir: boolean;
  size: number;
  mtimeMs: number;
  etag: string;
  contentType: string;
}

async function statResource(client: TeraboxClient, absPath: string): Promise<Dentry | null> {
  try {
    const item = await client.itemInfo(absPath, false);
    return await itemToDentry(item);
  } catch (error) {
    if (errIsNum(error, -9)) return null;
    throw error;
  }
}

/** Advisory-lock support advertised in `supportedlock` (gdrive parity). */
const SUPPORTED_LOCK =
  '<D:supportedlock><D:lockentry><D:lockscope><D:exclusive/><D:shared/></D:lockscope>' +
  '<D:locktype><D:write/></D:locktype></D:lockentry></D:supportedlock>';

/** Live DAV props this server can answer, keyed by local name. */
const LIVE_PROPS: Record<string, (r: DavResource) => string> = {
  resourcetype: (r) => `<D:resourcetype>${r.isDir ? '<D:collection/>' : ''}</D:resourcetype>`,
  getcontentlength: (r) => `<D:getcontentlength>${r.size}</D:getcontentlength>`,
  getcontenttype: (r) => `<D:getcontenttype>${xmlEscape(r.contentType)}</D:getcontenttype>`,
  getlastmodified: (r) => `<D:getlastmodified>${rfc1123(r.mtimeMs)}</D:getlastmodified>`,
  getetag: (r) => `<D:getetag>${xmlEscape(r.etag)}</D:getetag>`,
  displayname: (r) => `<D:displayname>${xmlEscape(displayNameOf(r))}</D:displayname>`,
  creationdate: (r) => `<D:creationdate>${new Date(r.mtimeMs).toISOString()}</D:creationdate>`,
  ishidden: () => '<D:ishidden>0</D:ishidden>',
  supportedlock: () => SUPPORTED_LOCK,
  // Advisory locks only: no per-resource lock state exists.
  lockdiscovery: () => '<D:lockdiscovery/>',
};

/** Order used for allprop / the names-only view. */
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
  'lockdiscovery',
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

interface PropQuery {
  kind: 'all' | 'names' | 'list';
  /** local name → original element markup (404s echo the client's own XML). */
  requested: Map<string, string>;
}

/**
 * Parse a PROPFIND body without an XML parser (Workers have no DOMParser).
 * Unparseable/empty bodies fall back to allprop, which is always legal.
 */
export function parsePropfindBody(xml: string): PropQuery {
  const all: PropQuery = { kind: 'all', requested: new Map() };
  const body = xml.trim();
  if (!body) return all;
  if (/<(?:[A-Za-z0-9_]+:)?allprop[\s/>]/.test(body)) return all;
  if (/<(?:[A-Za-z0-9_]+:)?propname[\s/>]/.test(body)) {
    return { kind: 'names', requested: new Map() };
  }
  // First <...prop> element (the tag itself: "propfind"/"propname" fail the
  // trailing ">" / whitespace requirement and can never match here).
  const open = body.match(/<(?:[A-Za-z0-9_]+:)?prop(?:\s[^>]*)?>/);
  if (!open || open.index === undefined) return all;
  const inner = body.slice(open.index + open[0].length);
  const close = inner.match(/<\/(?:[A-Za-z0-9_]+:)?prop\s*>/);
  if (!close || close.index === undefined) return all;

  const fragment = inner.slice(0, close.index);
  const requested = new Map<string, string>();
  const openTag = /<([A-Za-z0-9_]+:)?([A-Za-z0-9_-]+)(\s[^>]*)?(\/?)>/g;
  let match: RegExpExecArray | null;
  while ((match = openTag.exec(fragment)) !== null) {
    const local = match[2];
    if (!local) continue;
    let original = match[0];
    if (match[4] !== '/') {
      // Container element: consume through its close tag so inner tags are
      // not mistaken for separate requests.
      const closeRe = new RegExp(`</${match[1] || ''}${local}\\s*>`);
      const rest = fragment.slice(openTag.lastIndex);
      const cm = rest.match(closeRe);
      if (cm && cm.index !== undefined) {
        original = match[0] + rest.slice(0, cm.index + cm[0].length);
        openTag.lastIndex += cm.index + cm[0].length;
      }
    }
    if (!requested.has(local)) requested.set(local, original);
  }
  if (requested.size === 0) return all;
  return { kind: 'list', requested };
}

function multistatus(resource: DavResource, children: DavResource[], query: PropQuery): Response {
  const parts: string[] = [];
  parts.push(`<?xml version="1.0" encoding="utf-8"?>`);
  parts.push(`<D:multistatus xmlns:D="${DAV_NS}">`);

  const emit = (r: DavResource) => {
    parts.push(`<D:response>`);
    parts.push(`<D:href>${xmlEscape(r.href)}</D:href>`);

    if (query.kind === 'all') {
      parts.push(`<D:propstat>`);
      parts.push(`<D:prop>`);
      for (const name of ALLPROP_ORDER) parts.push(LIVE_PROPS[name]?.(r) ?? '');
      parts.push(`</D:prop>`);
      parts.push(`<D:status>HTTP/1.1 200 OK</D:status>`);
      parts.push(`</D:propstat>`);
    } else if (query.kind === 'names') {
      parts.push(`<D:propstat>`);
      parts.push(`<D:prop>`);
      for (const name of ALLPROP_ORDER) parts.push(`<D:${name}/>`);
      parts.push(`</D:prop>`);
      parts.push(`<D:status>HTTP/1.1 200 OK</D:status>`);
      parts.push(`</D:propstat>`);
    } else {
      const ok: string[] = [];
      const missing: string[] = [];
      for (const [name, original] of query.requested) {
        const build = LIVE_PROPS[name];
        if (build) ok.push(build(r));
        else missing.push(original);
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
): Promise<Response> {
  const mount = makeMount(opts);
  const url = new URL(request.url);
  const method = request.method.toUpperCase();

  // Base path (gdrive parity): the surface only exists below `mount.base`.
  // The bare base redirects to its slash form; anything else outside 404s.
  let pathname = url.pathname;
  if (mount.base) {
    if (pathname === mount.base) {
      const redirect = new URL(request.url);
      redirect.pathname = mount.base + '/';
      return Response.redirect(redirect.toString(), 301);
    }
    if (!pathname.startsWith(mount.base + '/')) return errorResponse('Not Found', 404);
    pathname = pathname.slice(mount.base.length);
  }

  let davPath: string;
  try {
    davPath = decodePathname(pathname);
  } catch (error) {
    return errorResponse(error instanceof Error ? error.message : 'Bad Request', 400);
  }
  if (davPath.length > 1 && davPath.endsWith('/')) davPath = davPath.slice(0, -1);
  const absPath = mount.toTera(davPath);

  switch (method) {
    case 'OPTIONS':
      return new Response(null, {
        status: 204,
        headers: {
          Allow:
            'OPTIONS, PROPFIND, PROPPATCH, MKCOL, GET, HEAD, PUT, DELETE, COPY, MOVE, LOCK, UNLOCK',
          DAV: '1, 2',
          'MS-Author-Via': 'DAV',
        },
      });

    case 'PROPFIND':
      return handlePropfind(request, client, absPath, mount);

    case 'PROPPATCH':
      return handleProppatch(request, client, absPath, mount);

    case 'LOCK':
      return handleLock(request, client, absPath, mount);

    case 'UNLOCK':
      // Advisory locks (gdrive parity): unlock always succeeds.
      return new Response(null, { status: 204 });

    case 'MKCOL':
      return handleMkcol(request, client, absPath, mount);

    case 'GET':
    case 'HEAD':
      return handleGet(request, client, absPath, method === 'HEAD');

    case 'PUT':
      return handlePut(request, client, absPath, mount);

    case 'DELETE':
      return handleDelete(client, absPath, mount);

    case 'MOVE':
    case 'COPY':
      return handleMoveCopy(request, client, absPath, method, mount);

    default:
      return errorResponse('Method Not Allowed', 405);
  }
}

async function handlePropfind(
  request: Request,
  client: TeraboxClient,
  absPath: string,
  mount: Mount,
): Promise<Response> {
  const depth = request.headers.get('Depth') || '1';
  const query = parsePropfindBody(await request.text());
  const resource = await statResource(client, absPath);
  if (!resource) return errorResponse('Not Found', 404);

  const href = encodeHref(mount.href(absPath), resource.isDir);
  if (depth === '0') {
    return multistatus({ ...resource, href }, [], query);
  }

  // Depth "1" and anything else (infinity/missing) → children only.
  if (absPath !== '/' && !resource.isDir) {
    return multistatus({ ...resource, href }, [], query);
  }
  if (absPath === '/' && !resource.isDir) {
    // Should not happen: the root is always a collection.
    return multistatus({ ...resource, href }, [], query);
  }

  let children: DavResource[] = [];
  try {
    const items = await client.list(absPath === '/' ? '/' : absPath);
    children = await Promise.all(
      items.map(async (item) => {
        const dent = await itemToDentry(item);
        return { ...dent, href: encodeHref(mount.href(joinPath(absPath, dent.name)), dent.isDir) };
      }),
    );
  } catch (error) {
    if (errIsNum(error, -9)) return errorResponse('Not Found', 404);
    throw error;
  }

  return multistatus({ ...resource, href, isDir: true }, children, query);
}

async function handleMkcol(
  request: Request,
  client: TeraboxClient,
  absPath: string,
  mount: Mount,
): Promise<Response> {
  if (mount.isRoot(absPath) || absPath === '') return errorResponse('Forbidden', 403);
  // RFC 4918 §9.3.1: a non-empty MKCOL body must be refused with 415
  // (litmus checks this), not silently ignored.
  const body = await request.text();
  if (body.length > 0) return errorResponse('Unsupported Media Type', 415);
  try {
    const existing = await statResource(client, absPath);
    if (existing) {
      return new Response(
        '<D:error xmlns:D="DAV:"><D:exception>MethodNotAllowed</D:exception>' +
          '<D:message>The resource you tried to create already exists</D:message></D:error>',
        { status: 405, headers: { 'Content-Type': 'application/xml; charset=utf-8', Allow: 'GET, HEAD, DELETE, MOVE, COPY' } },
      );
    }
    await client.mkdir(absPath);
    return new Response(null, { status: 201 });
  } catch (error) {
    if (errIsNum(error, -8)) return errorResponse('Method Not Allowed', 405);
    throw error;
  }
}

async function handleGet(request: Request, client: TeraboxClient, absPath: string, isHead: boolean): Promise<Response> {
  let item;
  try {
    item = await client.itemInfo(absPath, true);
  } catch (error) {
    if (errIsNum(error, -9)) return errorResponse('Not Found', 404);
    throw error;
  }
  if ((item.isdir || 0) > 0) return errorResponse('Method Not Allowed', 405);

  const lastModifiedMs = (item.server_mtime || 0) * 1000;
  const headers = new Headers({
    'Content-Type': contentTypeFor(item.server_filename || ''),
    'Last-Modified': rfc1123(lastModifiedMs),
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
  });
  const etag = item.md5 ? `"${item.md5}"` : null;
  if (etag) headers.set('ETag', etag);

  // Conditional GET: validators answer before a download link is minted.
  const inm = request.headers.get('If-None-Match');
  if (inm && etag) {
    const tags = inm.split(',').map((tag) => tag.trim());
    if (inm.trim() === '*' || tags.includes(etag) || tags.includes(`W/${etag}`)) {
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
          ...(etag ? { ETag: etag } : {}),
          'Cache-Control': 'no-store',
        },
      });
    }
  }

  let range = request.headers.get('Range');
  const ifRange = request.headers.get('If-Range');
  if (range && ifRange) {
    // RFC 7233 §3.2: a stale If-Range validator means "send it all".
    const fresh = ifRange.includes('"')
      ? ifRange === etag
      : !Number.isNaN(Date.parse(ifRange)) && lastModifiedMs <= Date.parse(ifRange);
    if (!fresh) range = null;
  }
  if (range) {
    // Validate against the size itemInfo already gave us: an unsatisfiable
    // range answers 416 authoritatively without touching the ladder. (The
    // CDN verdict for out-of-bounds ranges varies by cluster — some answer
    // 400141 gates — and the fallback dlinks are gated anyway.) Anything we
    // can't parse is ignored and the full entity is served (RFC 7233 §3.1).
    const spec = /^bytes=(\d*)-(\d*)$/.exec(range);
    const size = item.size || 0;
    let unsatisfiable = false;
    if (!spec || (spec[1] === '' && spec[2] === '')) {
      range = null;
    } else if (spec[1] === '') {
      const suffix = Number(spec[2]);
      unsatisfiable = suffix === 0 || size === 0;
    } else {
      unsatisfiable = Number(spec[1]) >= size;
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
  }

  let lastError: unknown = new TeraboxError(-5, 'No usable download link');
  /** Try one candidate; resolves the ready-to-stream Response or records why it failed. */
  const tryUrl = async (downloadUrl: string): Promise<Response | undefined> => {
    try {
      // Paced, cookie-authenticated stream fetch: retries a jsToken gate once
      // and raises an errno-shaped body as TeraboxError instead of streaming it.
      const upstream = await client.fetchDownload(downloadUrl, range);
      if (upstream.status === 416) {
        // Range not satisfiable: pass the CDN's verdict through instead of
        // burning the remaining ladder phases on ranges it will also refuse.
        const contentRange = upstream.headers.get('Content-Range');
        if (contentRange) headers.set('Content-Range', contentRange);
        const contentLength = upstream.headers.get('Content-Length');
        if (contentLength) headers.set('Content-Length', contentLength);
        return new Response(upstream.body, { status: 416, headers });
      }
      if (!upstream.ok && upstream.status !== 206) {
        lastError = new TeraboxError(-5, `Terabox download http error ${upstream.status}`);
        return undefined;
      }

      const contentLength = upstream.headers.get('Content-Length');
      if (contentLength) headers.set('Content-Length', contentLength);
      if (range) {
        const contentRange = upstream.headers.get('Content-Range');
        if (contentRange) headers.set('Content-Range', contentRange);
      }
      if (isHead) return new Response(null, { status: upstream.status, headers });
      return new Response(upstream.body, { status: upstream.status, headers });
    } catch (error) {
      lastError = error;
      return undefined;
    }
  };

  // Phase 1: the PCS app-protocol route (mobile/desktop parity) — cookie in,
  // 302 straight to the CDN, no /file/<hash> dlink hop (that hop gates
  // datacenter IPs with 400141 "need verify"). No minting, so the happy path
  // costs a single upstream call.
  for (const url of client.pcsDownloadUrls(absPath)) {
    const res = await tryUrl(url);
    if (res) return res;
  }
  // Phase 2: the official /api/download dlink (token-bearing, Alist parity) —
  // minted lazily so the fast path never pays for home/info + sign.
  if (item.fs_id) {
    try {
      const official = await client.downloadLink(String(item.fs_id));
      if (official) {
        const res = await tryUrl(official);
        if (res) return res;
      }
    } catch {
      // official mint failed (sign/home info) — the filemetas dlink still may work
    }
  }
  // Phase 3: the plain filemetas dlink; every flavour gated rethrows the last error.
  if (item.dlink) {
    const res = await tryUrl(item.dlink);
    if (res) return res;
  }
  throw lastError;
}

async function handlePut(request: Request, client: TeraboxClient, absPath: string, mount: Mount): Promise<Response> {
  if (mount.isRoot(absPath) || absPath === '') return errorResponse('Forbidden', 403);

  const bytes = new Uint8Array(await request.arrayBuffer());
  const size = bytes.byteLength;

  // Create missing parents so clients that PUT without MKCOL work.
  await ensureParent(client, absPath);

  let existing: { isDir: boolean } | null = null;
  try {
    existing = await statResource(client, absPath);
  } catch {
    existing = null;
  }
  // PUT onto a collection is a method mismatch (RFC 7231 §6.5.5).
  if (existing && existing.isDir) return errorResponse('Method Not Allowed', 405);
  const existed = Boolean(existing);

  try {
    await client.upload(absPath, size, Date.now(), bytes, existed ? 3 : 0);
  } catch (error) {
    if (errIsNum(error, -8)) {
      // A path conflict already counts as the resource existing; report a CONFLICT.
      return errorResponse('Conflict', 409);
    }
    if (errIsNum(error, -11)) {
      return errorResponse('Conflict', 409);
    }
    throw error;
  }

  return new Response(null, { status: existed ? 204 : 201 });
}

async function handleDelete(client: TeraboxClient, absPath: string, mount: Mount): Promise<Response> {
  if (mount.isRoot(absPath) || absPath === '') return errorResponse('Forbidden', 403);
  const resource = await statResource(client, absPath);
  if (!resource) return errorResponse('Not Found', 404);
  await client.fileOperation('delete', [{ path: absPath }]);
  return new Response(null, { status: 204 });
}

async function handleMoveCopy(
  request: Request,
  client: TeraboxClient,
  srcPath: string,
  method: 'MOVE' | 'COPY',
  mount: Mount,
): Promise<Response> {
  const destinationHeader = request.headers.get('Destination');
  if (!destinationHeader) return errorResponse('Bad Request', 400);
  let destDav: string;
  try {
    destDav = decodePathname(new URL(destinationHeader).pathname);
  } catch {
    return errorResponse('Bad Request', 400);
  }
  // The Destination carries the base path like any other URL; a target
  // outside the mounted surface is not ours to write to.
  if (mount.base) {
    if (destDav === mount.base) destDav = '/';
    else if (destDav.startsWith(mount.base + '/')) destDav = destDav.slice(mount.base.length);
    else return errorResponse('Not Found', 404);
  }
  if (destDav.length > 1 && destDav.endsWith('/')) destDav = destDav.slice(0, -1);
  const destPath = mount.toTera(destDav);
  if (mount.isRoot(destPath) || destPath === '') return errorResponse('Forbidden', 403);

  const overwrite = (request.headers.get('Overwrite') || 'T').toUpperCase() === 'T';
  const same = joinPath(srcPath) === joinPath(destPath);

  if (same) {
    if (method === 'MOVE') return new Response(null, { status: 204 });
    return errorResponse('Forbidden', 403);
  }

  const srcResource = await statResource(client, srcPath);
  if (!srcResource) return errorResponse('Not Found', 404);

  const destResource = await statResource(client, destPath);
  if (destResource && !overwrite) return errorResponse('Precondition Failed', 412);

  if (destResource) {
    // Terabox's filemanager refuses to replace an existing target: `ondup`
    // is documented but ignored server-side (live answers -8 "The file
    // already exists"; bclone never sets it either). WebDAV Overwrite: T
    // therefore clears the target first — if the move then fails, the old
    // node is recoverable from the recycle bin, never destroyed.
    await client.fileOperation('delete', [{ path: destPath }]);
  }

  await ensureParent(client, destPath);

  const { dir, base } = splitPath(destPath);
  await client.fileOperation(method === 'MOVE' ? 'move' : 'copy', [
    {
      path: srcPath,
      dest: dir === '/' ? '/' : dir,
      newname: base,
    },
  ]);

  return new Response(null, { status: destResource && overwrite ? 204 : 201 });
}

/**
 * Advisory LOCK (gdrive parity): acquire, refresh and discovery always
 * succeed — enforcement would need lock state shared across isolates, which
 * this stateless worker does not pretend to have. Clients that LOCK a name
 * before their first PUT get a lock-null-style 201.
 */
async function handleLock(
  request: Request,
  client: TeraboxClient,
  absPath: string,
  mount: Mount,
): Promise<Response> {
  if (mount.isRoot(absPath) || absPath === '') return errorResponse('Forbidden', 403);
  const body = await request.text();
  const resource = await statResource(client, absPath);

  // Refresh: the client presents its token in If; hand back the same one.
  const ifHeader = request.headers.get('If') || '';
  const reused = ifHeader.match(/<(opaquelocktoken:[^<>\s]+|urn:uuid:[^<>\s]+)>/);
  const token = reused?.[1] ?? `opaquelocktoken:${crypto.randomUUID()}`;

  const timeout = request.headers.get('Timeout') || '';
  const secondsText = timeout.match(/Second-(\d+)/i)?.[1];
  const seconds = secondsText
    ? Math.min(Math.max(parseInt(secondsText, 10), 1), 604800)
    : 3600;

  const scopeBlock = body.match(
    /<(?:[A-Za-z0-9_]+:)?lockscope(?:\s[^>]*)?>([\s\S]*?)<\/(?:[A-Za-z0-9_]+:)?lockscope\s*>/,
  );
  const shared = /(?:^|<)[A-Za-z0-9_]*:?shared[\s/>]/.test(scopeBlock?.[1] ?? '');
  const ownerBlock = body.match(
    /<(?:[A-Za-z0-9_]+:)?owner(?:\s[^>]*)?>([\s\S]*?)<\/(?:[A-Za-z0-9_]+:)?owner\s*>/,
  );
  const owner = ownerBlock?.[1] ?? '';
  const depth = (request.headers.get('Depth') || '').toLowerCase() === '0' ? '0' : 'Infinity';

  const xml =
    `<?xml version="1.0" encoding="utf-8"?>` +
    `<D:prop xmlns:D="${DAV_NS}"><D:lockdiscovery><D:activelock>` +
    `<D:locktype><D:write/></D:locktype>` +
    `<D:lockscope>${shared ? '<D:shared/>' : '<D:exclusive/>'}</D:lockscope>` +
    `<D:depth>${depth}</D:depth>` +
    (owner ? `<D:owner>${owner}</D:owner>` : '') +
    `<D:timeout>Second-${seconds}</D:timeout>` +
    `<D:locktoken><D:href>${xmlEscape(token)}</D:href></D:locktoken>` +
    `</D:activelock></D:lockdiscovery></D:prop>`;

  return new Response(xml, {
    status: resource ? 200 : 201,
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Lock-Token': `<${token}>`,
      'Cache-Control': 'no-store',
    },
  });
}

/**
 * PROPPATCH: Terabox has nowhere to persist dead properties. Reply with a
 * well-formed 207 echoing the requested set/remove as 200 (gdrive parity —
 * what DAV clients expect from PROPPATCH regardless of class advertised).
 */
async function handleProppatch(
  request: Request,
  client: TeraboxClient,
  absPath: string,
  mount: Mount,
): Promise<Response> {
  const body = await request.text();
  const resource = await statResource(client, absPath);
  if (!resource) return errorResponse('Not Found', 404);

  const propInner = (tag: 'set' | 'remove'): string | null => {
    const block = body.match(
      new RegExp(
        `<(?:[A-Za-z0-9_]+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[A-Za-z0-9_]+:)?${tag}\\s*>`,
      ),
    );
    if (!block) return null;
    const prop = (block[1] ?? '').match(
      /<(?:[A-Za-z0-9_]+:)?prop(?:\s[^>]*)?>([\s\S]*?)<\/(?:[A-Za-z0-9_]+:)?prop\s*>/,
    );
    return prop?.[1] ?? '';
  };

  const propstats =
    [
      propInner('set'),
      propInner('remove'),
    ]
      .filter((inner): inner is string => inner !== null)
      .map(
        (inner) =>
          `<D:propstat><D:prop>${inner}</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>`,
      )
      .join('') ||
    `<D:propstat><D:prop/><D:status>HTTP/1.1 200 OK</D:status></D:propstat>`;

  const href = encodeHref(mount.href(absPath), resource.isDir);
  const xml =
    `<?xml version="1.0" encoding="utf-8"?>` +
    `<D:multistatus xmlns:D="${DAV_NS}"><D:response><D:href>${xmlEscape(href)}</D:href>` +
    `${propstats}</D:response></D:multistatus>`;
  return new Response(xml, {
    status: 207,
    headers: { 'Content-Type': 'application/xml; charset="utf-8"', 'Cache-Control': 'no-store' },
  });
}

/** Recursively create missing parents for absPath (ignoring "already exists"). */
async function ensureParent(client: TeraboxClient, absPath: string): Promise<void> {
  const { dir } = splitPath(absPath);
  if (!dir || dir === '/' || dir === '') return;

  const segments = dir.split('/').filter(Boolean);
  let cursor = '';
  for (const segment of segments) {
    cursor += '/' + segment;
    try {
      const existing = await statResource(client, cursor);
      if (existing) {
        if (!existing.isDir) throw new TeraboxError(-9, 'Parent is not a collection');
        continue;
      }
    } catch (error) {
      if (!errIsNum(error, -9)) throw error;
    }
    try {
      await client.mkdir(cursor);
    } catch (error) {
      if (!errIsNum(error, -8)) throw error;
    }
  }
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