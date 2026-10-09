import { TeraboxClient, TeraboxError, errIsNum } from './terabox';
import { errorResponse, handleWebDav } from './webdav';
import type { Env } from './types';

interface Credential {
  username: string;
  password: string;
}

/** Constant-time string equality (see node:crypto timingSafeEqual behaviour). */
export function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export function parseCredentials(users: string | undefined): Credential[] {
  if (!users) return [];
  return users
    .split(/[\r\n,]+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const idx = line.indexOf(':');
      if (idx === -1) return { username: line, password: '' };
      return { username: line.slice(0, idx), password: line.slice(idx + 1) };
    });
}

function validBasicAuth(request: Request, env: Env): boolean {
  const header = request.headers.get('Authorization') || '';
  if (!header.startsWith('Basic ')) return false;
  const creds = parseCredentials(env.USERS);
  if (creds.length === 0) return false;

  let decoded: string;
  try {
    decoded = atob(header.slice(6));
  } catch {
    return false;
  }
  const sep = decoded.indexOf(':');
  if (sep === -1) return false;
  const username = decoded.slice(0, sep);
  const password = decoded.slice(sep + 1);

  return creds.some(
    (c) => constantTimeEquals(c.username, username) && constantTimeEquals(c.password, password),
  );
}

function statusFor(error: unknown): number {
  if (errIsNum(error, -6)) return 401;
  if (errIsNum(error, -9)) return 404;
  if (errIsNum(error, 4000023)) return 401;
  if (errIsNum(error, 400141)) return 401;
  if (errIsNum(error, 450016)) return 401;
  return 500;
}

const worker: ExportedHandler<Env> = {
  async fetch(request, env) {
    const url = new URL(request.url);

    const log = (level: string, message: string, extra?: unknown) => {
      const tag = env.LOG_PREFIX ? `[${env.LOG_PREFIX}] ` : '';
      if (extra !== undefined) {
        // eslint-disable-next-line no-console
        console[level === 'error' ? 'error' : 'log'](`${tag}${message}`, extra);
      } else {
        // eslint-disable-next-line no-console
        console[level === 'error' ? 'error' : 'log'](`${tag}${message}`);
      }
    };

    // Fail closed: an unconfigured or malformed USERS mapping never exposes data.
    if (!parseCredentials(env.USERS).length) {
      log('error', 'WebDAV server disabled: USERS is unset or empty');
      return errorResponse('WebDAV server not configured', 500);
    }
    if (!env.COOKIE) {
      log('error', 'WebDAV server disabled: COOKIE is unset');
      return errorResponse('WebDAV server not configured', 500);
    }
    if (!validBasicAuth(request, env)) {
      if (reqIsPreflight(request)) {
        return new Response(null, { status: 204 });
      }
      return errorResponse('Unauthorized', 401);
    }

    const client = new TeraboxClient(env.COOKIE, env.TERABOX_DOMAIN);

    const started = Date.now();
    log('info', `${request.method} ${url.pathname}`);
    try {
      const response = await handleWebDav(request, client);
      const elapsed = Date.now() - started;
      if (elapsed > 500) log('info', `slow ${request.method} ${url.pathname} (${elapsed}ms)`);
      return response;
    } catch (error) {
      if (error instanceof TeraboxError) {
        log('error', `terabox errno ${error.errno}: ${error.message}`, { path: url.pathname, step: error.step });
        // Additive diagnostics: which backend stage failed, with which errno.
        const detail = {
          errno: error.errno,
          ...(error.step ? { step: error.step } : {}),
          ...(error.upstream ? { upstream: error.upstream } : {}),
        };
        if (error.errno === -6 || error.errno === 4000023 || error.errno === 400141 || error.errno === 450016) {
          return errorResponse('Terabox session expired or invalid', 401, detail);
        }
        return errorResponse(error.message, statusFor(error), detail);
      }
      log('error', 'unhandled error', { path: url.pathname, message: error instanceof Error ? error.message : String(error) });
      return errorResponse('Internal Server Error', 500);
    }
  },
};

function reqIsPreflight(request: Request): boolean {
  return request.method.toUpperCase() === 'OPTIONS' && Boolean(request.headers.get('Access-Control-Request-Method'));
}

export default worker;