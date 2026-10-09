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

function multistatus(resource: DavResource, children: DavResource[]): Response {
  const parts: string[] = [];
  parts.push(`<?xml version="1.0" encoding="utf-8"?>`);
  parts.push(`<D:multistatus xmlns:D="${DAV_NS}">`);

  const emit = (r: DavResource) => {
    parts.push(`<D:response>`);
    parts.push(`<D:href>${xmlEscape(r.href)}</D:href>`);
    parts.push(`<D:propstat>`);
    parts.push(`<D:prop>`);
    parts.push(
      `<D:resourcetype>${r.isDir ? '<D:collection/>' : ''}</D:resourcetype>` +
        `<D:getcontentlength>${r.size}</D:getcontentlength>` +
        `<D:getcontenttype>${xmlEscape(r.contentType)}</D:getcontenttype>` +
        `<D:getlastmodified>${rfc1123(r.mtimeMs)}</D:getlastmodified>` +
        `<D:getetag>${xmlEscape(r.etag)}</D:getetag>`,
    );
    parts.push(`</D:prop>`);
    parts.push(`<D:status>HTTP/1.1 200 OK</D:status>`);
    parts.push(`</D:propstat>`);
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
export async function handleWebDav(request: Request, client: TeraboxClient): Promise<Response> {
  const url = new URL(request.url);
  const method = request.method.toUpperCase();
  let absPath: string;
  try {
    absPath = decodePathname(url.pathname);
  } catch (error) {
    return errorResponse(error instanceof Error ? error.message : 'Bad Request', 400);
  }
  if (absPath.length > 1 && absPath.endsWith('/')) absPath = absPath.slice(0, -1);

  switch (method) {
    case 'OPTIONS':
      return new Response(null, {
        status: 204,
        headers: {
          Allow: 'OPTIONS, PROPFIND, MKCOL, GET, HEAD, PUT, DELETE, COPY, MOVE',
          DAV: '1, 2',
          'MS-Author-Via': 'DAV',
        },
      });

    case 'PROPFIND':
      return handlePropfind(request, client, url, absPath);

    case 'MKCOL':
      return handleMkcol(client, absPath);

    case 'GET':
    case 'HEAD':
      return handleGet(request, client, absPath, method === 'HEAD');

    case 'PUT':
      return handlePut(request, client, absPath);

    case 'DELETE':
      return handleDelete(client, absPath);

    case 'MOVE':
    case 'COPY':
      return handleMoveCopy(request, client, url, absPath, method);

    default:
      return errorResponse('Method Not Allowed', 405);
  }
}

async function handlePropfind(
  request: Request,
  client: TeraboxClient,
  url: URL,
  absPath: string,
): Promise<Response> {
  const depth = request.headers.get('Depth') || '1';
  const resource = await statResource(client, absPath);
  if (!resource) return errorResponse('Not Found', 404);

  const href = encodeHref(absPath, resource.isDir);
  if (depth === '0') {
    return multistatus({ ...resource, href }, []);
  }

  // Depth "1" and anything else (infinity/missing) → children only.
  if (absPath !== '/' && !resource.isDir) {
    return multistatus({ ...resource, href }, []);
  }
  if (absPath === '/' && !resource.isDir) {
    // Should not happen: the root is always a collection.
    return multistatus({ ...resource, href }, []);
  }

  let children: DavResource[] = [];
  try {
    const items = await client.list(absPath === '/' ? '/' : absPath);
    children = await Promise.all(
      items.map(async (item) => {
        const dent = await itemToDentry(item);
        return { ...dent, href: encodeHref(joinPath(absPath, dent.name), dent.isDir) };
      }),
    );
  } catch (error) {
    if (errIsNum(error, -9)) return errorResponse('Not Found', 404);
    throw error;
  }

  return multistatus({ ...resource, href, isDir: true }, children);
}

async function handleMkcol(client: TeraboxClient, absPath: string): Promise<Response> {
  if (absPath === '/' || absPath === '') return errorResponse('Forbidden', 403);
  try {
    const existing = await statResource(client, absPath);
    if (existing) return errorResponse('Method Not Allowed', 405);
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

  let downloadUrl = item.dlink || '';
  if (!downloadUrl) {
    downloadUrl = await client.downloadUrlFromId(String(item.fs_id));
  }
  if (!downloadUrl) return errorResponse('Gateway Timeout', 504);

  const headers = new Headers({
    'Content-Type': contentTypeFor(item.server_filename || ''),
    'Last-Modified': rfc1123((item.server_mtime || 0) * 1000),
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
  });
  if (item.md5) headers.set('ETag', `"${item.md5}"`);
  const range = request.headers.get('Range');
  // Paced, cookie-authenticated stream fetch: retries a jsToken gate once and
  // raises an errno-shaped body as TeraboxError instead of streaming it.
  const upstream = await client.fetchDownload(downloadUrl, range);
  if (!upstream.ok && upstream.status !== 206) {
    return errorResponse('Bad Gateway', 502);
  }

  const contentLength = upstream.headers.get('Content-Length');
  if (contentLength) headers.set('Content-Length', contentLength);
  if (range) {
    const contentRange = upstream.headers.get('Content-Range');
    if (contentRange) headers.set('Content-Range', contentRange);
  }
  if (isHead) return new Response(null, { status: upstream.status, headers });
  return new Response(upstream.body, { status: upstream.status, headers });
}

async function handlePut(request: Request, client: TeraboxClient, absPath: string): Promise<Response> {
  if (absPath === '/' || absPath === '') return errorResponse('Forbidden', 403);

  const bytes = new Uint8Array(await request.arrayBuffer());
  const size = bytes.byteLength;

  // Create missing parents so clients that PUT without MKCOL work.
  await ensureParent(client, absPath);

  let existed = false;
  try {
    const existing = await statResource(client, absPath);
    existed = Boolean(existing && !existing.isDir);
  } catch {
    existed = false;
  }

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

async function handleDelete(client: TeraboxClient, absPath: string): Promise<Response> {
  if (absPath === '/' || absPath === '') return errorResponse('Forbidden', 403);
  const resource = await statResource(client, absPath);
  if (!resource) return errorResponse('Not Found', 404);
  await client.fileOperation('delete', [{ path: absPath }]);
  return new Response(null, { status: 204 });
}

async function handleMoveCopy(
  request: Request,
  client: TeraboxClient,
  url: URL,
  srcPath: string,
  method: 'MOVE' | 'COPY',
): Promise<Response> {
  const destinationHeader = request.headers.get('Destination');
  if (!destinationHeader) return errorResponse('Bad Request', 400);
  let destPath: string;
  try {
    destPath = decodePathname(new URL(destinationHeader).pathname);
  } catch {
    return errorResponse('Bad Request', 400);
  }
  if (destPath === '/' || destPath === '') return errorResponse('Forbidden', 403);
  if (destPath.length > 1 && destPath.endsWith('/')) destPath = destPath.slice(0, -1);

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

  await ensureParent(client, destPath);

  const { dir, base } = splitPath(destPath);
  await client.fileOperation(method === 'MOVE' ? 'move' : 'copy', [
    {
      path: srcPath,
      dest: dir === '/' ? '/' : dir,
      newname: base,
      ...(destResource && overwrite ? { ondup: 'overwrite' } : {}),
    },
  ]);

  return new Response(null, { status: destResource && overwrite ? 204 : 201 });
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

export function errorResponse(message: string, status: number, extra?: Record<string, unknown>): Response {
  return new Response(JSON.stringify({ error: message, ...extra }), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}