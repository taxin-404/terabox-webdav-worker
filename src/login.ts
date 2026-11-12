/**
 * Browser sign-in for the viewer — per-tab, no persisted cookie.
 *
 * The page holds its credential in sessionStorage, which the browser
 * destroys the moment the tab closes: closing the tab IS signing out,
 * and nothing is written to disk anywhere. /.dav-login is therefore only
 * a validation endpoint (JSON ok / 401) that the page's own sign-in card
 * posts to; the credential never round-trips back from the server. The
 * viewer shell is served without auth — it is static and ships no data;
 * every real request (listing, actions, uploads) still 401s without
 * credentials. WebDAV clients are untouched: they keep sending Basic on
 * every request.
 *
 * File opens/downloads are real navigations, which can never carry
 * sessionStorage — the page mints a short-lived signed URL instead:
 * `?ot=<token>` is a stateless HMAC keyed by the raw USERS string over
 * `open|b64url(decoded path)|exp`, bound to the exact decoded path and
 * 60 s to live, checked only for GET/HEAD at the gate. Rotating USERS
 * invalidates every signed link for free, and no new configuration
 * exists to forget.
 *
 * Security posture:
 *   - Login/logout posts reject cross-site fetches: workers.dev siblings
 *     are same-*site* but hostile, so only Sec-Fetch-Site same-origin/
 *     none (or no header at all — non-browser clients) pass.
 *   - Open-token verification is signature-first (WebCrypto, effectively
 *     constant-time), then a strict expiry window, then an exact path
 *     match — a token for one file never opens another.
 *   - /.dav-logout stays a redirect endpoint that clears any legacy
 *     cookie from before the per-tab model (still HttpOnly/Secure/
 *     SameSite=Strict on the clear, Max-Age=0).
 */
export const SESSION_COOKIE_NAME = 'davbox_session';

/** Signed download links live this many seconds. */
export const OPEN_TTL = 60;

const textEncoder = new TextEncoder();

function b64urlFromBytes(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function bytesFromB64url(s: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(s)) return null;
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  try {
    const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

let keyCache: { raw: string; key: CryptoKey } | null = null;
async function usersKey(usersRaw: string): Promise<CryptoKey> {
  if (keyCache && keyCache.raw === usersRaw) return keyCache.key;
  const key = await crypto.subtle.importKey(
    'raw',
    textEncoder.encode(usersRaw),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
  keyCache = { raw: usersRaw, key };
  return key;
}

/** Mint a download token for `path` (decoded), valid `OPEN_TTL` seconds from `nowSec`. */
export async function createOpenToken(
  usersRaw: string,
  path: string,
  nowSec: number = Math.floor(Date.now() / 1000),
): Promise<string> {
  const exp = nowSec + OPEN_TTL;
  const pathB = b64urlFromBytes(textEncoder.encode(path));
  const key = await usersKey(usersRaw);
  const sig = new Uint8Array(
    await crypto.subtle.sign('HMAC', key, textEncoder.encode(`open|${pathB}|${exp}`)),
  );
  return `${pathB}.${exp}.${b64urlFromBytes(sig)}`;
}

/**
 * Verify a download token: signature, expiry window, then that the path
 * it was minted for is exactly the path being requested. The path is
 * never a secret (the HMAC is), so a plain string compare suffices there.
 */
export async function verifyOpenToken(
  usersRaw: string,
  path: string,
  token: string,
  nowSec: number = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  const [pathB, expRaw, sigB] = parts;
  if (!/^\d+$/.test(expRaw!)) return false;
  const exp = Number(expRaw);
  if (!Number.isSafeInteger(exp)) return false;
  // Live now; and never signed for an absurd window (a far-future exp can
  // only come from a minting bug — reject paranoia-grade drift).
  if (exp <= nowSec || exp > nowSec + OPEN_TTL + 3600) return false;
  const sig = bytesFromB64url(sigB!);
  if (!sig) return false;
  const key = await usersKey(usersRaw);
  const ok = await crypto.subtle.verify(
    'HMAC',
    key,
    sig,
    textEncoder.encode(`open|${pathB}|${exp}`),
  );
  if (!ok) return false;
  const signedBytes = bytesFromB64url(pathB!);
  if (!signedBytes) return false;
  let signedPath: string;
  try {
    signedPath = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(signedBytes);
  } catch {
    return false;
  }
  return signedPath === path;
}

export function sessionClearCookie(): string {
  return `${SESSION_COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;
}

/**
 * Redirect targets are same-origin paths only. `//host` and backslash
 * variants are scheme-relative in some UAs — rejected outright.
 */
export function sanitizeNext(raw: string | null | undefined): string | null {
  if (!raw) return null;
  if (raw.length > 2048) return null;
  // Control characters (HTAB included) are legal in an HTTP field value but
  // stripped by browsers' URL parser: `/\t/evil.com` becomes `//evil.com`.
  if (/[\u0000-\u001f\u007f]/.test(raw)) return null;
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\')) return null;
  return raw;
}

/**
 * True for a cross-site state-changing post. Absent header = non-browser
 * client (curl, tests) with no ambient authority to abuse — allowed.
 * Note `same-site` is deliberately rejected: evil.workers.dev is
 * same-site with this worker.
 */
export function crossSitePost(request: Request): boolean {
  const site = request.headers.get('Sec-Fetch-Site');
  return site !== null && site !== 'same-origin' && site !== 'none';
}
