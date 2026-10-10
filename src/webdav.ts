import { TeraboxClient, TeraboxError, errIsNum } from './terabox';
import { joinPath, splitPath } from './sign';
import {
  collectXmlScope,
  parsePropElements,
  validateXml,
  type PropElement,
} from './davxml';
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
  /** Terabox path backing this resource (dead props and locks key off it). */
  absPath: string;
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

/**
 * Per-isolate advisory state: real (in-memory) lock records and dead
 * properties. Sequential conformance clients such as litmus keep hitting
 * the same warm isolate, so this is enough to enforce and discover locks
 * and to store dead props; after isolate rotation the state is simply
 * gone — which only relaxes enforcement, never corrupts the account.
 * Self-issued tokens embed their expiry so a warm client's token stays
 * honoured across rotation (see isOurUnexpiredToken).
 */
interface LockRecord {
  token: string;
  scope: 'exclusive' | 'shared';
  /** RFC 4918 depth: "0" or "Infinity". */
  depth: string;
  /** Inner XML of the request's <owner> element. */
  owner: string;
  expiresAt: number;
}

const LOCKS = new Map<string, LockRecord[]>();
const DEAD_PROPS = new Map<string, Map<string, string>>();

/** Test hook: clear per-isolate advisory state between test cases. */
export function resetDavVolatileState(): void {
  LOCKS.clear();
  DEAD_PROPS.clear();
}

function purgeLocksAt(path: string): LockRecord[] {
  const records = LOCKS.get(path);
  if (!records) return [];
  const now = Date.now();
  const live = records.filter((r) => r.expiresAt > now);
  if (live.length > 0) LOCKS.set(path, live);
  else LOCKS.delete(path);
  return live;
}

