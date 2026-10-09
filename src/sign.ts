/**
 * Pure helpers ported from bclone's Terabox backend
 * (github.com/BenjiThatFoxGuy/bclone backend/terabox).
 */

/** RC4-style keystream XOR signature used by /api/download. */
export function sign(s1: string, s2: string): string {
  const a = new Array<number>(256);
  const p = new Array<number>(256);
  const o: number[] = [];
  const v = s1.length;

  for (let q = 0; q < 256; q++) {
    a[q] = s1.charCodeAt(q % v);
    p[q] = q;
  }

  let u = 0;
  for (let q = 0; q < 256; q++) {
    u = (u + p[q]! + a[q]!) % 256;
    const tmp = p[q]!;
    p[q] = p[u]!;
    p[u] = tmp;
  }

  let i = 0;
  u = 0;
  for (let q = 0; q < s2.length; q++) {
    i = (i + 1) % 256;
    u = (u + p[i]!) % 256;
    const tmp = p[i]!;
    p[i] = p[u]!;
    p[u] = tmp;
    const k = p[(p[i]! + p[u]!) % 256]!;
    o.push(s2.charCodeAt(q) ^ k);
  }

  return btoa(String.fromCharCode(...o));
}

/** Normalise a cookie option into a usable Cookie header value. */
export function valuedCookie(cookie: string): string {
  let value = String(cookie || '').trim();
  if (value.length > 2 && value.startsWith('"') && value.endsWith('"')) {
    value = value.slice(1, -1);
  }
  const parts = value.split(';');
  if (parts.length === 1 && !parts[0]!.includes('=')) {
    return `ndus=${parts[0]}; lang=en`;
  }
  return value;
}

/** Extract the jsToken from the html bundle served at the Terabox root. */
export function jsTokenFromHtml(html: string): string {
  return getStrBetween(
    html,
    '`function%20fn%28a%29%7Bwindow.jsToken%20%3D%20a%7D%3Bfn%28%22',
    '%22%29`',
  );
}

export function getStrBetween(raw: string, start: string, end: string): string {
  const startIdx = raw.indexOf(start);
  if (startIdx === -1) return '';
  const begin = startIdx + start.length;
  const endIdx = raw.indexOf(end, begin);
  if (endIdx === -1) return '';
  return raw.slice(begin, endIdx);
}

/** Terabox wraps the final file md5; unwrap it for comparison against ours. */
export function decodeMD5(md5: string): string {
  if (md5.length !== 32) return md5;

  const restoredHexChar = ((md5.charCodeAt(9) - 'g'.charCodeAt(0)) >>> 0).toString(16);
  const o = md5.slice(0, 9) + restoredHexChar + md5.slice(10);

  const n: string[] = [];
  for (let i = 0; i < o.length; i++) {
    const orig = parseInt(o[i]!, 16);
    const xor = (orig ^ (i & 15)).toString(16);
    n.push(xor);
  }

  return n.slice(8, 16).join('') + n.slice(0, 8).join('') + n.slice(24, 32).join('') + n.slice(16, 24).join('');
}

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

/** Chunk size for slotted uploads (4 MiB free, up to 128 MiB premium). */
export function getChunkSize(fileSize: number, isVIP: boolean): number {
  const limitSizes = [4, 8, 16, 32, 64, 128];
  if (!isVIP) return limitSizes[0]! * MiB;
  for (const limit of limitSizes) {
    if (fileSize <= limit * GiB) return limit * MiB;
  }
  return limitSizes[limitSizes.length - 1]! * MiB;
}

export const MAX_FREE_FILE_BYTES = 4 * GiB;
export const MAX_PREMIUM_FILE_BYTES = 128 * GiB;

/** Join path segments the way the backend does (cleaning "..", "."). */
export function joinPath(...segments: string[]): string {
  const parts: string[] = [];
  for (const segment of segments) {
    for (const part of String(segment || '').split('/')) {
      if (part === '' || part === '.') continue;
      if (part === '..') {
        parts.pop();
      } else {
        parts.push(part);
      }
    }
  }
  return '/' + parts.join('/');
}

/** Split "/a/b/c" into { dir: "/a/b", base: "c" }. */
export function splitPath(path: string): { dir: string; base: string } {
  const clean = joinPath(path);
  const idx = clean.lastIndexOf('/');
  if (idx <= 0) return { dir: '/', base: clean.slice(1) };
  return { dir: clean.slice(0, idx), base: clean.slice(idx + 1) };
}

/** Primitive placeholder block-list used by the backend before upload. */
export function placeholderBlockList(size: number, chunkSize: number): string {
  const one = '"5910a591dd8fc18c32a8f3df4fdc1761"';
  const two = '"a5fc157d78e6ad1c7e114b056c92821e"';
  return `[${size > chunkSize ? `${one}, ${two}` : one}]`;
}