/** Locks on the path itself, plus Infinity-depth locks on its ancestors. */
function applyingLocks(path: string): LockRecord[] {
  const now = Date.now();
  const out: LockRecord[] = [];
  for (const [lockedPath, records] of LOCKS) {
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

function isOurUnexpiredToken(token: string): boolean {
  const m = /^opaquelocktoken:[0-9a-fA-F-]{36}:(\d{13,})$/.exec(token);
  return m !== null && Number(m[1]) > Date.now();
}

function makeLockToken(seconds: number): string {
  return `opaquelocktoken:${crypto.randomUUID()}:${Date.now() + seconds * 1000}`;
}

function collectTokens(header: string | null): string[] {
  if (!header) return [];
  const tokens: string[] = [];
  for (const m of header.matchAll(/<([^<>\s]+)>/g)) {
    if (m[1] !== undefined) tokens.push(m[1]);
  }
  return tokens;
}

function tokenApplies(token: string, path: string): boolean {
  for (const rec of applyingLocks(path)) {
    if (rec.token === token) return true;
  }
  // A self-issued token whose embedded expiry has not passed still counts:
  // the record behind it may have been lost to isolate rotation, and
  // blocking a warm client's writes until it re-locks would be worse than
  // honouring the token it was given.
  return isOurUnexpiredToken(token);
}

/** RFC 4918 §6: writing a locked resource without its token is 423. */
function enforceLocks(request: Request, path: string): Response | null {
  const locks = applyingLocks(path);
  if (locks.length === 0) return null;
  const presented = collectTokens(request.headers.get('If'));
  if (locks.some((r) => presented.includes(r.token))) return null;
  return errorResponse('Locked', 423);
}

interface IfTerm {
  negated: boolean;
  kind: 'token' | 'etag';
  value: string;
}

/** Parse `If: (<token> [etag]) (Not <token2> [etag2])` into OR-ed lists. */
function parseIfHeader(header: string): IfTerm[][] | null {
  const lists: IfTerm[][] = [];
  const listRe = /\(([^()]*)\)/g;
  let lm: RegExpExecArray | null;
  while ((lm = listRe.exec(header)) !== null) {
    const terms: IfTerm[] = [];
    const termRe = /(Not\s+)?<([^>]*)>|\[([^\]]*)\]/g;
    let tm: RegExpExecArray | null;
    while ((tm = termRe.exec(lm[1] ?? '')) !== null) {
      if (tm[2] !== undefined) {
        terms.push({ negated: Boolean(tm[1]), kind: 'token', value: tm[2] });
      } else {
        terms.push({ negated: Boolean(tm[1]), kind: 'etag', value: tm[3] ?? '' });
      }
    }
    lists.push(terms);
  }
  return lists.length > 0 ? lists : null;
}

/**
 * Precondition gate for every mutating method: an unmet `If` answers 412
 * (or 423 when a submitted lock token does not match a live lock on an
 * already-locked resource, which is what mod_dav does and litmus expects),
 * then lock enforcement applies.
 */
async function checkMutationPreconditions(
  request: Request,
  client: TeraboxClient,
  path: string,
  opts?: { enforce?: boolean },
): Promise<Response | null> {
  const ifHeader = request.headers.get('If');
  if (ifHeader) {
    const lists = parseIfHeader(ifHeader);
    if (!lists) return errorResponse('Bad Request', 400);
    let anyTrue = false;
    const invalidTokens = new Set<string>();
    let etag: string | null | undefined;
    for (const terms of lists) {
      let listTrue = terms.length > 0;
      for (const term of terms) {
        let value: boolean;
        if (term.kind === 'token') {
          value = tokenApplies(term.value, path);
          if (!term.negated && !value) invalidTokens.add(term.value);
        } else {
          if (etag === undefined) {
            const dentry = await statResource(client, path);
            etag = dentry ? dentry.etag : null;
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
    // problem and answers 423.
    if (invalidTokens.size > 0) {
      const lockShaped = [...invalidTokens].some(
        (t) => t.startsWith('opaquelocktoken:') || t.startsWith('urn:uuid:'),
      );
      return lockShaped && applyingLocks(path).length > 0
        ? errorResponse('Locked', 423)
        : errorResponse('Precondition Failed', 412);
    }
    if (!anyTrue) return errorResponse('Precondition Failed', 412);
  }
  return opts?.enforce === false ? null : enforceLocks(request, path);
}

function activelockXml(rec: LockRecord): string {
  const seconds = Math.max(0, Math.floor((rec.expiresAt - Date.now()) / 1000));
  return (
    `<D:activelock>` +
    `<D:locktype><D:write/></D:locktype>` +
    `<D:lockscope><D:${rec.scope}/></D:lockscope>` +
    `<D:depth>${xmlEscape(rec.depth)}</D:depth>` +
    (rec.owner ? `<D:owner>${rec.owner}</D:owner>` : '') +
    `<D:timeout>Second-${seconds}</D:timeout>` +
    `<D:locktoken><D:href>${xmlEscape(rec.token)}</D:href></D:locktoken>` +
    `</D:activelock>`
  );
}

function lockdiscoveryMarkup(path: string): string {
  const records = purgeLocksAt(path);
  if (records.length === 0) return '<D:lockdiscovery/>';
  return `<D:lockdiscovery>${records.map(activelockXml).join('')}</D:lockdiscovery>`;
}

/** Drop advisory state for a removed path (and below it, for collections). */
function forgetAdvisory(path: string, recursive: boolean): void {
  DEAD_PROPS.delete(path);
  LOCKS.delete(path);
  if (!recursive) return;
  for (const key of [...DEAD_PROPS.keys()]) {
    if (key.startsWith(path + '/')) DEAD_PROPS.delete(key);
  }
  for (const key of [...LOCKS.keys()]) {
    if (key.startsWith(path + '/')) LOCKS.delete(key);
  }
}

/** Move (or copy) advisory state along with the resource. */
function rekeyAdvisory<T>(
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
  if (mode === 'move') {
    store.delete(src);
    if (recursive) {
      for (const key of [...store.keys()]) {
        if (key.startsWith(src + '/')) store.delete(key);
      }
    }
  }
  for (const [key, value] of relocated) store.set(key, value);
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
  const open = body.match(/<(?:[A-Za-z0-9_]+:)?prop(?:\s[^>]*)?>/);
  if (!open || open.index === undefined) return all;
  const inner = body.slice(open.index + open[0].length);
  const close = inner.match(/<\/(?:[A-Za-z0-9_]+:)?prop\s*>/);
  if (!close || close.index === undefined) return all;

  const requested = parsePropElements(inner.slice(0, close.index), collectXmlScope(body));
  if (requested.length === 0) return all;
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

function multistatus(resource: DavResource, children: DavResource[], query: PropQuery): Response {
  const parts: string[] = [];
  parts.push(`<?xml version="1.0" encoding="utf-8"?>`);
  parts.push(`<D:multistatus xmlns:D="${DAV_NS}">`);

  const emit = (r: DavResource) => {
    parts.push(`<D:response>`);
    parts.push(`<D:href>${xmlEscape(r.href)}</D:href>`);
    const dead = DEAD_PROPS.get(r.absPath);

    if (query.kind === 'all') {
      parts.push(`<D:propstat>`);
      parts.push(`<D:prop>`);
      for (const name of ALLPROP_ORDER) parts.push(STATIC_PROPS[name]?.(r) ?? '');
      parts.push(lockdiscoveryMarkup(r.absPath));
      if (dead) for (const markup of dead.values()) parts.push(markup);
      parts.push(`</D:prop>`);
      parts.push(`<D:status>HTTP/1.1 200 OK</D:status>`);
      parts.push(`</D:propstat>`);
    } else if (query.kind === 'names') {
      parts.push(`<D:propstat>`);
      parts.push(`<D:prop>`);
      for (const name of ALLPROP_ORDER) parts.push(`<D:${name}/>`);
      parts.push(`<D:lockdiscovery/>`);
      if (dead) for (const key of dead.keys()) parts.push(deadNameElement(key));
      parts.push(`</D:prop>`);
      parts.push(`<D:status>HTTP/1.1 200 OK</D:status>`);
      parts.push(`</D:propstat>`);
    } else {
      const ok: string[] = [];
      const missing: string[] = [];
      for (const el of query.requested) {
        if (el.key === `{${DAV_NS}}lockdiscovery`) {
          ok.push(lockdiscoveryMarkup(r.absPath));
          continue;
        }
        const build = el.key.startsWith(`{${DAV_NS}}`) ? STATIC_PROPS[el.local] : undefined;
        if (build) {
          ok.push(build(r));
          continue;
        }
        const stored = dead?.get(el.key);
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
      return handleUnlock(request, absPath);

    case 'MKCOL':
      return handleMkcol(request, client, absPath, mount);

    case 'GET':
    case 'HEAD':
      return handleGet(request, client, absPath, method === 'HEAD');

    case 'PUT':
      return handlePut(request, client, absPath, mount);

    case 'DELETE':
      return handleDelete(request, client, absPath, mount);

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
  const body = await request.text();
  if (body.trim()) {
    // RFC 4918 §9.1: a malformed or namespace-invalid body is a 400,
    // never a silent allprop (litmus propfind_invalid/propfind_invalid2).
    const xmlError = validateXml(body);
    if (xmlError) return errorResponse(`Invalid XML: ${xmlError}`, 400);
  }
  const query = parsePropfindBody(body);
  const resource = await statResource(client, absPath);
  if (!resource) return errorResponse('Not Found', 404);

  const href = encodeHref(mount.href(absPath), resource.isDir);
  if (depth === '0') {
    return multistatus({ ...resource, href, absPath }, [], query);
  }

  // Depth "1" and anything else (infinity/missing) → children only.
  if (absPath !== '/' && !resource.isDir) {
    return multistatus({ ...resource, href, absPath }, [], query);
  }
  if (absPath === '/' && !resource.isDir) {
    // Should not happen: the root is always a collection.
    return multistatus({ ...resource, href, absPath }, [], query);
  }

  let children: DavResource[] = [];
  try {
    const items = await client.list(absPath === '/' ? '/' : absPath);
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

  return multistatus({ ...resource, href, isDir: true, absPath }, children, query);
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
  const existing = await statResource(client, absPath);
  if (existing) {
    return new Response(
      '<D:error xmlns:D="DAV:"><D:exception>MethodNotAllowed</D:exception>' +
        '<D:message>The resource you tried to create already exists</D:message></D:error>',
      { status: 405, headers: { 'Content-Type': 'application/xml; charset=utf-8', Allow: 'GET, HEAD, DELETE, MOVE, COPY' } },
    );
  }
  // RFC 4918 §9.3.1: an intermediate collection must already exist (409).
  const parentCheck = await requireParent(client, absPath);
  if (parentCheck) return parentCheck;
  const locked = enforceLocks(request, absPath);
  if (locked) return locked;
  try {
    await client.mkdir(absPath);
  } catch (error) {
    if (errIsNum(error, -8)) return errorResponse('Method Not Allowed', 405);
    throw error;
  }
  return new Response(null, { status: 201 });
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

  const pre = await checkMutationPreconditions(request, client, absPath);
  if (pre) return pre;

  // RFC 4918 §9.7.1: creation needs existing intermediate collections (409).
  const parentCheck = await requireParent(client, absPath);
  if (parentCheck) return parentCheck;

  const bytes = new Uint8Array(await request.arrayBuffer());
  const size = bytes.byteLength;

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

async function handleDelete(
  request: Request,
  client: TeraboxClient,
  absPath: string,
  mount: Mount,
): Promise<Response> {
  if (mount.isRoot(absPath) || absPath === '') return errorResponse('Forbidden', 403);
  const resource = await statResource(client, absPath);
  if (!resource) return errorResponse('Not Found', 404);
  const pre = await checkMutationPreconditions(request, client, absPath);
  if (pre) return pre;
  await client.fileOperation('delete', [{ path: absPath }]);
  forgetAdvisory(absPath, resource.isDir);
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
  const rawDestination = destinationHeader.trim();
  let destDav: string;
  try {
    destDav = decodePathname(new URL(rawDestination).pathname);
  } catch {
    // RFC 4918 §10.3: an absolute-path Destination (no scheme/host) is legal.
    if (!rawDestination.startsWith('/')) return errorResponse('Bad Request', 400);
    try {
      destDav = decodePathname(rawDestination);
    } catch {
      return errorResponse('Bad Request', 400);
    }
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

  // `If` conditions always target the request resource. A lock on the
  // source blocks MOVE but never COPY — copying a locked resource without
  // its token is fine (litmus locks/copy), overwriting a locked target is
  // not, so the destination is enforced separately for both methods.
  const pre = await checkMutationPreconditions(request, client, srcPath, {
    enforce: method === 'MOVE',
  });
  if (pre) return pre;

  const destResource = await statResource(client, destPath);
  const destLock = enforceLocks(request, destPath);
  if (destLock) return destLock;
  if (destResource && !overwrite) return errorResponse('Precondition Failed', 412);

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
    forgetAdvisory(destPath, destResource.isDir);
  }

  const recursive = srcResource.isDir;
  const depthHeader = (request.headers.get('Depth') || '').toLowerCase();
  if (method === 'COPY' && recursive && depthHeader === '0') {
    // Depth: 0 on a collection: only the (empty) collection is created,
    // never its members (litmus copy_shallow).
    await client.mkdir(destPath);
    rekeyAdvisory(DEAD_PROPS, srcPath, destPath, 'copy', false);
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

  rekeyAdvisory(DEAD_PROPS, srcPath, destPath, method === 'MOVE' ? 'move' : 'copy', recursive);
  // Locks move with the resource on MOVE; a COPY never carries locks.
  if (method === 'MOVE') rekeyAdvisory(LOCKS, srcPath, destPath, 'move', recursive);

  return new Response(null, { status: destResource && overwrite ? 204 : 201 });
}

/**
 * LOCK: real (per-isolate) lock records. Refreshes extend the matched
 * record — including a refresh aimed at a child of an Infinity-locked
 * collection; an already-locked resource rejects non-owners with 423;
 * a shared lock only stacks on other shared locks.
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

  const presented = collectTokens(request.headers.get('If'));
  const now = Date.now();

  // Refresh: the presented token matches a lock on this resource or on an
  // Infinity-depth ancestor (litmus indirect_refresh) — extend it in place.
  const refreshable = applyingLocks(absPath).find((r) => presented.includes(r.token));
  if (refreshable) {
    refreshable.expiresAt = now + seconds * 1000;
    return lockResponse(refreshable, 200);
  }

  const existing = purgeLocksAt(absPath);
  if (existing.length > 0) {
    // Already locked and not the owner: an exclusive lock admits nothing
    // else, and a shared lock admits only further shared requests
    // (RFC 4918 §9.10.6).
    if (!shared || existing.some((r) => r.scope === 'exclusive')) {
      return errorResponse('Locked', 423);
    }
  }

  // Re-acquire the client's own still-valid token when its record was lost
  // to isolate rotation; any other presented token is ignored and a fresh
  // one minted.
  const token = presented.find(isOurUnexpiredToken) ?? makeLockToken(seconds);
  const record: LockRecord = {
    token,
    scope: shared ? 'shared' : 'exclusive',
    depth,
    owner,
    expiresAt: now + seconds * 1000,
  };
  const records = LOCKS.get(absPath) ?? [];
  records.push(record);
  LOCKS.set(absPath, records);

  return lockResponse(record, resource ? 200 : 201);
}

function lockResponse(rec: LockRecord, status: number): Response {
  const xml =
    `<?xml version="1.0" encoding="utf-8"?>` +
    `<D:prop xmlns:D="${DAV_NS}"><D:lockdiscovery>${activelockXml(rec)}</D:lockdiscovery></D:prop>`;
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
function handleUnlock(request: Request, absPath: string): Response {
  const header = request.headers.get('Lock-Token') || '';
  const token = header.match(/<([^<>\s]+)>/)?.[1];
  if (!token) return errorResponse('Bad Request', 400);
  const records = purgeLocksAt(absPath);
  const index = records.findIndex((r) => r.token === token);
  if (index === -1) {
    // A self-issued token whose record is gone (isolate rotation) means the
    // lock has already lapsed: succeeding is the graceful answer. Anything
    // else — a foreign or forged token — is a 409 per RFC 4918 §9.11.
    if (isOurUnexpiredToken(token)) return new Response(null, { status: 204 });
    return errorResponse('Lock Token Does Not Match Any Lock on this Resource', 409);
  }
  records.splice(index, 1);
  if (records.length > 0) LOCKS.set(absPath, records);
  else LOCKS.delete(absPath);
  return new Response(null, { status: 204 });
}

/**
 * PROPPATCH: sets/removes are applied to the per-isolate dead-prop store
 * and echoed in a well-formed 207; PROPFIND then serves the stored values
 * (litmus propget). DAV live props are never patchable (403 propstat).
 */
async function handleProppatch(
  request: Request,
  client: TeraboxClient,
  absPath: string,
  mount: Mount,
): Promise<Response> {
  const body = await request.text();
  if (body.trim()) {
    const xmlError = validateXml(body);
    if (xmlError) return errorResponse(`Invalid XML: ${xmlError}`, 400);
  }
  const resource = await statResource(client, absPath);
  if (!resource) return errorResponse('Not Found', 404);
  const pre = await checkMutationPreconditions(request, client, absPath);
  if (pre) return pre;

  const scope = collectXmlScope(body);
  const store = DEAD_PROPS.get(absPath) ?? new Map<string, string>();
  const propstats: string[] = [];
  const opRe = /<(?:[A-Za-z_][\w.-]*:)?(set|remove)(?:\s[^>]*)?>/g;
  let om: RegExpExecArray | null;
  while ((om = opRe.exec(body)) !== null) {
    const op = om[1];
    const rest = body.slice(opRe.lastIndex);
    const closeRe = new RegExp(`</(?:[A-Za-z_][\\w.-]*:)?${op}\\s*>`);
    const cm = rest.match(closeRe);
    if (!cm || cm.index === undefined) continue;
    const inner = rest.slice(0, cm.index);
    opRe.lastIndex += cm.index + cm[0].length;
    const propOpen = inner.match(/<(?:[A-Za-z_][\w.-]*:)?prop(?:\s[^>]*)?>/);
    if (!propOpen || propOpen.index === undefined) continue;
    const after = inner.slice(propOpen.index + propOpen[0].length);
    const propClose = after.match(/<\/(?:[A-Za-z_][\w.-]*:)?prop\s*>/);
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
      if (op === 'set') store.set(el.key, el.markup);
      else store.delete(el.key);
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
  if (store.size > 0) DEAD_PROPS.set(absPath, store);
  else DEAD_PROPS.delete(absPath);
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