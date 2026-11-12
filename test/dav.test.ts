import { SELF } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	metaCacheHasForTest,
	metaCacheSeedForTest,
	metaCacheSize,
	metaMissCacheHasForTest,
	metaMissCacheSeedForTest,
	metaMissCacheSize,
	resetDavVolatileState,
	safeRelocate,
	upstreamSafeDavPath,
	upstreamSafeName,
} from '../src/webdav';
import type { DavStore, RelocateItem } from '../src/davstate';
import { validateXml } from '../src/davxml';
import { resetTeraboxCaches, TeraboxClient } from '../src/terabox';
import { getChunkSize } from '../src/sign';
import { AUTH, MockTerabox, ORIGIN, UPLOAD_BASE, installMock } from './helpers';

let tb: MockTerabox;

function seed(t: MockTerabox): void {
	t.seed('/docs', { isdir: 1 });
	t.seed('/a.txt', { content: 'the quick brown fox\n' });
	t.seed('/dest.txt', { content: 'dest content' });
	t.seed('/x & y [#].txt', { content: 'hostile name file' });
	t.seed('/docs/b & c.txt', { content: 'nested file data here' });
	t.seed('/docs/sub&dir', { isdir: 1 });
}

const request = (path: string, init: RequestInit = {}): Promise<Response> =>
	SELF.fetch(ORIGIN + path, {
		...init,
		headers: { ...AUTH, ...(init.headers as Record<string, string> | undefined) },
	});

beforeEach(() => {
	// Advisory lock/dead-prop state lives per isolate: clear it so cases
	// never leak locks or properties into each other. The Terabox module
	// caches (jsToken/premium/upload-hosts) are isolate-global too and would
	// otherwise leak a prior test's configured host list.
	resetDavVolatileState();
	resetTeraboxCaches();
	tb = new MockTerabox();
	seed(tb);
	installMock(tb);
});

afterEach(() => {
	vi.unstubAllGlobals();
	// Belt-and-braces for the Date.now spy in the sliding-TTL test: if that
	// test ever dies past its timeout, the finally never runs — restoring
	// here keeps a frozen clock from leaking into later cases.
	vi.restoreAllMocks();
});

describe('auth', () => {
	it('authenticates a non-ASCII password (RFC 7617 UTF-8)', async () => {
		// RFC 7617: with charset="UTF-8" the client base64s the UTF-8 bytes,
		// not latin1 — a latin1 decode of these bytes is mojibake and can
		// never equal the configured password.
		const utf8Basic = (username: string, password: string): string =>
			'Basic ' + btoa(String.fromCharCode(...new TextEncoder().encode(`${username}:${password}`)));

		const ok = await SELF.fetch(ORIGIN + '/', {
			method: 'PROPFIND',
			headers: { Authorization: utf8Basic('üser', 'pässword'), Depth: '0' },
		});
		expect(ok.status).toBe(207);

		const bad = await SELF.fetch(ORIGIN + '/', { headers: { Authorization: utf8Basic('üser', 'wrong') } });
		expect(bad.status).toBe(401);
	});

	it('requires credentials', async () => {
		const res = await SELF.fetch(ORIGIN + '/');
		expect(res.status).toBe(401);
	});

	it('rejects a wrong password', async () => {
		const res = await request('/', {
			headers: { Authorization: 'Basic ' + btoa('test:wrong') },
		});
		expect(res.status).toBe(401);
	});

	it('rejects malformed base64 without crashing', async () => {
		const res = await request('/', { headers: { Authorization: 'Basic not-valid@#$' } });
		expect(res.status).toBe(401);
	});

	it('accepts the auth-scheme in any case (RFC 7235 §2.1)', async () => {
		const res = await request('/a.txt', {
			headers: { Authorization: 'basic ' + btoa('test:pass') },
		});
		expect(res.status).toBe(200);
	});

	it('carries a WWW-Authenticate challenge on a mid-session 401 too', async () => {
		// The challenge on the FIRST 401 is what makes clients send
		// credentials at all; a later 401 without it stops neon/litmus and
		// Windows Mini-Redirector from ever retrying.
		const initial = await SELF.fetch(ORIGIN + '/');
		expect(initial.status).toBe(401);
		expect(initial.headers.get('WWW-Authenticate')).toContain('Basic');

		tb.precreateErrno = -6; // session-class Terabox failure
		const expired = await request('/expired-session.txt', { method: 'PUT', body: 'x' });
		expect(expired.status).toBe(401);
		expect(expired.headers.get('WWW-Authenticate')).toContain('Basic');
	});
});

describe('server metadata', () => {
	it('advertises class 1 and 2 in OPTIONS', async () => {
		const res = await request('/', { method: 'OPTIONS' });
		expect(res.status).toBe(204);
		expect(res.headers.get('DAV')).toBe('1, 2');
		expect(res.headers.get('Allow')).toContain('PROPFIND');
		expect(res.headers.get('Allow')).toContain('MOVE');
	});

	it('rejects invalid percent-encoding with a 400, not a 500', async () => {
		const res = await request('/%zz');
		expect(res.status).toBe(400);
		expect(await res.text()).toContain('Invalid path encoding');
	});

	it('returns 404 for a missing resource', async () => {
		const res = await request('/missing.txt');
		expect(res.status).toBe(404);
	});
});

describe('PROPFIND', () => {
	it('lists children with encoded hrefs and sizes (Depth 1)', async () => {
		const res = await request('/', { method: 'PROPFIND', headers: { Depth: '1' } });
		expect(res.status).toBe(207);
		expect(res.headers.get('Content-Type')).toMatch(/xml/);
		const body = await res.text();

		expect(body).toContain('<D:href>/</D:href>');
		expect(body).toContain('<D:href>/docs/</D:href>');
		expect(body).toContain('<D:href>/a.txt</D:href>');
		expect(body).toContain('<D:href>/dest.txt</D:href>');
		expect(body).toContain('<D:href>/x%20%26%20y%20%5B%23%5D.txt</D:href>');
		expect(body).toContain(`<D:getcontentlength>${tb.find('/a.txt')!.size}</D:getcontentlength>`);
		expect(body).toContain('<D:resourcetype><D:collection/></D:resourcetype>');
	});

	it('lists nested folder children (Depth 1)', async () => {
		const res = await request('/docs/', { method: 'PROPFIND', headers: { Depth: '1' } });
		const body = await res.text();
		expect(body).toContain('<D:href>/docs/sub%26dir/</D:href>');
		expect(body).toContain('<D:href>/docs/b%20%26%20c.txt</D:href>');
		expect(body).toContain(`<D:getcontentlength>${tb.find('/docs/b & c.txt')!.size}</D:getcontentlength>`);
	});

	it('only returns the requested resource at Depth 0', async () => {
		const res = await request('/', { method: 'PROPFIND', headers: { Depth: '0' } });
		const body = await res.text();
		expect(body).toContain('<D:href>/</D:href>');
		expect(body).not.toContain('/docs/');
		expect(body).not.toContain('/a.txt');
	});

	it('resolves a hostile file name through its encoded path', async () => {
		const res = await request('/x%20%26%20y%20%5B%23%5D.txt', { method: 'PROPFIND', headers: { Depth: '0' } });
		expect(res.status).toBe(207);
		const body = await res.text();
		expect(body).toContain('<D:href>/x%20%26%20y%20%5B%23%5D.txt</D:href>');
		expect(body).toContain(`<D:getcontentlength>${tb.find('/x & y [#].txt')!.size}</D:getcontentlength>`);
	});
});

describe('MKCOL', () => {
	it('creates a folder and returns 201', async () => {
		const res = await request('/new-folder', { method: 'MKCOL' });
		expect(res.status).toBe(201);
		expect(tb.find('/new-folder')?.isdir).toBe(1);
	});

	it('rewrites emoji in the created name by removing it (upstream rejects emoji, errno -7)', async () => {
		// Live-proven: upstream web API answers errno -7 for emoji names.
		// Creating through this worker REMOVES the rejected run instead of
		// 403ing or littering the name with a placeholder.
		const res = await request('/casterix%F0%9F%9A%80-test', { method: 'MKCOL' });
		expect(res.status).toBe(201);
		expect(tb.find('/casterix-test')?.isdir).toBe(1);
	});

	it('removes emoji runs from PUT names', async () => {
		const res = await request('/casterix%F0%9F%8E%89-file.txt', {
			method: 'PUT', body: 'emoji name works',
		});
		expect(res.status).toBe(201);
		// Reads stay raw, so the rewritten name is what resolves afterward.
		const got = await request('/casterix-file.txt');
		expect(got.status).toBe(200);
		expect(await got.text()).toBe('emoji name works');
		// The raw emoji URL no longer matches anything upstream (the stored
		// name lost the emoji) — a listing refresh is how clients learn it.
		const raw = await request('/casterix%F0%9F%8E%89-file.txt');
		expect(raw.status).toBe(404);
	});

	it('removes rejected ASCII/controls too (live-proven -7 set)', async () => {
		// ?:*<>"|\ and tab are refused upstream like emoji; the same removal
		// policy applies (runs vanish, trailing spaces trim on dirs).
		const res = await request('/what%3Fname', { method: 'MKCOL' });
		expect(res.status).toBe(201);
		expect(tb.find('/whatname')?.isdir).toBe(1);
	});

	it('falls back to _ for a name that was pure rejected characters', async () => {
		// A stripped-to-nothing name must still create something addressable.
		const res = await request('/%F0%9F%9A%80%F0%9F%9A%80', { method: 'MKCOL' });
		expect(res.status).toBe(201);
		expect(tb.find('/_')?.isdir).toBe(1);
	});

	it('trims trailing spaces from created directory names', async () => {
		const res = await request('/curry%20', { method: 'MKCOL' });
		expect(res.status).toBe(201);
		expect(tb.find('/curry')?.isdir).toBe(1);
	});

	it('keeps accepted ASCII names untouched: percent drops through', async () => {
		// Live-proven accepted upstream; the URL layer decodes it once.
		const res = await request('/100%25off%26more', { method: 'MKCOL' });
		expect(res.status).toBe(201);
		expect(tb.find('/100%off&more')?.isdir).toBe(1);
	});

	it('keeps read paths raw: GET of a literally-#-named file resolves it', async () => {
		// The name a client sees after creating is the '#' form; reads of
		// it must resolve (raw == the stored name, no rewrite needed).
		await request('/hash-%23-file.txt', { method: 'PUT', body: 'kept' });
		const res = await request('/hash-%23-file.txt');
		expect(res.status).toBe(200);
		expect(await res.text()).toBe('kept');
	});

	it('returns 405 for an existing resource', async () => {
		const res = await request('/a.txt', { method: 'MKCOL' });
		expect(res.status).toBe(405);
	});

	it('rejects creating the root', async () => {
		const res = await request('/', { method: 'MKCOL' });
		expect(res.status).toBe(403);
	});
});

describe('upstreamSafeName (emoji + live-proven rejected ASCII/controls → removed)', () => {
	const cases: Array<[string, string]> = [
		// Each rejected RUN is removed outright: ZWJ clusters, flags,
		// repeated emoji and adjacent rejected ASCII all vanish together.
		['casterix🚀-test', 'casterix-test'],
		['🎉🎉party', 'party'],
		['👨‍👩‍👧-family', '-family'],
		['🇺🇸flag', 'flag'],
		['1️⃣st', '1st'],
		['pure🚀', 'pure'],
		['🚀🚀', '_'],
		// Live-proven rejected ASCII (upstream -7): runs are removed.
		['what?ever', 'whatever'],
		['might:<be*"weird|>', 'mightbeweird'],
		['win\\nt:2*.txt', 'winnt2.txt'],
		// Control characters vanish into the same run rule.
		['a\tb\x7f', 'ab'],
		// Directory rule: trailing spaces trim (the emoji-then-space case
		// empties to the trim and stays non-empty).
		['trail ', 'trail'],
		['casterix🚀 ', 'casterix'],
		[' 🚀', '_'],
		// Structural empties pass through (never become '_').
		['', ''],
		// Letters (CJK/accents) and accepted symbols/ASCII pass through.
		['唱片 #1', '唱片 #1'],
		['naïve-файл', 'naïve-файл'],
		['©-Copy', '©-Copy'],
		['⌘-tech', '⌘-tech'],
		["don't&do$that%~ok", "don't&do$that%~ok"],
		['seed(1)[a]{b}—…', 'seed(1)[a]{b}—…'],
		// '#' is an accepted character, never matched: idempotent.
		['already#fine', 'already#fine'],
		['casterix#-test', 'casterix#-test'],
	];
	for (const [input, expected] of cases) {
		it(`maps ${JSON.stringify(input)} → ${JSON.stringify(expected)}`, () => {
			expect(upstreamSafeName(input)).toBe(expected);
			// Idempotency holds for the path form as well.
			expect(upstreamSafeDavPath(upstreamSafeDavPath(input))).toBe(
				upstreamSafeDavPath(input),
			);
		});
	}
	it('rewrites per segment but never touches separators', () => {
		expect(upstreamSafeDavPath('/🚀dir/a:b/f🚀.txt')).toBe('/dir/ab/f.txt');
	});
});

describe('GET / HEAD', () => {
	it('streams a file body with content-type and etag', async () => {
		const res = await request('/a.txt');
		expect(res.status).toBe(200);
		expect(await res.text()).toBe('the quick brown fox\n');
		expect(res.headers.get('Content-Type')).toBe('text/plain');
		expect(res.headers.get('ETag')).toBe(`"${tb.find('/a.txt')!.md5}"`);
	});

	it('honours a byte range', async () => {
		const res = await request('/a.txt', { headers: { Range: 'bytes=0-2' } });
		expect(res.status).toBe(206);
		expect(await res.text()).toBe('the');
		expect(res.headers.get('Content-Range')).toBe(
			`bytes 0-2/${tb.find('/a.txt')!.size}`,
		);
	});

	it('returns 405 for directories', async () => {
		const res = await request('/docs');
		expect(res.status).toBe(405);
	});

	it('returns 404 for a missing file', async () => {
		const res = await request('/missing.txt');
		expect(res.status).toBe(404);
	});

	it('HEAD reports size without a body', async () => {
		const res = await request('/a.txt', { method: 'HEAD' });
		expect(res.status).toBe(200);
		expect(res.headers.get('Content-Length')).toBe(String(tb.find('/a.txt')!.size));
		expect((await new Response(res.body).arrayBuffer()).byteLength).toBe(0);
	});

	it('retries a 400141 dlink gate with jsToken, then streams', async () => {
		tb.gateDownloads = 'once';
		const res = await request('/a.txt');
		expect(res.status).toBe(200);
		expect(await res.text()).toBe('the quick brown fox\n');
	});

	it('uses the pcs app-protocol route when the web dlinks are gated', async () => {
		tb.gateDl = ['plain', 'official'];
		const res = await request('/a.txt');
		expect(res.status).toBe(200);
		expect(await res.text()).toBe('the quick brown fox\n');
		// rclone-style ranged GET must survive the pcs 302 hop too.
		const ranged = await request('/a.txt', { headers: { Range: 'bytes=0-2' } });
		expect(ranged.status).toBe(206);
		expect(await ranged.text()).toBe('the');
	});

	it('falls back to the official token dlink when plain and pcs links are gated', async () => {
		tb.gateDl = ['plain', 'pcs'];
		const res = await request('/a.txt');
		expect(res.status).toBe(200);
		expect(await res.text()).toBe('the quick brown fox\n');
	});

	it('treats a pcs error_code gate body as an error, never content', async () => {
		tb.gatePcs = true;
		const res = await request('/a.txt');
		expect(res.status).toBe(200);
		expect(await res.text()).toBe('the quick brown fox\n');
	});

	it('maps a persistent dlink gate to 401 and names the host', async () => {
		tb.gateDownloads = 'always';
		const res = await request('/a.txt');
		expect(res.status).toBe(401);
		const body = await res.text();
		expect(body).toContain('"errno":400141');
		expect(body).toContain('dlink@');
	});
});

describe('GET status normalization (RFC 7233 §4.1 — davfs2 etag poison)', () => {
	it('re-states an unrequested upstream 206 as 200 with no Content-Range', async () => {
		// The live PCS flap: the upstream answers 206 to a plain GET. davfs2
		// captures an etag only from an exactly-200 response, so surfacing the
		// 206 would null its stored validator and force a full re-download on
		// every later open — the open()-hang of the investigation doc.
		tb.unrequestedFull206 = true;
		const node = tb.find('/a.txt')!;
		const res = await request('/a.txt');
		expect(res.status).toBe(200);
		expect(res.headers.get('Content-Range')).toBeNull();
		expect(res.headers.get('Content-Length')).toBe(String(node.size));
		expect(res.headers.get('ETag')).toBe(`"${node.md5}"`);
		expect(await res.text()).toBe('the quick brown fox\n');
		// HEAD takes the same path and must not surface 206 either.
		const head = await request('/a.txt', { method: 'HEAD' });
		expect(head.status).toBe(200);
		expect(head.headers.get('Content-Range')).toBeNull();
	});

	it('still 304s a revalidation while the upstream flap is active', async () => {
		tb.unrequestedFull206 = true;
		const md5 = tb.find('/a.txt')!.md5;
		const res = await request('/a.txt', { headers: { 'If-None-Match': `"${md5}"` } });
		expect(res.status).toBe(304);
		expect(res.headers.get('ETag')).toBe(`"${md5}"`);
		expect((await new Response(res.body).arrayBuffer()).byteLength).toBe(0);
	});

	it('rejects a truncated 206 and falls through the ladder to a full body', async () => {
		// Only the pcs flavour answers a genuine partial: the worker must not
		// stream it as a complete file, and must keep walking the ladder.
		tb.unrequestedPartial206 = ['pcs'];
		const res = await request('/a.txt');
		expect(res.status).toBe(200);
		expect(res.headers.get('Content-Range')).toBeNull();
		expect(await res.text()).toBe('the quick brown fox\n');
	});

	it('never streams a partial body: all candidates truncated → 502', async () => {
		tb.unrequestedPartial206 = ['pcs', 'official', 'plain'];
		const res = await request('/a.txt');
		expect(res.status).toBe(502);
		const body = await res.text();
		// Not a 200 pretending to be whole; not the truncated half either.
		expect(body).not.toBe('the quic');
		expect(body).not.toBe('the quick brown fox\n');
	});

	it('keeps a ranged request a 206 (the flap knob only fires without Range)', async () => {
		tb.unrequestedFull206 = true;
		const res = await request('/a.txt', { headers: { Range: 'bytes=0-2' } });
		expect(res.status).toBe(206);
		expect(await res.text()).toBe('the');
		expect(res.headers.get('Content-Range')).toBe(`bytes 0-2/${tb.find('/a.txt')!.size}`);
	});
});

describe('GET validators for md5-less items', () => {
	it('answers the PROPFIND fallback etag on GET/HEAD and honours it with 304', async () => {
		tb.seed('/nomd5.bin', { content: '0123456789', md5: '' });
		const node = tb.find('/nomd5.bin')!;
		// RFC 7232 §2.3: one-second mtime + size cannot distinguish same-second
		// rewrites, so the fallback validator is weak (W/).
		const fallback = `W/"${node.server_mtime}-${node.size}-0"`;
		// PROPFIND and GET must serve the *same* validator: a GET without an
		// ETag header nulls davfs2's stored one and poisons every later open.
		const propfind = await request('/nomd5.bin', { method: 'PROPFIND', headers: { Depth: '0' } });
		expect(await propfind.text()).toContain(
			`<D:getetag>${fallback.replace(/"/g, '&quot;')}</D:getetag>`,
		);
		const res = await request('/nomd5.bin');
		expect(res.status).toBe(200);
		expect(res.headers.get('ETag')).toBe(fallback);
		const head = await request('/nomd5.bin', { method: 'HEAD' });
		expect(head.headers.get('ETag')).toBe(fallback);
		const revalidated = await request('/nomd5.bin', { headers: { 'If-None-Match': fallback } });
		expect(revalidated.status).toBe(304);
		expect(revalidated.headers.get('ETag')).toBe(fallback);
	});

	it('revalidates a stripped weak tag (If-None-Match weak comparison)', async () => {
		// RFC 7232 §3.2: W/"x" and "x" are the SAME validator for
		// If-None-Match — a client that strips the prefix must still 304.
		tb.seed('/nomd5-stripped.bin', { content: '0123456789', md5: '' });
		const node = tb.find('/nomd5-stripped.bin')!;
		const stripped = `"${node.server_mtime}-${node.size}-0"`;
		const res = await request('/nomd5-stripped.bin', { headers: { 'If-None-Match': stripped } });
		expect(res.status).toBe(304);
	});

	it('refuses a weak fallback etag for If-Range (serves the full body)', async () => {
		// RFC 7233 §3.2 needs a STRONG validator for If-Range: splicing a
		// ranged slice under a one-second-resolution etag could mix a
		// same-second rewrite into the client's partial copy.
		tb.seed('/nomd5-range.bin', { content: '0123456789', md5: '' });
		const node = tb.find('/nomd5-range.bin')!;
		const weak = `W/"${node.server_mtime}-${node.size}-0"`;
		const res = await request('/nomd5-range.bin', { headers: { Range: 'bytes=0-2', 'If-Range': weak } });
		expect(res.status).toBe(200);
		expect(await res.text()).toBe('0123456789');
	});
});

describe('timestamp sanitization (upstream garbage must not 500)', () => {
	it('serves PROPFIND 207 and GET 200 for an out-of-range server_mtime', async () => {
		// 1e15 seconds x 1000 overflows the Date range: creationdate used to
		// throw a RangeError and 500 the ENTIRE Depth-1 listing — one poisoned
		// child took down every sibling's view too.
		tb.seed('/huge-mtime.txt', { content: 'x', md5: '', server_mtime: 1e15 });
		const propfind = await request('/', { method: 'PROPFIND', headers: { Depth: '1' } });
		expect(propfind.status).toBe(207);
		const body = await propfind.text();
		expect(validateXml(body)).toBeNull();
		expect(body).toContain('<D:creationdate>1970-01-01T00:00:00.000Z</D:creationdate>');
		const res = await request('/huge-mtime.txt');
		expect(res.status).toBe(200);
		expect(res.headers.get('Last-Modified')).toBe('Thu, 01 Jan 1970 00:00:00 GMT');
		expect(res.headers.get('ETag')).toBe('W/"0-1-0"');
	});

	it('agrees between GET and PROPFIND for a non-numeric mtime', async () => {
		// One fallback rule for every surface: GET's Last-Modified used to
		// emit `Invalid Date` while PROPFIND answered epoch — and NaN made
		// If-Modified-Since never match (perpetual full re-downloads).
		tb.seed('/weird-mtime.txt', { content: 'x', server_mtime: 'not-a-number' as unknown as number });
		const propfind = await request('/weird-mtime.txt', { method: 'PROPFIND', headers: { Depth: '0' } });
		expect(propfind.status).toBe(207);
		const modified = /<D:getlastmodified>([^<]+)<\/D:getlastmodified>/.exec(await propfind.text())?.[1];
		const res = await request('/weird-mtime.txt');
		expect(res.status).toBe(200);
		expect(res.headers.get('Last-Modified')).toBe(modified);
		expect(res.headers.get('Last-Modified')).toMatch(/GMT$/);
	});

	it('keeps a header-hostile mtime out of the ETag (md5-less GET stays 200)', async () => {
		// Number('123\n') is 123, but the raw string used to be embedded in
		// the etag — headers.set then threw and GET 500'd while the same
		// file's PROPFIND answered 207.
		tb.seed('/nl-mtime.bin', { content: '0123456789', md5: '', server_mtime: '123\n' as unknown as number });
		const res = await request('/nl-mtime.bin');
		expect(res.status).toBe(200);
		expect(res.headers.get('ETag')).toBe('W/"123-10-0"');
		const propfind = await request('/nl-mtime.bin', { method: 'PROPFIND', headers: { Depth: '0' } });
		expect(propfind.status).toBe(207);
		expect(await propfind.text()).toContain('W/&quot;123-10-0&quot;');
	});
});

describe('PROPFIND output well-formedness (hostile names)', () => {
	it('never lets a control-character name break the 207', async () => {
		// %01 and %00 names are creatable through this worker (MKCOL/PUT):
		// the response must still be parseable XML, so sanitization happens
		// at the emission choke point instead of trusting upstream to refuse.
		expect((await request('/bad%01name.txt', { method: 'MKCOL' })).status).toBe(201);
		expect((await request('/nul%00file.txt', { method: 'PUT', body: 'x' })).status).toBe(201);

		const res = await request('/', { method: 'PROPFIND', headers: { Depth: '1' } });
		expect(res.status).toBe(207);
		const body = await res.text();
		expect(validateXml(body)).toBeNull();
		expect(body).not.toMatch(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/);

		expect((await request('/bad%01name.txt', { method: 'DELETE' })).status).toBe(204);
		expect((await request('/nul%00file.txt', { method: 'DELETE' })).status).toBe(204);
	});
});

describe('GET/HEAD preconditions and 405 discovery (RFC 7232 §6, RFC 7231 §6.5.5)', () => {
	it('412s a stale If-Match and If-Unmodified-Since on GET and HEAD', async () => {
		const md5 = tb.find('/a.txt')!.md5;
		expect((await request('/a.txt', { headers: { 'If-Match': '"stale"' } })).status).toBe(412);
		expect((await request('/a.txt', { method: 'HEAD', headers: { 'If-Match': '"stale"' } })).status).toBe(412);
		expect((await request('/a.txt', { headers: { 'If-Match': `"${md5}"` } })).status).toBe(200);
		// Step 2 applies only when If-Match is absent (§6 order).
		expect(
			(await request('/a.txt', { headers: { 'If-Unmodified-Since': 'Wed, 01 Jan 2020 00:00:00 GMT' } })).status,
		).toBe(412);
		expect(
			(await request('/a.txt', {
				headers: { 'If-Match': `"${md5}"`, 'If-Unmodified-Since': 'Wed, 01 Jan 2020 00:00:00 GMT' },
			})).status,
		).toBe(200);
		// `*` asserts existence only (§3.1); a missing resource keeps 404 (§5
		// precedence: preconditions are ignored when the unconditioned
		// response would be non-2xx and not 412).
		expect((await request('/a.txt', { headers: { 'If-Match': '*' } })).status).toBe(200);
		expect((await request('/gone.txt', { headers: { 'If-Match': '"x"' } })).status).toBe(404);
	});

	it('carries Allow on the collection 405', async () => {
		// RFC 7231 §6.5.5 MUST: the collection root is the most-probed 405
		// on this surface, and it used to answer with no method discovery.
		for (const method of ['GET', 'HEAD']) {
			const res = await request('/', { method });
			expect(res.status).toBe(405);
			expect(res.headers.get('Allow')).toContain('PROPFIND');
			expect(res.headers.get('Allow')).toContain('GET');
		}
	});
});

describe('path segment decoding (RFC 3986, not form encoding)', () => {
	it('treats a raw "+" in the request path as a literal plus', async () => {
		tb.seed('/5.1+English.txt', { content: 'dual audio bytes' });
		const res = await request('/5.1+English.txt');
		expect(res.status).toBe(200);
		expect(await res.text()).toBe('dual audio bytes');
	});

	it('decodes %2B to the same literal plus', async () => {
		tb.seed('/5.1+English.txt', { content: 'dual audio bytes' });
		const res = await request('/5.1%2BEnglish.txt');
		expect(res.status).toBe(200);
		expect(await res.text()).toBe('dual audio bytes');
	});

	it('still decodes %20 to a space', async () => {
		tb.seed('/two words.txt', { content: 'spaced content' });
		const res = await request('/two%20words.txt');
		expect(res.status).toBe(200);
		expect(await res.text()).toBe('spaced content');
	});

	it('encodes "+" as %2B in PROPFIND hrefs so clients can re-request it', async () => {
		tb.seed('/5.1+English.mkv', { content: 'x' });
		const res = await request('/', { method: 'PROPFIND', headers: { Depth: '1' } });
		expect(res.status).toBe(207);
		expect(await res.text()).toContain('5.1%2BEnglish.mkv');
	});

	it('MOVE resolves a raw "+" in both source path and Destination', async () => {
		tb.seed('/old+name.txt', { content: 'move me' });
		const res = await request('/old+name.txt', {
			method: 'MOVE',
			headers: { Destination: ORIGIN + '/new+name.txt' },
		});
		expect(res.status).toBe(201);
		expect(tb.find('/old+name.txt')).toBeUndefined();
		expect(tb.find('/new+name.txt')).toBeDefined();
	});
});

describe('metadata cache (read-path filemetas collapse)', () => {
	it('serves repeat GETs with a single filemetas round-trip', async () => {
		expect((await request('/a.txt')).status).toBe(200);
		expect(tb.filemetasCalls).toBe(1);
		expect((await request('/a.txt')).status).toBe(200);
		expect(tb.filemetasCalls).toBe(1);
	});

	it('shares the fill with stat (PROPFIND Depth 0) — no new upstream call', async () => {
		const first = await request('/a.txt', { method: 'PROPFIND', headers: { Depth: '0' } });
		expect(first.status).toBe(207);
		const after = tb.filemetasCalls;
		const second = await request('/a.txt', { method: 'PROPFIND', headers: { Depth: '0' } });
		expect(second.status).toBe(207);
		expect(tb.filemetasCalls).toBe(after);
	});

	it('caches negative lookups for the short miss TTL (policy inversion of the pre-campaign pin)', async () => {
		// Rewritten pin: the old contract ("never caches negative lookups")
		// existed to keep freshly-created paths invisible for zero minutes,
		// but it made every gvfsd-dav directory view a storm of real
		// /api/filemetas calls for nonexistent cover-art names (AlbumArt.jpg,
		// cover.png, thumb.*), which is what made mounts feel sluggish.
		// The new policy bounds the consequence: misses live META_MISS_TTL_MS
		// (30 s — inside the 60 s staleness envelope the positive cache
		// already accepted), and are flushed by writes through this worker,
		// expiry, generation sync, and the FIFO cap. The boundaries are
		// pinned in describe `stat miss cache (gvfsd-dav probe storm)`.
		expect((await request('/missing.txt')).status).toBe(404);
		const after = tb.filemetasCalls;
		expect((await request('/missing.txt')).status).toBe(404);
		expect(tb.filemetasCalls).toBe(after);
	});

	it('invalidates on PUT so the next GET re-fetches and serves new bytes', async () => {
		await request('/a.txt');
		const put = await request('/a.txt', { method: 'PUT', body: 'updated body' });
		expect(put.status).toBe(204);
		const before = tb.filemetasCalls;
		const res = await request('/a.txt');
		expect(await res.text()).toBe('updated body');
		expect(tb.filemetasCalls).toBe(before + 1);
	});

	it('MOVE drops both names: destination visible, source gone', async () => {
		await request('/a.txt');
		const mv = await request('/a.txt', {
			method: 'MOVE',
			headers: { Destination: ORIGIN + '/moved.txt' },
		});
		expect(mv.status).toBe(201);
		expect((await request('/moved.txt')).status).toBe(200);
		expect((await request('/a.txt')).status).toBe(404);
	});

	it('resetDavVolatileState clears the cache (test isolation)', async () => {
		await request('/a.txt');
		expect(tb.filemetasCalls).toBe(1);
		resetDavVolatileState();
		await request('/a.txt');
		expect(tb.filemetasCalls).toBe(2);
	});
});

describe('GET download-URL cache (repeat-open TTFB)', () => {
	// After the first successful ladder walk the final signed CDN URL is
	// remembered; repeat GETs (video reopen, player seeks) fetch it directly
	// — no filemetas re-mint, no PCS round-trip, no pacing floor. The entry
	// is validated against the item's identity, invalidated by writes and
	// isolate resets, and self-heals by dropping back to the ladder when the
	// signed URL stops working.
	it('serves a repeat GET directly from the cached CDN URL — no ladder round-trip', async () => {
		expect((await request('/a.txt')).status).toBe(200);
		expect(tb.pcsCalls).toBe(1);
		expect((await request('/a.txt')).status).toBe(200);
		expect(tb.pcsCalls).toBe(1);
		expect(tb.filemetasCalls).toBe(1);
		expect(tb.dlCalls).toBe(2);
	});

	it('forwards Range on the cached URL (player seeks skip the ladder)', async () => {
		expect((await request('/a.txt')).status).toBe(200);
		expect(tb.pcsCalls).toBe(1);
		const ranged = await request('/a.txt', { headers: { Range: 'bytes=0-2' } });
		expect(ranged.status).toBe(206);
		expect(await ranged.text()).toBe('the');
		expect(ranged.headers.get('Content-Range')).toBe(
			`bytes 0-2/${tb.find('/a.txt')!.size}`,
		);
		expect(tb.pcsCalls).toBe(1);
	});

	it('re-runs the ladder when the file identity changed (fs_id/mtime)', async () => {
		expect((await request('/a.txt')).status).toBe(200);
		expect(tb.pcsCalls).toBe(1);
		// Unchanged identity: served straight from the cache.
		expect((await request('/a.txt')).status).toBe(200);
		expect(tb.pcsCalls).toBe(1);
		// An external rewrite landed on Terabox: fresh meta shows a new
		// identity, so the cached URL must not serve it.
		metaCacheSeedForTest('/a.txt', { ...tb.find('/a.txt')!, server_mtime: 9_999_999 });
		expect((await request('/a.txt')).status).toBe(200);
		expect(tb.pcsCalls).toBe(2);
	});

	it('drops a gated cached URL, re-walks the ladder and serves the refresh', async () => {
		expect((await request('/a.txt')).status).toBe(200);
		expect(tb.pcsCalls).toBe(1);
		// The cached via=pcs URL stops working (live 400141 "need verify").
		tb.gateDl = ['pcs'];
		expect((await request('/a.txt')).status).toBe(200);
		// The refreshed entry now answers without touching the ladder again.
		const before = tb.pcsCalls;
		expect((await request('/a.txt')).status).toBe(200);
		expect(tb.pcsCalls).toBe(before);
	});

	it('invalidates the cached URL on writes through the worker', async () => {
		expect((await request('/a.txt')).status).toBe(200);
		expect((await request('/a.txt')).status).toBe(200);
		expect(tb.pcsCalls).toBe(1);
		const put = await request('/a.txt', { method: 'PUT', body: 'new bytes' });
		expect(put.status).toBe(204);
		const res = await request('/a.txt');
		expect(await res.text()).toBe('new bytes');
		expect(tb.pcsCalls).toBe(2);
	});

	it('resetDavVolatileState clears the URL cache (test isolation)', async () => {
		expect((await request('/a.txt')).status).toBe(200);
		expect((await request('/a.txt')).status).toBe(200);
		expect(tb.pcsCalls).toBe(1);
		resetDavVolatileState();
		expect((await request('/a.txt')).status).toBe(200);
		expect(tb.pcsCalls).toBe(2);
	});

	it('replays the cached capability URL with no session cookie (round-15 #2 boundary)', async () => {
		// End-to-end pin for the round-14 cookieless threading: the client
		// tests prove header shapes for hand-supplied flags; this proves the
		// dav layer records the mint-time boundary, hands it to phase 0, and
		// never lets a replay's own hopped=false clobber the stored flag —
		// the mock's /dl/ handler would happily serve either way, so only the
		// observed Cookie (or its absence) distinguishes a leak.
		expect((await request('/a.txt')).status).toBe(200); // mint: PCS 302 → hop (UA-only)
		expect((await request('/a.txt')).status).toBe(200); // phase-0 replay #1
		expect((await request('/a.txt')).status).toBe(200); // phase-0 replay #2 (after any rewrite)
		expect(tb.pcsCalls).toBe(1);
		// Positive half: the session IS attached on the API-origin mint
		// (the /dl/ handler ignores cookies, so without this the nulls
		// above could pass vacuously if nothing attached the cookie at all).
		expect(tb.pcsCookies[0]).toContain('ndus=');
		const capabilityFetches = tb.dlCookies.filter((e) => e.flavour === 'pcs');
		expect(capabilityFetches.length).toBeGreaterThanOrEqual(3);
		for (const seen of capabilityFetches) expect(seen.cookie).toBeNull();
	});

	it('slides the entry TTL on hits — a hot file never re-ladders mid-session (round-15 #4)', async () => {
		expect((await request('/a.txt')).status).toBe(200); // mint at t0
		expect(tb.pcsCalls).toBe(1);
		const t0 = Date.now();
		const at = vi.spyOn(Date, 'now');
		try {
			// t0+20min: inside the original TTL — still a hit. The metaCache
			// (60 s) must have expired, so this GET re-stats: proof the WORKER
			// (not just this test's realm) observed the mocked clock — without
			// that the whole slide assertion below would be vacuous.
			at.mockReturnValue(t0 + 20 * 60_000);
			expect((await request('/a.txt')).status).toBe(200);
			expect(tb.pcsCalls).toBe(1);
			expect(tb.filemetasCalls).toBe(2);
			// t0+40min: past the ORIGINAL TTL. The hit above must have slid
			// expires forward; with an absolute TTL this re-ladders (RED).
			at.mockReturnValue(t0 + 40 * 60_000);
			expect((await request('/a.txt')).status).toBe(200);
			expect(tb.pcsCalls).toBe(1);
		} finally {
			at.mockRestore();
		}
	});
});

describe('stat miss cache (gvfsd-dav probe storm)', () => {
	it('caches stat misses: re-probing a missing name does not re-ladder upstream', async () => {
		// gvfsd-dav probes dozens of plausible cover-art names (AlbumArt.jpg,
		// cover.png, …) on every directory view; on the first absence it got
		// a live filemetas answer — the second probe must reuse it.
		expect(
			(await request('/cover.png', { method: 'PROPFIND', headers: { Depth: '0' } })).status,
		).toBe(404);
		const afterFirst = tb.filemetasCalls;
		expect(
			(await request('/cover.png', { method: 'PROPFIND', headers: { Depth: '0' } })).status,
		).toBe(404);
		expect(tb.filemetasCalls).toBe(afterFirst);
	});

	it('flushes the cached stat miss on writes through this worker', async () => {
		expect(
			(await request('/cover.png', { method: 'PROPFIND', headers: { Depth: '0' } })).status,
		).toBe(404);
		expect((await request('/cover.png', { method: 'PUT', body: 'cover art bytes' })).status).toBe(
			201,
		);
		// A surviving miss entry would answer from the cache and make the
		// just-created file invisible for the whole miss window.
		expect(
			(await request('/cover.png', { method: 'PROPFIND', headers: { Depth: '0' } })).status,
		).toBe(207);
	});

	it('expires stat misses: a path that later exists is seen after the miss TTL', async () => {
		const t0 = Date.now();
		const at = vi.spyOn(Date, 'now');
		try {
			expect(
				(await request('/cover.png', { method: 'PROPFIND', headers: { Depth: '0' } })).status,
			).toBe(404);
			const afterFirst = tb.filemetasCalls;
			// t0+5min: past any sane miss TTL. The next probe must re-walk
			// upstream — files created OUTSIDE this worker (phone app, web
			// UI) become visible on the same terms as the positive cache's
			// 60 s staleness contract, not forever.
			at.mockReturnValue(t0 + 5 * 60_000);
			expect(
				(await request('/cover.png', { method: 'PROPFIND', headers: { Depth: '0' } })).status,
			).toBe(404);
			expect(tb.filemetasCalls).toBeGreaterThan(afterFirst);
		} finally {
			at.mockRestore();
		}
	});

	it('evicts the oldest miss entries once META_MAX_ENTRIES is exceeded', async () => {
		// Seed 2005 miss entries through the same write path the live stat
		// handler uses (missCacheWrite: expiry sweep + FIFO cap) — mirrors
		// the metadata cache cap test's shape without HTTP round-trips.
		const N = 2005;
		const missErr = { errno: -9 };
		for (let i = 0; i < N; i += 1) metaMissCacheSeedForTest(`/capmiss-${i}.txt`, missErr);
		expect(metaMissCacheSize()).toBeLessThanOrEqual(2000);
		// 2005 inserts, cap 2000: the first five were FIFO-evicted during
		// seeding; the oldest survivor is capmiss-5, the newest survives.
		expect(metaMissCacheHasForTest('/capmiss-0.txt')).toBe(false);
		expect(metaMissCacheHasForTest('/capmiss-4.txt')).toBe(false);
		expect(metaMissCacheHasForTest('/capmiss-5.txt')).toBe(true);
		expect(metaMissCacheHasForTest(`/capmiss-${N - 1}.txt`)).toBe(true);
	});
});

describe('PUT and MKCOL parents', () => {
	it('PUT to a new file returns 201', async () => {
		const res = await request('/put-new.txt', {
			method: 'PUT',
			headers: { 'Content-Type': 'text/plain' },
			body: 'hello world',
		});
		expect(res.status).toBe(201);
		const node = tb.find('/put-new.txt');
		expect(node?.size).toBe(11);
		expect(new TextDecoder().decode(node?.content)).toBe('hello world');
	});

	it('PUT over an existing file returns 204 and replaces content', async () => {
		const res = await request('/a.txt', {
			method: 'PUT',
			headers: { 'Content-Type': 'text/plain' },
			body: 'overwritten!',
		});
		expect(res.status).toBe(204);
		expect(tb.find('/a.txt')!.size).toBe(12);
	});

	it('PUT of an empty file returns 201', async () => {
		const res = await request('/empty.txt', { method: 'PUT', body: '' });
		expect(res.status).toBe(201);
		expect(tb.find('/empty.txt')?.size).toBe(0);
	});

	it('PUT with a missing parent is 409 (RFC 4918 §9.7.1)', async () => {
		const res = await request('/nested/deep/file.txt', { method: 'PUT', body: 'deep' });
		expect(res.status).toBe(409);
		expect(tb.find('/nested')).toBeUndefined();
		// The RFC flow works: create the tree, then PUT.
		expect((await request('/nested', { method: 'MKCOL' })).status).toBe(201);
		expect((await request('/nested/deep', { method: 'MKCOL' })).status).toBe(201);
		expect((await request('/nested/deep/file.txt', { method: 'PUT', body: 'deep' })).status).toBe(201);
		expect(tb.find('/nested/deep/file.txt')?.size).toBe(4);
	});

	it('PUT to the root is forbidden', async () => {
		const res = await request('/', { method: 'PUT', body: 'x' });
		expect(res.status).toBe(403);
	});

	it('uploads succeed even when the premium probe fails (bclone parity)', async () => {
		tb.membershipErrno = -6;
		const res = await request('/prem-probe.txt', { method: 'PUT', body: 'still works' });
		expect(res.status).toBe(201);
		expect(new TextDecoder().decode(tb.find('/prem-probe.txt')!.content)).toBe('still works');
	});

	it('reports the failing upload stage and errno in the error body without leaking upstream text', async () => {
		tb.precreateErrno = 4000023;
		const res = await request('/stuck.txt', { method: 'PUT', body: 'x' });
		expect(res.status).toBe(401);
		const body = (await res.json()) as { error: string; errno?: number; step?: string; upstream?: string };
		expect(body.errno).toBe(4000023);
		expect(body.step).toBe('precreate');
		// Round 17: upstream snippets and cookie metadata are server-log only.
		expect(body.upstream).toBeUndefined();
		expect(body).not.toHaveProperty('cookieKeys');
	});

	it('fails over to the next candidate server when a cluster answers 403', async () => {
		// Mirrors the browser: locateupload returns server[] and the upload
		// walks it until one cluster accepts (31045 "user not exists" = wrong
		// cluster). The first candidate rejects, the real host works.
		const good = new URL(UPLOAD_BASE).host;
		tb.locateServers = ['bad-pcs.example', good];
		tb.rejectHosts.add('bad-pcs.example');
		const res = await request('/failover.txt', { method: 'PUT', body: 'via second server' });
		expect(res.status).toBe(201);
		expect(new TextDecoder().decode(tb.find('/failover.txt')!.content)).toBe('via second server');
	});

	it('fails over when a host answers 200 with no md5 (no HTTP status)', async () => {
		// A 200-with-error-body throws a TeraboxError WITHOUT httpStatus, so
		// the old gate (`httpStatus !== undefined`) aborted the ladder and the
		// upload failed 502 where failover was designed to succeed.
		const good = new URL(UPLOAD_BASE).host;
		tb.locateServers = ['silent-pcs.example', good];
		tb.silentHosts.add('silent-pcs.example');
		const res = await request('/silent.txt', { method: 'PUT', body: 'via second server' });
		expect(res.status).toBe(201);
		expect(new TextDecoder().decode(tb.find('/silent.txt')!.content)).toBe('via second server');
	});

	it('an integrity failure still refreshes the metadata cache', async () => {
		// create() replaced the content upstream before the md5 check failed,
		// so the read path must not keep serving the pre-PUT validators.
		tb.seed('/integrity.txt', { content: 'old' });
		const before = await request('/integrity.txt', { method: 'HEAD' });
		const beforeEtag = before.headers.get('ETag');
		expect(before.headers.get('Content-Length')).toBe('3');

		tb.corruptCreateMd5 = true;
		try {
			const put = await request('/integrity.txt', { method: 'PUT', body: 'new bytes' });
			expect(put.status).toBe(502);
		} finally {
			tb.corruptCreateMd5 = false;
		}
		expect(tb.find('/integrity.txt')!.size).toBe(9);

		const after = await request('/integrity.txt', { method: 'HEAD' });
		expect(after.headers.get('Content-Length')).toBe('9');
		expect(after.headers.get('ETag')).not.toBe(beforeEtag);
	});
});

describe('resumable upload', () => {
	it('uploads a multi-chunk file across separate requests', async () => {
		// A file larger than one chunk exercises the multipart path end-to-end:
		// begin → per-chunk PUTs → finalize, each a distinct HTTP request.
		// 4 MiB + tail spans 2 chunks under the 4 MiB free-plan default; the
		// loop slices by the negotiated size, not an assumed one.
		const MiB = 1024 * 1024;
		const total = 4 * MiB + 1000;
		const data = new Uint8Array(total);
		for (let i = 0; i < total; i += 1) data[i] = i % 251;

		const begin = await request('/.resumable', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ path: '/big.bin', size: total }),
		});
		expect(begin.status).toBe(200);
		const begun = (await begin.json()) as { uploadId: string; chunkSize: number; chunkCount: number };
		expect(begun.chunkSize).toBe(4 * MiB); // free-plan default = smallest legal slice (31299 floor)
		expect(begun.chunkCount).toBe(Math.ceil(total / begun.chunkSize));

		for (let index = 0; index < begun.chunkCount; index += 1) {
			const start = index * begun.chunkSize;
			const end = Math.min(start + begun.chunkSize, total);
			const chunk = data.subarray(start, end);
			const put = await request(`/.resumable/${begun.uploadId}/${index}`, {
				method: 'PUT',
				body: chunk,
			});
			expect(put.status).toBe(200);
			const { md5 } = (await put.json()) as { md5: string };
			expect(md5).toMatch(/^[0-9a-f]{32}$/);
		}

		const fin = await request(`/.resumable/${begun.uploadId}/finalize`, { method: 'POST' });
		expect(fin.status).toBe(201);
		const landed = tb.find('/big.bin')!;
		expect(landed.size).toBe(total);
		// Byte-for-byte compare: vitest's toEqual walks a 4.19 MB typed array
		// structurally and takes 24-33 s on a loaded machine — against the
		// test's own 30 s budget that made this pin flaky for timing reasons
		// alone. A linear scan is the same assertion in milliseconds.
		const got = landed.content!;
		expect(got.length).toBe(data.length);
		let diff = -1;
		for (let i = 0; i < data.length; i += 1) {
			if (got[i] !== data[i]) {
				diff = i;
				break;
			}
		}
		expect(diff).toBe(-1);
	}, 30000);

	it('replays the same status when finalize is retried', async () => {
		// If the finalize response is lost in transit, the client's retry
		// must not read 404 as "upload failed" for a file that landed.
		const data = new Uint8Array(64).fill(7);
		const begin = await request('/.resumable', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ path: '/retry-fin.bin', size: data.byteLength }),
		});
		const { uploadId } = (await begin.json()) as { uploadId: string };
		const put = await request(`/.resumable/${uploadId}/0`, { method: 'PUT', body: data });
		expect(put.status).toBe(200);

		const first = await request(`/.resumable/${uploadId}/finalize`, { method: 'POST' });
		expect(first.status).toBe(201);
		const retry = await request(`/.resumable/${uploadId}/finalize`, { method: 'POST' });
		expect(retry.status).toBe(201);
		expect(tb.find('/retry-fin.bin')!.content).toEqual(data);
	}, 30000);

	it('two concurrent finalizes run one create and answer the same status', async () => {
		// A client retry can land while the first finalize is still running
		// its create. Without the atomic claim both requests passed the
		// `finalized` read and raced a second create — the loser got -8
		// (path conflict) for a file that HAD landed.
		const data = new Uint8Array(64).fill(9);
		const begin = await request('/.resumable', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ path: '/race-fin.bin', size: data.byteLength }),
		});
		const { uploadId } = (await begin.json()) as { uploadId: string };
		const put = await request(`/.resumable/${uploadId}/0`, { method: 'PUT', body: data });
		expect(put.status).toBe(200);

		const before = tb.createCalls;
		const [first, second] = await Promise.all([
			request(`/.resumable/${uploadId}/finalize`, { method: 'POST' }),
			request(`/.resumable/${uploadId}/finalize`, { method: 'POST' }),
		]);
		expect(first.status).toBe(201);
		expect(second.status).toBe(201);
		// Exactly one upstream create: the loser replayed instead of racing.
		expect(tb.createCalls - before).toBe(1);
		expect(tb.find('/race-fin.bin')!.content).toEqual(data);
	}, 30000);

	it('rejects finalize when a chunk is missing', async () => {
		const begin = await request('/.resumable', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ path: '/missing.bin', size: 8 * 1024 * 1024 }),
		});
		const { uploadId, chunkCount } = (await begin.json()) as { uploadId: string; chunkCount: number };
		expect(chunkCount).toBe(2);
		// Upload only chunk 0; chunk 1 stays missing.
		const put = await request(`/.resumable/${uploadId}/0`, {
			method: 'PUT',
			body: new Uint8Array(4 * 1024 * 1024),
		});
		expect(put.status).toBe(200);
		const fin = await request(`/.resumable/${uploadId}/finalize`, { method: 'POST' });
		expect(fin.status).toBe(409);
	});

	it('rejects a chunk whose size does not match the session', async () => {
		const begin = await request('/.resumable', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ path: '/badsize.bin', size: 8 * 1024 * 1024 }),
		});
		const { uploadId } = (await begin.json()) as { uploadId: string };
		const put = await request(`/.resumable/${uploadId}/0`, {
			method: 'PUT',
			body: new Uint8Array(100), // wrong: should be 4 MiB
		});
		expect(put.status).toBe(400);
	});

	it('404s an unknown upload session', async () => {
		const put = await request('/.resumable/nope/0', { method: 'PUT', body: 'x' });
		expect(put.status).toBe(404);
		const fin = await request('/.resumable/nope/finalize', { method: 'POST' });
		expect(fin.status).toBe(404);
	});

	it('cancels an upload with DELETE so its chunks stop lingering', async () => {
		const begin = await request('/.resumable', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ path: '/cancel.bin', size: 4 }),
		});
		const { uploadId } = (await begin.json()) as { uploadId: string };
		const put = await request(`/.resumable/${uploadId}/0`, { method: 'PUT', body: 'abcd' });
		expect(put.status).toBe(200);

		expect((await request(`/.resumable/${uploadId}`, { method: 'DELETE' })).status).toBe(204);
		// The session is gone: finalize reads unknown, not as a replay.
		expect((await request(`/.resumable/${uploadId}/finalize`, { method: 'POST' })).status).toBe(404);
		// Unknown ids are 404, same as the other routes.
		expect((await request('/.resumable/nope', { method: 'DELETE' })).status).toBe(404);
	});

	it('never lets the client choose the conflict policy (overwriteMode)', async () => {
		// rtype 1 (rename) would make Terabox write `dest(1).txt` while we
		// answer 204 at the requested path — a success reported for a path
		// never touched. Existing → overwrite (3), new → create-only (0).
		const beginOver = await request('/.resumable', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ path: '/dest.txt', size: 5, overwriteMode: 1 }),
		});
		const over = (await beginOver.json()) as { uploadId: string };
		await request(`/.resumable/${over.uploadId}/0`, { method: 'PUT', body: 'fresh' });
		const done = await request(`/.resumable/${over.uploadId}/finalize`, { method: 'POST' });
		expect(done.status).toBe(204);
		expect(tb.lastRtype).toBe(3); // server's choice, not the client's 1
		expect(new TextDecoder().decode(tb.find('/dest.txt')!.content)).toBe('fresh');
		expect(tb.find('/dest(1).txt')).toBeUndefined();

		const beginNew = await request('/.resumable', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ path: '/brand-new.bin', size: 4, overwriteMode: 3 }),
		});
		const fresh = (await beginNew.json()) as { uploadId: string };
		await request(`/.resumable/${fresh.uploadId}/0`, { method: 'PUT', body: 'abcd' });
		const created = await request(`/.resumable/${fresh.uploadId}/finalize`, { method: 'POST' });
		expect(created.status).toBe(201);
		expect(tb.lastRtype).toBe(0); // create-only for a path that did not exist
	});

	it('collapses `..` segments in the JSON path (no mount escape)', async () => {
		// A crafted `..` in the JSON body must not walk above the mount root:
		// decodePathname collapses it for URL paths, and the resumable JSON
		// path gets the identical cleanup before toTera concatenates.
		const begin = await request('/.resumable', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ path: '/docs/../../escape.bin', size: 5 }),
		});
		expect(begin.status).toBe(200);
		const { uploadId } = (await begin.json()) as { uploadId: string };
		const put = await request(`/.resumable/${uploadId}/0`, { method: 'PUT', body: 'oops!' });
		expect(put.status).toBe(200);
		const fin = await request(`/.resumable/${uploadId}/finalize`, { method: 'POST' });
		expect(fin.status).toBe(201);
		// ".." collapses out: /docs/../../escape.bin → /escape.bin, not a
		// traversal above the root.
		expect(tb.find('/escape.bin')).toBeTruthy();
		expect(tb.find('/docs/../../escape.bin')).toBeFalsy();
	});

	it('respects locks: begin on a locked path is 423 without the token', async () => {
		const lockBody =
			'<D:lockinfo xmlns:D="DAV:"><D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype><D:owner><D:href>tester</D:href></D:owner></D:lockinfo>';
		const lock = await request('/a.txt', {
			method: 'LOCK',
			headers: { 'Content-Type': 'application/xml' },
			body: lockBody,
		});
		expect(lock.status).toBe(200);
		// Resumable upload is a write; without the lock token it must 423
		// exactly like PUT, not slip past the lock.
		const begin = await request('/.resumable', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ path: '/a.txt', size: 5 }),
		});
		expect(begin.status).toBe(423);
	});

	it('overwrites an existing file (204) via resumable', async () => {
		const begin = await request('/.resumable', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ path: '/a.txt', size: 5 }),
		});
		const { uploadId } = (await begin.json()) as { uploadId: string };
		const put = await request(`/.resumable/${uploadId}/0`, { method: 'PUT', body: 'fresh' });
		expect(put.status).toBe(200);
		const fin = await request(`/.resumable/${uploadId}/finalize`, { method: 'POST' });
		expect(fin.status).toBe(204);
		expect(new TextDecoder().decode(tb.find('/a.txt')!.content)).toBe('fresh');
	});

	it('finalize honours a lock taken AFTER begin', async () => {
		// begin is not the write — finalize is. A lock landing between the two
		// must still block the resource creation (RFC 4918 §6).
		const put = await request('/mid-lock.txt', { method: 'PUT', body: 'original' });
		expect(put.status).toBe(201);
		const begin = await request('/.resumable', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ path: '/mid-lock.txt', size: 5 }),
		});
		const { uploadId } = (await begin.json()) as { uploadId: string };
		expect((await request(`/.resumable/${uploadId}/0`, { method: 'PUT', body: 'fresh' })).status).toBe(200);

		const lock = await request('/mid-lock.txt', {
			method: 'LOCK',
			headers: { 'Content-Type': 'application/xml' },
			body: '<D:lockinfo xmlns:D="DAV:"><D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype><D:owner>t</D:owner></D:lockinfo>',
		});
		expect(lock.status).toBe(200);
		const token = lock.headers.get('Lock-Token')!;

		const blocked = await request(`/.resumable/${uploadId}/finalize`, { method: 'POST' });
		expect(blocked.status).toBe(423);
		expect(new TextDecoder().decode(tb.find('/mid-lock.txt')!.content)).toBe('original');

		const allowed = await request(`/.resumable/${uploadId}/finalize`, {
			method: 'POST',
			headers: { If: `(${token})` },
		});
		expect(allowed.status).toBe(204);
		expect(new TextDecoder().decode(tb.find('/mid-lock.txt')!.content)).toBe('fresh');
	});

	it('an integrity failure at finalize answers 502 on every retry', async () => {
		// create() succeeded upstream but the control md5 disagrees. Re-running
		// create would reproduce the mismatch and (create-only) answer -8/409 —
		// the session must replay the real failure instead.
		tb.corruptCreateMd5 = true;
		try {
			const begin = await request('/.resumable', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ path: '/corrupt.bin', size: 4 }),
			});
			const { uploadId } = (await begin.json()) as { uploadId: string };
			expect((await request(`/.resumable/${uploadId}/0`, { method: 'PUT', body: 'abcd' })).status).toBe(200);

			const first = await request(`/.resumable/${uploadId}/finalize`, { method: 'POST' });
			expect(first.status).toBe(502);
			expect(tb.find('/corrupt.bin')).toBeDefined(); // the file DID land

			const retry = await request(`/.resumable/${uploadId}/finalize`, { method: 'POST' });
			expect(retry.status).toBe(502);
		} finally {
			tb.corruptCreateMd5 = false;
		}
	});

	it('never sizes a chunk above the request-body budget', async () => {
		const MiB = 1024 * 1024;
		const GiB = 1024 * MiB;
		// Free tier keeps Terabox's 4 MiB; VIP tiers are capped so the chunk +
		// its multipart envelope stay under both the edge body limit and the
		// isolate's memory ceiling.
		expect(getChunkSize(1024, false)).toBe(4 * MiB);
		// Default cap (4 MiB) clips the premium buckets: MAX_CHUNK_BYTES on a
		// paid deployment is what raises the ceiling back to them.
		expect(getChunkSize(8 * GiB, true)).toBe(4 * MiB);
		expect(getChunkSize(64 * GiB, true)).toBe(4 * MiB);
		// Explicit cap (Workers paid / MAX_CHUNK_BYTES) restores the buckets.
		expect(getChunkSize(8 * GiB, true, 32 * MiB)).toBe(8 * MiB);
		expect(getChunkSize(64 * GiB, true, 32 * MiB)).toBe(32 * MiB);
		expect(getChunkSize(128 * GiB, true, 32 * MiB)).toBe(32 * MiB);
		// A tiny cap cannot sink a SPLITTING upload below 4 MiB: upstream
		// rejects a full-size first part under that (31299), so the floor
		// wins over the cap. Single-part files keep the small size (their
		// one part is the short last part, which upstream allows).
		expect(getChunkSize(5 * MiB, false, 2 * MiB)).toBe(4 * MiB);
		expect(getChunkSize(1024, false, 1 * MiB)).toBe(1 * MiB);
	});
});

describe('DELETE', () => {
	it('deletes a file and returns 204', async () => {
		const res = await request('/a.txt', { method: 'DELETE' });
		expect(res.status).toBe(204);
		expect(tb.find('/a.txt')).toBeUndefined();
	});

	it('returns 404 for a missing file', async () => {
		const res = await request('/missing.txt', { method: 'DELETE' });
		expect(res.status).toBe(404);
	});

	it('refuses to delete the root', async () => {
		const res = await request('/', { method: 'DELETE' });
		expect(res.status).toBe(403);
	});
});

describe('MOVE / COPY', () => {
	it('a Destination on another host is 502, never a local path', async () => {
		// RFC 4918 §10.3 contemplates 502 here. Treating a foreign host as a
		// local path would move the file somewhere the client never named.
		const res = await request('/a.txt', {
			method: 'MOVE',
			headers: { Destination: 'https://other.example/dav/somewhere.txt' },
		});
		expect(res.status).toBe(502);
		expect(tb.find('/a.txt')).toBeDefined();
		expect(tb.find('/somewhere.txt')).toBeUndefined();
	});

	it('treats a protocol-relative Destination as another origin (502)', async () => {
		// `new URL('//other.example/x')` throws without a base; the path
		// fallback would have moved the file to a LOCAL `/other.example/x`.
		const res = await request('/a.txt', {
			method: 'MOVE',
			headers: { Destination: '//other.example/x.txt' },
		});
		expect(res.status).toBe(502);
		expect(tb.find('/a.txt')).toBeDefined();
		expect(tb.find('/other.example')).toBeUndefined();
		expect(tb.find('/other.example/x.txt')).toBeUndefined();
	});

	it('ignores a stale cached destination (fresh stat drives Overwrite)', async () => {
		// The cache claims /newfile.txt exists; upstream says it does not.
		// A cached stat would pre-delete a missing path (-9 → 404) and lose
		// the move; the overwrite decision must use live metadata.
		metaCacheSeedForTest('/newfile.txt', {
			path: '/newfile.txt',
			server_filename: 'newfile.txt',
			isdir: 0,
			size: 9,
			server_mtime: 1704067200,
			md5: 'ffffffffffffffffffffffffffffffff',
		} as never);
		expect(metaCacheHasForTest('/newfile.txt')).toBe(true);
		const res = await request('/a.txt', {
			method: 'MOVE',
			headers: { Destination: ORIGIN + '/newfile.txt' },
		});
		expect(res.status).toBe(201);
		expect(new TextDecoder().decode(tb.find('/newfile.txt')!.content)).toBe(
			'the quick brown fox\n',
		);
		expect(tb.find('/a.txt')).toBeUndefined();
	});

	it('MOVE to a new destination returns 201', async () => {
		const originalSize = tb.find('/a.txt')!.size;
		const res = await request('/a.txt', {
			method: 'MOVE',
			headers: { Destination: ORIGIN + '/moved.txt' },
		});
		expect(res.status).toBe(201);
		expect(tb.find('/a.txt')).toBeUndefined();
		expect(tb.find('/moved.txt')?.size).toBe(originalSize);
	});

	it('MOVE with Overwrite replaces the target and returns 204', async () => {
		const res = await request('/a.txt', {
			method: 'MOVE',
			headers: { Destination: ORIGIN + '/dest.txt' },
		});
		expect(res.status).toBe(204);
		expect(tb.find('/a.txt')).toBeUndefined();
		expect(tb.find('/dest.txt')).toBeDefined();
	});

	it('MOVE with Overwrite: F onto an existing target returns 412', async () => {
		const res = await request('/a.txt', {
			method: 'MOVE',
			headers: { Destination: ORIGIN + '/dest.txt', Overwrite: 'F' },
		});
		expect(res.status).toBe(412);
		expect(tb.find('/a.txt')).toBeDefined();
	});

	it('MOVE onto itself returns 204 and leaves the file alone', async () => {
		const res = await request('/a.txt', {
			method: 'MOVE',
			headers: { Destination: ORIGIN + '/a.txt' },
		});
		expect(res.status).toBe(204);
		expect(tb.find('/a.txt')).toBeDefined();
	});

	it('MOVE without a Destination header returns 400', async () => {
		const res = await request('/a.txt', { method: 'MOVE' });
		expect(res.status).toBe(400);
	});

	it('COPY to a new destination returns 201 and keeps the source', async () => {
		const res = await request('/a.txt', {
			method: 'COPY',
			headers: { Destination: ORIGIN + '/cp.txt' },
		});
		expect(res.status).toBe(201);
		expect(tb.find('/a.txt')).toBeDefined();
		expect(tb.find('/cp.txt')).toBeDefined();
	});

	it('COPY onto itself returns 403', async () => {
		const res = await request('/a.txt', {
			method: 'COPY',
			headers: { Destination: ORIGIN + '/a.txt' },
		});
		expect(res.status).toBe(403);
	});

	it('COPY onto an existing target with Overwrite: F returns 412', async () => {
		const res = await request('/a.txt', {
			method: 'COPY',
			headers: { Destination: ORIGIN + '/dest.txt', Overwrite: 'F' },
		});
		expect(res.status).toBe(412);
	});

	it('MOVEs a folder with its children', async () => {
		const res = await request('/docs', {
			method: 'MOVE',
			headers: { Destination: ORIGIN + '/docs-copy' },
		});
		expect(res.status).toBe(201);
		expect(tb.find('/docs')).toBeUndefined();
		expect(tb.find('/docs-copy')).toBeDefined();
		expect(tb.find('/docs-copy/b & c.txt')).toBeDefined();
		expect(tb.find('/docs-copy/sub&dir')).toBeDefined();
	});
});
describe('RFC 4918 conformance', () => {
	const LOCK_BODY =
		'<D:lockinfo xmlns:D="DAV:"><D:lockscope><D:exclusive/></D:lockscope>' +
		'<D:locktype><D:write/></D:locktype><D:owner><D:href>tester</D:href></D:owner></D:lockinfo>';

	it('MKCOL with a body is 415, not a silent ignore', async () => {
		const res = await request('/with-body', {
			method: 'MKCOL',
			headers: { 'Content-Type': 'application/xml' },
			body: '<D:mkcol xmlns:D="DAV:"><D:set><D:prop><D:displayname>x</D:displayname></D:prop></D:set></D:mkcol>',
		});
		expect(res.status).toBe(415);
		expect(tb.find('/with-body')).toBeUndefined();
	});

	it('PUT over an existing collection is 405', async () => {
		await request('/col', { method: 'MKCOL' });
		const res = await request('/col', { method: 'PUT', body: 'x' });
		expect(res.status).toBe(405);
		expect(tb.find('/col')!.isdir).toBe(1);
	});

	it('passes an unsatisfiable Range through as 416', async () => {
		const res = await request('/a.txt', { headers: { Range: 'bytes=99999999-100000000' } });
		expect(res.status).toBe(416);
		expect(res.headers.get('Content-Range')).toContain('/');
	});

	it('answers 416 for any range starting at or beyond EOF', async () => {
		// Validated locally against itemInfo's size: no CDN round-trip whose
		// out-of-bounds verdict varies by cluster (some answer 400141 gates).
		const size = tb.find('/a.txt')!.size;
		const res = await request('/a.txt', { headers: { Range: `bytes=${size}-${size + 5}` } });
		expect(res.status).toBe(416);
		expect(res.headers.get('Content-Range')).toBe(`bytes */${size}`);
	});

	it('honours a suffix range (bytes=-4)', async () => {
		const res = await request('/a.txt', { headers: { Range: 'bytes=-4' } });
		expect(res.status).toBe(206);
		expect(await res.text()).toBe('fox\n');
	});

	it('ignores a malformed Range and serves the full entity', async () => {
		const res = await request('/a.txt', { headers: { Range: 'kilobytes=0-2' } });
		expect(res.status).toBe(200);
		expect(await res.text()).toBe('the quick brown fox\n');
	});

	it('304s on a matching If-None-Match without a body', async () => {
		const md5 = tb.find('/a.txt')!.md5;
		const res = await request('/a.txt', { headers: { 'If-None-Match': `"${md5}"` } });
		expect(res.status).toBe(304);
		expect(res.headers.get('ETag')).toBe(`"${md5}"`);
		expect((await new Response(res.body).arrayBuffer()).byteLength).toBe(0);
	});

	it('304s on a fresh If-Modified-Since', async () => {
		const mtime = tb.find('/a.txt')!.server_mtime!;
		const res = await request('/a.txt', {
			headers: { 'If-Modified-Since': new Date(mtime * 1000).toUTCString() },
		});
		expect(res.status).toBe(304);
	});

	it('still streams on a mismatched If-None-Match', async () => {
		const res = await request('/a.txt', { headers: { 'If-None-Match': '"stale"' } });
		expect(res.status).toBe(200);
		expect(await res.text()).toBe('the quick brown fox\n');
	});

	it('treats the range unit case-insensitively (BYTES=0-2 -> 206)', async () => {
		// ABNF literals are case-insensitive (RFC 7230 §3.2.2): a satisfied
		// range must not fall into the "unit not understood -> ignore" path.
		const res = await request('/a.txt', { headers: { Range: 'BYTES=0-2' } });
		expect(res.status).toBe(206);
		expect(await res.text()).toBe('the');
		expect(res.headers.get('Content-Range')).toBe(`bytes 0-2/${tb.find('/a.txt')!.size}`);
	});

	it('ignores Range when If-Range carries a date we never sent (serves 200)', async () => {
		// RFC 7233 §3.2: EXACT match, not "earlier or equal" — a newer date
		// (or an mtime that rolled back) must fall back to 200 rather than
		// splice fresh bytes into the client's old partial copy.
		const res = await request('/a.txt', {
			headers: { Range: 'bytes=0-2', 'If-Range': 'Thu, 01 Jan 2031 00:00:00 GMT' },
		});
		expect(res.status).toBe(200);
		expect(await res.text()).toBe('the quick brown fox\n');
	});

	it('ignores Range when If-Range carries a stale etag (serves 200)', async () => {
		const res = await request('/a.txt', {
			headers: { Range: 'bytes=0-2', 'If-Range': '"stale"' },
		});
		expect(res.status).toBe(200);
		expect(await res.text()).toBe('the quick brown fox\n');
	});

	it('honours Range when If-Range matches the current etag', async () => {
		const md5 = tb.find('/a.txt')!.md5;
		const res = await request('/a.txt', {
			headers: { Range: 'bytes=0-2', 'If-Range': `"${md5}"` },
		});
		expect(res.status).toBe(206);
		expect(await res.text()).toBe('the');
	});

	it('PROPFIND answers only the requested props and 404s the rest', async () => {
		const res = await request('/a.txt', {
			method: 'PROPFIND',
			headers: { Depth: '0', 'Content-Type': 'application/xml' },
			body:
				'<D:propfind xmlns:D="DAV:"><D:prop><D:displayname/><D:getcontentlanguage/>' +
				'<X:custom xmlns:X="urn:x-example"/></D:prop></D:propfind>',
		});
		expect(res.status).toBe(207);
		const body = await res.text();
		expect(body).toContain('<D:displayname>a.txt</D:displayname>');
		expect(body).toContain('HTTP/1.1 404 Not Found');
		// 404 propstats echo the client's element, made self-contained.
		expect(body).toContain('<D:getcontentlanguage xmlns:D="DAV:"/>');
		expect(body).toContain('<X:custom xmlns:X="urn:x-example"/>');
		// Not requested → not in any 200 propstat.
		expect(body).not.toContain('<D:getcontentlength>');
	});

	it('PROPFIND allprop keeps the full set (plus displayname/supportedlock)', async () => {
		const res = await request('/a.txt', { method: 'PROPFIND', headers: { Depth: '0' } });
		const body = await res.text();
		expect(body).toContain('<D:getcontentlength>');
		expect(body).toContain('<D:getetag>');
		expect(body).toContain('<D:displayname>a.txt</D:displayname>');
		expect(body).toContain('<D:supportedlock>');
		expect(body).toContain('<D:lockdiscovery/>');
	});

	it('PROPFIND propname returns names with empty values', async () => {
		const res = await request('/a.txt', {
			method: 'PROPFIND',
			headers: { Depth: '0' },
			body: '<D:propfind xmlns:D="DAV:"><D:propname/></D:propfind>',
		});
		expect(res.status).toBe(207);
		const body = await res.text();
		expect(body).toContain('<D:getetag/>');
		expect(body).toContain('<D:displayname/>');
		expect(body).not.toContain(`<D:getcontentlength>${tb.find('/a.txt')!.size}<`);
	});

	it('PROPFIND on a missing resource stays 404', async () => {
		const res = await request('/missing.txt', {
			method: 'PROPFIND',
			headers: { Depth: '0' },
			body: '<D:propfind xmlns:D="DAV:"><D:prop><D:displayname/></D:prop></D:propfind>',
		});
		expect(res.status).toBe(404);
	});

	it('LOCK returns a lockdiscovery document; UNLOCK answers 204', async () => {
		const res = await request('/a.txt', {
			method: 'LOCK',
			headers: { 'Content-Type': 'application/xml' },
			body: LOCK_BODY,
		});
		expect(res.status).toBe(200);
		const body = await res.text();
		expect(body).toContain('<D:activelock>');
		expect(body).toContain('opaquelocktoken:');
		expect(body).toContain('<D:timeout>Second-3600</D:timeout>');
		// Owner markup is stored self-contained (prefixes hoisted from the
		// request body), so re-emission in lockdiscovery can never go
		// namespace-dead when the client declared D: on the lock root only.
		expect(body).toContain('<D:owner xmlns:D="DAV:"><D:href xmlns:D="DAV:">tester</D:href></D:owner>');
		const token = res.headers.get('Lock-Token')!;
		expect(token).toContain('opaquelocktoken:');

		const unlock = await request('/a.txt', {
			method: 'UNLOCK',
			headers: { 'Lock-Token': token },
		});
		expect(unlock.status).toBe(204);
	});

	it('UNLOCK with a mismatched token is 409', async () => {
		const res = await request('/a.txt', {
			method: 'LOCK',
			headers: { 'Content-Type': 'application/xml' },
			body: LOCK_BODY,
		});
		const token = res.headers.get('Lock-Token')!;
		const bogus = await request('/a.txt', {
			method: 'UNLOCK',
			headers: { 'Lock-Token': '<opaquelocktoken:00000000-0000-0000-0000-000000000000:123>' },
		});
		expect(bogus.status).toBe(409);
		const missingHeader = await request('/a.txt', { method: 'UNLOCK' });
		expect(missingHeader.status).toBe(400);
		// The real token still works after the failed attempts.
		const unlock = await request('/a.txt', { method: 'UNLOCK', headers: { 'Lock-Token': token } });
		expect(unlock.status).toBe(204);
	});

	it('LOCK on an unmapped name succeeds (201) without creating it', async () => {
		const res = await request('/brand-new.txt', {
			method: 'LOCK',
			headers: { 'Content-Type': 'application/xml' },
			body: LOCK_BODY,
		});
		expect(res.status).toBe(201);
		expect(tb.find('/brand-new.txt')).toBeUndefined();
	});

	it('LOCK honours Timeout and refreshes the same token via If', async () => {
		const first = await request('/a.txt', {
			method: 'LOCK',
			headers: { 'Content-Type': 'application/xml', Timeout: 'Second-60' },
			body: LOCK_BODY,
		});
		expect(await first.text()).toContain('<D:timeout>Second-60</D:timeout>');
		const token = first.headers.get('Lock-Token')!;
		const refresh = await request('/a.txt', {
			method: 'LOCK',
			headers: { 'Content-Type': 'application/xml', If: `(${token})` },
			body: LOCK_BODY,
		});
		expect(refresh.status).toBe(200);
		expect(refresh.headers.get('Lock-Token')).toBe(token);
	});

	it('PROPPATCH returns a 207 multistatus echoing the set props', async () => {
		const res = await request('/a.txt', {
			method: 'PROPPATCH',
			headers: { 'Content-Type': 'application/xml' },
			body:
				'<D:propertyupdate xmlns:D="DAV:"><D:set><D:prop>' +
				'<X:foo xmlns:X="urn:x-example">bar</X:foo></D:prop></D:set></D:propertyupdate>',
		});
		expect(res.status).toBe(207);
		const body = await res.text();
		expect(body).toContain('<D:multistatus');
		expect(body).toContain('HTTP/1.1 200 OK');
		expect(body).toContain('<X:foo xmlns:X="urn:x-example">bar</X:foo>');
		expect(body).toContain('<D:href>/a.txt</D:href>');
	});

	it('PROPPATCH on a missing resource is 404', async () => {
		const res = await request('/missing.txt', {
			method: 'PROPPATCH',
			headers: { 'Content-Type': 'application/xml' },
			body: '<D:propertyupdate xmlns:D="DAV:"><D:set><D:prop><D:displayname>x</D:displayname></D:prop></D:set></D:propertyupdate>',
		});
		expect(res.status).toBe(404);
	});

	it('OPTIONS advertises the full method set', async () => {
		const res = await request('/', { method: 'OPTIONS' });
		const allow = res.headers.get('Allow')!;
		for (const method of ['PROPFIND', 'PROPPATCH', 'LOCK', 'UNLOCK', 'COPY', 'MOVE']) {
			expect(allow).toContain(method);
		}
	});
});

describe('overwrite semantics (server never replaces in place)', () => {
	it('MOVE Overwrite: T deletes the target first and returns 204', async () => {
		const res = await request('/dest.txt', {
			method: 'MOVE',
			headers: { Destination: ORIGIN + '/a.txt', Overwrite: 'T' },
		});
		expect(res.status).toBe(204);
		expect(new TextDecoder().decode(tb.find('/a.txt')!.content!)).toBe('dest content');
		expect(tb.find('/dest.txt')).toBeUndefined();
	});

	it('COPY Overwrite: T replaces the target, keeps the source, returns 204', async () => {
		const res = await request('/a.txt', {
			method: 'COPY',
			headers: { Destination: ORIGIN + '/dest.txt', Overwrite: 'T' },
		});
		expect(res.status).toBe(204);
		expect(new TextDecoder().decode(tb.find('/dest.txt')!.content!)).toBe('the quick brown fox\n');
		expect(tb.find('/a.txt')).toBeDefined();
	});

	it('MOVE Overwrite: T over a folder replaces the whole tree', async () => {
		await request('/target-dir', { method: 'MKCOL' });
		await request('/target-dir/old.txt', { method: 'PUT', body: 'old' });
		const res = await request('/docs', {
			method: 'MOVE',
			headers: { Destination: ORIGIN + '/target-dir', Overwrite: 'T' },
		});
		expect(res.status).toBe(204);
		expect(tb.find('/target-dir')).toBeDefined();
		expect(tb.find('/target-dir/old.txt')).toBeUndefined();
		expect(tb.find('/target-dir/b & c.txt')).toBeDefined();
		expect(tb.find('/docs')).toBeUndefined();
	});
});

describe('XML request validation', () => {
	it('rejects raw XML-invalid characters (C0 controls) in PROPPATCH and LOCK', async () => {
		// Numeric references (\u0026#1;) were already rejected — the RAW byte
		// slipped through, got stored, and re-appeared in every later
		// PROPFIND 207: strict clients then failed the whole listing, a
		// persistent browse DoS with no client-side workaround.
		const patched = await request('/a.txt', {
			method: 'PROPPATCH',
			headers: { 'Content-Type': 'application/xml' },
			body:
				'<D:propertyupdate xmlns:D="DAV:"><D:set><D:prop><X:t xmlns:X="urn:x">\u0001</X:t></D:prop></D:set></D:propertyupdate>',
		});
		expect(patched.status).toBe(400);

		const locked = await request('/a.txt', {
			method: 'LOCK',
			headers: { 'Content-Type': 'application/xml' },
			body:
				'<D:lockinfo xmlns:D="DAV:"><D:lockscope><D:exclusive/></D:lockscope>' +
				'<D:locktype><D:write/></D:locktype><D:owner>bad\u0000owner</D:owner></D:lockinfo>',
		});
		expect(locked.status).toBe(400);
	});

	it('PROPFIND with non-well-formed XML is 400, not a silent allprop', async () => {
		const res = await request('/a.txt', {
			method: 'PROPFIND',
			headers: { Depth: '0', 'Content-Type': 'application/xml' },
			body: '<foo>',
		});
		expect(res.status).toBe(400);
	});

	it('PROPFIND with an empty namespace binding is 400', async () => {
		const res = await request('/a.txt', {
			method: 'PROPFIND',
			headers: { Depth: '0', 'Content-Type': 'application/xml' },
			body:
				'<D:propfind xmlns:D="DAV:"><D:prop><bar:foo xmlns:bar=""/></D:prop></D:propfind>',
		});
		expect(res.status).toBe(400);
	});

	it('PROPFIND with an undeclared prefix is 400', async () => {
		const res = await request('/a.txt', {
			method: 'PROPFIND',
			headers: { Depth: '0', 'Content-Type': 'application/xml' },
			body: '<E:propfind xmlns:D="DAV:"><D:prop><D:displayname/></D:prop></E:propfind>',
		});
		expect(res.status).toBe(400);
	});

	it('PROPFIND with mismatched close tags is 400', async () => {
		const res = await request('/a.txt', {
			method: 'PROPFIND',
			headers: { Depth: '0', 'Content-Type': 'application/xml' },
			body: '<D:propfind xmlns:D="DAV:"><D:prop><D:displayname></D:prop></D:propfind>',
		});
		expect(res.status).toBe(400);
	});

	it('PROPPATCH with non-well-formed XML is 400', async () => {
		const res = await request('/a.txt', {
			method: 'PROPPATCH',
			headers: { 'Content-Type': 'application/xml' },
			body: '<D:propertyupdate xmlns:D="DAV:"><D:set><D:prop>',
		});
		expect(res.status).toBe(400);
	});

	it('rejects shapes that are well-formed-looking but not XML', async () => {
		// Each of these would be accepted, STORED as a dead property, and then
		// re-emitted in every later PROPFIND — turning one bad request into a
		// permanently unparseable response for every client that reads it.
		const bodies = [
			// '<' inside an attribute value must be &lt; (XML 1.0 §3.1).
			'<D:propertyupdate xmlns:D="DAV:"><D:set><D:prop>' +
				'<X:foo xmlns:X="urn:x" a="x<y">v</X:foo></D:prop></D:set></D:propertyupdate>',
			// ']]>' is banned in character data outside CDATA (§2.4).
			'<D:propertyupdate xmlns:D="DAV:"><D:set><D:prop>' +
				'<X:foo xmlns:X="urn:x">a]]>b</X:foo></D:prop></D:set></D:propertyupdate>',
			// No '--' inside a comment (§2.5).
			'<D:propertyupdate xmlns:D="DAV:"><D:set><D:prop>' +
				'<X:foo xmlns:X="urn:x"><!-- a -- b -->v</X:foo></D:prop></D:set></D:propertyupdate>',
			// Numeric references must name a legal XML character (§2.2).
			'<D:propertyupdate xmlns:D="DAV:"><D:set><D:prop>' +
				'<X:foo xmlns:X="urn:x">&#0;</X:foo></D:prop></D:set></D:propertyupdate>',
			// AttValue must be quoted (§3.1): `a=c` is not XML.
			'<D:propertyupdate xmlns:D="DAV:"><D:set><D:prop>' +
				'<X:foo xmlns:X="urn:x" a=c>v</X:foo></D:prop></D:set></D:propertyupdate>',
			// Duplicate attribute names are banned (§3.1).
			'<D:propertyupdate xmlns:D="DAV:"><D:set><D:prop>' +
				'<X:foo xmlns:X="urn:x" a="1" a="2">v</X:foo></D:prop></D:set></D:propertyupdate>',
			// Only attributes may follow the element name: a bare name is junk.
			'<D:propertyupdate xmlns:D="DAV:"><D:set><D:prop>' +
				'<X:foo xmlns:X="urn:x" bare>v</X:foo></D:prop></D:set></D:propertyupdate>',
			// Junk after a well-formed attribute, too.
			'<D:propertyupdate xmlns:D="DAV:"><D:set><D:prop>' +
				'<X:foo xmlns:X="urn:x" a="1" junk>v</X:foo></D:prop></D:set></D:propertyupdate>',
		];
		for (const body of bodies) {
			const res = await request('/a.txt', {
				method: 'PROPPATCH',
				headers: { 'Content-Type': 'application/xml' },
				body,
			});
			expect(res.status, body.slice(0, 60)).toBe(400);
		}
		// Nothing was persisted by any of them.
		const probe = await request('/a.txt', {
			method: 'PROPFIND',
			headers: { Depth: '0', 'Content-Type': 'application/xml' },
			body: '<D:propfind xmlns:D="DAV:" xmlns:X="urn:x"><D:allprop/></D:propfind>',
		});
		expect(await probe.text()).not.toContain('X:foo');
	});

	it('accepts ]]> inside a quoted attribute value (§2.4 bans it only in content)', async () => {
		const find = await request('/a.txt', {
			method: 'PROPFIND',
			headers: { Depth: '0', 'Content-Type': 'application/xml' },
			body:
				'<D:propfind xmlns:D="DAV:" xmlns:X="urn:x"><D:prop>' +
				'<X:foo a="x]]>y"/></D:prop></D:propfind>',
		});
		expect(find.status).toBe(207);
		expect(validateXml(await find.text())).toBeNull();

		const set = await request('/a.txt', {
			method: 'PROPPATCH',
			headers: { 'Content-Type': 'application/xml' },
			body:
				'<D:propertyupdate xmlns:D="DAV:"><D:set><D:prop>' +
				'<X:attr xmlns:X="urn:x" note="a]]>b">v</X:attr></D:prop></D:set></D:propertyupdate>',
		});
		expect(set.status).toBe(207);
		const res = await request('/a.txt', {
			method: 'PROPFIND',
			headers: { Depth: '0', 'Content-Type': 'application/xml' },
			body: '<D:propfind xmlns:D="DAV:"><D:prop><X:attr xmlns:X="urn:x"/></D:prop></D:propfind>',
		});
		const body = await res.text();
		expect(validateXml(body)).toBeNull();
		expect(body).toContain('a]]>b');
	});
});

describe('parent collections (RFC 4918 creation rules)', () => {
	it('MKCOL with a missing parent is 409', async () => {
		const res = await request('/missing-parent/child', { method: 'MKCOL' });
		expect(res.status).toBe(409);
		expect(tb.find('/missing-parent')).toBeUndefined();
	});

	it('MKCOL under a file parent is 409', async () => {
		const res = await request('/a.txt/child', { method: 'MKCOL' });
		expect(res.status).toBe(409);
	});

	it('COPY into a missing collection is 409', async () => {
		const res = await request('/a.txt', {
			method: 'COPY',
			headers: { Destination: ORIGIN + '/nonesuch/file.txt' },
		});
		expect(res.status).toBe(409);
		expect(tb.find('/a.txt')).toBeDefined();
		expect(tb.find('/nonesuch')).toBeUndefined();
	});

	it('MOVE into a missing collection is 409', async () => {
		const res = await request('/a.txt', {
			method: 'MOVE',
			headers: { Destination: ORIGIN + '/nonesuch/file.txt' },
		});
		expect(res.status).toBe(409);
		expect(tb.find('/a.txt')).toBeDefined();
	});

	it('accepts an absolute-path Destination (no scheme/host)', async () => {
		const res = await request('/a.txt', {
			method: 'COPY',
			headers: { Destination: '/abs-dest.txt' },
		});
		expect(res.status).toBe(201);
		expect(tb.find('/abs-dest.txt')).toBeDefined();
		expect(tb.find('/a.txt')).toBeDefined();
	});
});

describe('COPY Depth: 0', () => {
	it('copies only the collection itself, never its members', async () => {
		await request('/shallow-src', { method: 'MKCOL' });
		await request('/shallow-src/foo.txt', { method: 'PUT', body: 'foo' });
		const res = await request('/shallow-src', {
			method: 'COPY',
			headers: { Destination: ORIGIN + '/shallow-dest', Depth: '0' },
		});
		expect(res.status).toBe(201);
		expect(tb.find('/shallow-dest')?.isdir).toBe(1);
		expect(tb.find('/shallow-dest/foo.txt')).toBeUndefined();
		expect(tb.find('/shallow-src/foo.txt')).toBeDefined();
	});

	it('full-depth COPY still brings the members along', async () => {
		await request('/deep-src', { method: 'MKCOL' });
		await request('/deep-src/foo.txt', { method: 'PUT', body: 'foo' });
		const res = await request('/deep-src', {
			method: 'COPY',
			headers: { Destination: ORIGIN + '/deep-dest' },
		});
		expect(res.status).toBe(201);
		expect(tb.find('/deep-dest/foo.txt')).toBeDefined();
	});
});

describe('dead properties', () => {
	const PROPSET = (inner: string) =>
		`<D:propertyupdate xmlns:D="DAV:"><D:set><D:prop>${inner}</D:prop></D:set></D:propertyupdate>`;
	const PROPGET = (inner: string) =>
		`<D:propfind xmlns:D="DAV:"><D:prop>${inner}</D:prop></D:propfind>`;

	it('stores a set property and serves it from PROPFIND', async () => {
		const set = await request('/a.txt', {
			method: 'PROPPATCH',
			headers: { 'Content-Type': 'application/xml' },
			body: PROPSET('<X:tag xmlns:X="urn:x-example">v1</X:tag>'),
		});
		expect(set.status).toBe(207);
		const res = await request('/a.txt', {
			method: 'PROPFIND',
			headers: { Depth: '0', 'Content-Type': 'application/xml' },
			body: PROPGET('<X:tag xmlns:X="urn:x-example"/>'),
		});
		const body = await res.text();
		expect(body).toContain('<D:status>HTTP/1.1 200 OK</D:status>');
		expect(body).toContain('>v1<');
	});

	it('distinguishes namespaces for the same local name', async () => {
		await request('/a.txt', {
			method: 'PROPPATCH',
			headers: { 'Content-Type': 'application/xml' },
			body: PROPSET('<X:s xmlns:X="urn:one">1</X:s><Y:s xmlns:Y="urn:two">2</Y:s>'),
		});
		const res = await request('/a.txt', {
			method: 'PROPFIND',
			headers: { Depth: '0', 'Content-Type': 'application/xml' },
			body: PROPGET('<X:s xmlns:X="urn:one"/><Y:s xmlns:Y="urn:two"/><Z:s xmlns:Z="urn:three"/>'),
		});
		const body = await res.text();
		expect(body).toContain('>1<');
		expect(body).toContain('>2<');
		// The unknown namespace falls into the 404 propstat.
		expect(body).toContain('<Z:s xmlns:Z="urn:three"/>');
	});

	it('a removed property answers 404 again', async () => {
		await request('/a.txt', {
			method: 'PROPPATCH',
			headers: { 'Content-Type': 'application/xml' },
			body: PROPSET('<X:tag xmlns:X="urn:x-example">v1</X:tag>'),
		});
		const remove = await request('/a.txt', {
			method: 'PROPPATCH',
			headers: { 'Content-Type': 'application/xml' },
			body:
				'<D:propertyupdate xmlns:D="DAV:"><D:remove><D:prop>' +
				'<X:tag xmlns:X="urn:x-example"/></D:prop></D:remove></D:propertyupdate>',
		});
		expect(remove.status).toBe(207);
		const res = await request('/a.txt', {
			method: 'PROPFIND',
			headers: { Depth: '0', 'Content-Type': 'application/xml' },
			body: PROPGET('<X:tag xmlns:X="urn:x-example"/>'),
		});
		expect(await res.text()).toContain('HTTP/1.1 404 Not Found');
	});

	it('refuses to patch DAV live props (403 propstat)', async () => {
		const res = await request('/a.txt', {
			method: 'PROPPATCH',
			headers: { 'Content-Type': 'application/xml' },
			body: PROPSET('<D:displayname xmlns:D="DAV:">nope</D:displayname>'),
		});
		expect(res.status).toBe(207);
		const body = await res.text();
		expect(body).toContain('HTTP/1.1 403 Forbidden');
		// The live value is unchanged.
		const propfind = await request('/a.txt', {
			method: 'PROPFIND',
			headers: { Depth: '0', 'Content-Type': 'application/xml' },
			body: PROPGET('<D:displayname xmlns:D="DAV:"/>'),
		});
		expect(await propfind.text()).toContain('<D:displayname>a.txt</D:displayname>');
	});

	it('stores a dead property whose local name is `set` intact', async () => {
		// The operation scanner must bind each <set>/<remove> to its OWN
		// closing prefix: an <X:set>…</X:set> sitting inside <D:prop> is a
		// property, not a second operation. Matching any prefix cut the block
		// at the property's close tag, which then reported the <D:prop>
		// wrapper itself as a forbidden live prop and stored a half element.
		const set = await request('/a.txt', {
			method: 'PROPPATCH',
			headers: { 'Content-Type': 'application/xml' },
			body: PROPSET('<X:set xmlns:X="urn:x-example">value</X:set>'),
		});
		expect(set.status).toBe(207);
		const setBody = await set.text();
		expect(setBody).toContain('HTTP/1.1 200 OK');
		expect(setBody).not.toContain('403 Forbidden');

		const res = await request('/a.txt', {
			method: 'PROPFIND',
			headers: { Depth: '0', 'Content-Type': 'application/xml' },
			body: PROPGET('<X:set xmlns:X="urn:x-example"/>'),
		});
		const found = await res.text();
		expect(found).toContain('HTTP/1.1 200 OK');
		expect(found).toContain('>value</X:set>');
	});

	it('stores a dead property whose local name is `prop` intact', async () => {
		// Same prefix-binding rule as `set`/`remove`: the <D:prop> container
		// closes on ITS prefix, not on the first `</…prop>` in the document.
		const set = await request('/a.txt', {
			method: 'PROPPATCH',
			headers: { 'Content-Type': 'application/xml' },
			body: PROPSET('<X:prop xmlns:X="urn:x-example">vv</X:prop>'),
		});
		expect(set.status).toBe(207);
		const res = await request('/a.txt', {
			method: 'PROPFIND',
			headers: { Depth: '0', 'Content-Type': 'application/xml' },
			body: PROPGET('<X:prop xmlns:X="urn:x-example"/>'),
		});
		const found = await res.text();
		expect(found).toContain('HTTP/1.1 200 OK');
		expect(found).toContain('>vv</X:prop>');
	});

	it('escapes a namespace URI taken from a single-quoted declaration', async () => {
		// The client's own declaration is legal XML; re-emitting the URI raw
		// into a double-quoted attribute breaks the quote pairing — and the
		// malformed markup would be STORED on the PROPPATCH path.
		const res = await request('/a.txt', {
			method: 'PROPFIND',
			headers: { Depth: '0', 'Content-Type': 'application/xml' },
			body: `<D:propfind xmlns:D="DAV:" xmlns:Q='urn:a"b"'><D:prop><Q:missing/></D:prop></D:propfind>`,
		});
		const body = await res.text();
		expect(res.status).toBe(207);
		expect(body).not.toContain('urn:a"b"');
		expect(body).toContain('urn:a&quot;b&quot;');
		// Well-formed: no dangling quote pair inside an attribute value.
		expect(body).toContain('xmlns:Q="urn:a&quot;b&quot;"');
	});

	it('migrates dead properties with the resource on MOVE', async () => {
		await request('/a.txt', {
			method: 'PROPPATCH',
			headers: { 'Content-Type': 'application/xml' },
			body: PROPSET('<X:tag xmlns:X="urn:x-example">keep</X:tag>'),
		});
		const move = await request('/a.txt', {
			method: 'MOVE',
			headers: { Destination: ORIGIN + '/prop-moved.txt' },
		});
		expect(move.status).toBe(201);
		const res = await request('/prop-moved.txt', {
			method: 'PROPFIND',
			headers: { Depth: '0', 'Content-Type': 'application/xml' },
			body: PROPGET('<X:tag xmlns:X="urn:x-example"/>'),
		});
		expect(await res.text()).toContain('>keep<');
	});

	it('copies dead properties on COPY', async () => {
		await request('/a.txt', {
			method: 'PROPPATCH',
			headers: { 'Content-Type': 'application/xml' },
			body: PROPSET('<X:tag xmlns:X="urn:x-example">duplicated</X:tag>'),
		});
		const copy = await request('/a.txt', {
			method: 'COPY',
			headers: { Destination: ORIGIN + '/prop-copy.txt' },
		});
		expect(copy.status).toBe(201);
		const res = await request('/prop-copy.txt', {
			method: 'PROPFIND',
			headers: { Depth: '0', 'Content-Type': 'application/xml' },
			body: PROPGET('<X:tag xmlns:X="urn:x-example"/>'),
		});
		expect(await res.text()).toContain('>duplicated<');
	});

	it('clears dead properties on DELETE (no stale values on reuse)', async () => {
		await request('/a.txt', {
			method: 'PROPPATCH',
			headers: { 'Content-Type': 'application/xml' },
			body: PROPSET('<X:tag xmlns:X="urn:x-example">gone</X:tag>'),
		});
		expect((await request('/a.txt', { method: 'DELETE' })).status).toBe(204);
		await request('/a.txt', { method: 'PUT', body: 'recreated' });
		const res = await request('/a.txt', {
			method: 'PROPFIND',
			headers: { Depth: '0', 'Content-Type': 'application/xml' },
			body: PROPGET('<X:tag xmlns:X="urn:x-example"/>'),
		});
		expect(await res.text()).toContain('HTTP/1.1 404 Not Found');
	});

	it('includes dead properties in allprop and propname', async () => {
		await request('/a.txt', {
			method: 'PROPPATCH',
			headers: { 'Content-Type': 'application/xml' },
			body: PROPSET('<X:tag xmlns:X="urn:x-example">listed</X:tag>'),
		});
		const all = await request('/a.txt', { method: 'PROPFIND', headers: { Depth: '0' } });
		expect(await all.text()).toContain('>listed<');
		const names = await request('/a.txt', {
			method: 'PROPFIND',
			headers: { Depth: '0' },
			body: '<D:propfind xmlns:D="DAV:"><D:propname/></D:propfind>',
		});
		expect(await names.text()).toContain('<X:tag xmlns:X="urn:x-example"/>');
	});

	it('stores a container whose text spells its own close tag', async () => {
		// Legal XML: close markup inside a comment or CDATA section is text.
		// A close-search blind to that truncates the container — the response
		// then carries an unclosed comment (unparseable 207 forever) — and the
		// inner element gets promoted to a property of its own.
		const inner =
			'<X:g xmlns:X="urn:x"><!-- </X:g> --><X:h xmlns:X="urn:x">h</X:h></X:g>' +
			'<X:c xmlns:X="urn:x"><![CDATA[</X:c>]]></X:c>';
		const set = await request('/a.txt', {
			method: 'PROPPATCH',
			headers: { 'Content-Type': 'application/xml' },
			body: PROPSET(inner),
		});
		expect(set.status).toBe(207);
		expect(validateXml(await set.text())).toBeNull();

		const res = await request('/a.txt', {
			method: 'PROPFIND',
			headers: { Depth: '0', 'Content-Type': 'application/xml' },
			body: PROPGET('<X:g xmlns:X="urn:x"/><X:c xmlns:X="urn:x"/>'),
		});
		const body = await res.text();
		expect(validateXml(body)).toBeNull();
		expect(body).toContain('h</X:h></X:g>');
		expect(body).toContain(']]></X:c>');
		// The nested element never became a property of its own.
		const probe = await request('/a.txt', {
			method: 'PROPFIND',
			headers: { Depth: '0', 'Content-Type': 'application/xml' },
			body: PROPGET('<X:h xmlns:X="urn:x"/>'),
		});
		expect(await probe.text()).toContain('HTTP/1.1 404 Not Found');
	});

	it('binds a dotted-qname close tag to its own element', async () => {
		// The close regex interpolates the qname: an unescaped `.` matches any
		// character, so `</pQq:g>` would terminate a `<p.q:g>` container early.
		const inner = '<p.q:g xmlns:p.q="urn:one" xmlns:pQq="urn:two">v<pQq:g>in</pQq:g></p.q:g>';
		const set = await request('/a.txt', {
			method: 'PROPPATCH',
			headers: { 'Content-Type': 'application/xml' },
			body: PROPSET(inner),
		});
		expect(set.status).toBe(207);
		const res = await request('/a.txt', {
			method: 'PROPFIND',
			headers: { Depth: '0', 'Content-Type': 'application/xml' },
			body: PROPGET('<p.q:g xmlns:p.q="urn:one"/>'),
		});
		const body = await res.text();
		expect(validateXml(body)).toBeNull();
		expect(body).toContain('in</pQq:g></p.q:g>');
	});
});

describe('lock enforcement', () => {
	const LOCK_BODY =
		'<D:lockinfo xmlns:D="DAV:"><D:lockscope><D:exclusive/></D:lockscope>' +
		'<D:locktype><D:write/></D:locktype><D:owner><D:href>tester</D:href></D:owner></D:lockinfo>';
	const SHARED_BODY = LOCK_BODY.replace('<D:exclusive/>', '<D:shared/>');

	const lock = async (path: string, body: string = LOCK_BODY): Promise<string> => {
		const res = await request(path, {
			method: 'LOCK',
			headers: { 'Content-Type': 'application/xml' },
			body,
		});
		expect(res.status).toBe(200);
		return res.headers.get('Lock-Token')!;
	};

	it('rejects every un-tokened write with 423', async () => {
		const token = await lock('/a.txt');
		for (const [method, init] of [
			['PUT', { body: 'nope' }],
			['DELETE', {}],
			['PROPPATCH', { headers: { 'Content-Type': 'application/xml' }, body: '<D:propertyupdate xmlns:D="DAV:"><D:set><D:prop><X:a xmlns:X="urn:x">1</X:a></D:prop></D:set></D:propertyupdate>' }],
			['MOVE', { headers: { Destination: ORIGIN + '/elsewhere.txt' } }],
		] as const) {
			const res = await request('/a.txt', { method, ...init });
			expect(res.status, `${method} on a locked resource`).toBe(423);
		}
		// COPY *onto* the locked resource is refused as well.
		const copy = await request('/dest.txt', {
			method: 'COPY',
			headers: { Destination: ORIGIN + '/a.txt' },
		});
		expect(copy.status).toBe(423);
		// And nothing was modified.
		expect(new TextDecoder().decode(tb.find('/a.txt')!.content)).toBe('the quick brown fox\n');
		expect(tb.find('/elsewhere.txt')).toBeUndefined();
		// The owner can still write, presenting the token via If.
		const owned = await request('/a.txt', {
			method: 'PUT',
			headers: { If: `(${token})` },
			body: 'owner wrote this',
		});
		expect(owned.status).toBe(204);
	});

	it('copying a locked resource without its token succeeds and carries no lock', async () => {
		await lock('/a.txt');
		const copy = await request('/a.txt', {
			method: 'COPY',
			headers: { Destination: ORIGIN + '/lock-copy.txt' },
		});
		expect(copy.status).toBe(201);
		const discover = await request('/lock-copy.txt', {
			method: 'PROPFIND',
			headers: { Depth: '0', 'Content-Type': 'application/xml' },
			body: '<D:propfind xmlns:D="DAV:"><D:prop><D:lockdiscovery/></D:prop></D:propfind>',
		});
		expect(await discover.text()).toContain('<D:lockdiscovery/>');
	});

	it('LOCK on an already-locked resource is 423', async () => {
		await lock('/a.txt');
		const again = await request('/a.txt', {
			method: 'LOCK',
			headers: { 'Content-Type': 'application/xml' },
			body: LOCK_BODY,
		});
		expect(again.status).toBe(423);
	});

	it('lockdiscovery reports the active lock with token and owner', async () => {
		const token = await lock('/a.txt');
		const res = await request('/a.txt', {
			method: 'PROPFIND',
			headers: { Depth: '0', 'Content-Type': 'application/xml' },
			body: '<D:propfind xmlns:D="DAV:"><D:prop><D:lockdiscovery/></D:prop></D:propfind>',
		});
		const body = await res.text();
		expect(body).toContain('<D:activelock>');
		expect(body).toContain('<D:owner xmlns:D="DAV:"><D:href xmlns:D="DAV:">tester</D:href></D:owner>');
		// Tokens are URI-safe (uuid + expiry); the href carries no brackets.
		expect(body).toContain(token.slice(1, -1));
	});

	it('a second shared lock stacks and each token unlocks its own', async () => {
		const first = await lock('/a.txt', SHARED_BODY);
		const second = await lock('/a.txt', SHARED_BODY);
		expect(second).not.toBe(first);
		// A shared lock still blocks non-owners.
		const del = await request('/a.txt', { method: 'DELETE' });
		expect(del.status).toBe(423);
		expect((await request('/a.txt', { method: 'UNLOCK', headers: { 'Lock-Token': first } })).status).toBe(204);
		// Still locked by the second token.
		expect((await request('/a.txt', { method: 'DELETE' })).status).toBe(423);
		expect((await request('/a.txt', { method: 'UNLOCK', headers: { 'Lock-Token': second } })).status).toBe(204);
		expect((await request('/a.txt', { method: 'DELETE' })).status).toBe(204);
	});

	it('an exclusive lock does not stack on a shared lock', async () => {
		await lock('/a.txt', SHARED_BODY);
		const exclusive = await request('/a.txt', {
			method: 'LOCK',
			headers: { 'Content-Type': 'application/xml' },
			body: LOCK_BODY,
		});
		expect(exclusive.status).toBe(423);
	});

	it('If-evaluation: DAV:no-lock is a failed condition (412), corrupt real token is 423', async () => {
		// Unlocked resource: <DAV:no-lock> identifies no lock → 412.
		const unlocked = await request('/a.txt', {
			method: 'PUT',
			headers: { If: '(<DAV:no-lock>)' },
			body: 'x',
		});
		expect(unlocked.status).toBe(412);
		const token = await lock('/a.txt');
		// Locked resource, pseudo-token: still a plain failed condition → 412.
		const locked = await request('/a.txt', {
			method: 'PUT',
			headers: { If: '(<DAV:no-lock>)' },
			body: 'x',
		});
		expect(locked.status).toBe(412);
		const inner = token.slice(1, -1);
		// A corrupt real-token-shaped value is a lock problem → 423.
		const corrupt = await request('/a.txt', {
			method: 'PUT',
			headers: { If: `(<${inner}x>)` },
			body: 'x',
		});
		expect(corrupt.status).toBe(423);
		// An expired foreign token in our format is lock-shaped too → 423.
		const foreign = await request('/a.txt', {
			method: 'PUT',
			headers: { If: '(<opaquelocktoken:00000000-0000-0000-0000-000000000000:123>)' },
			body: 'x',
		});
		expect(foreign.status).toBe(423);
		// A valid token passes.
		const valid = await request('/a.txt', { method: 'PUT', headers: { If: `(${token})` }, body: 'y' });
		expect(valid.status).toBe(204);
	});

	it('UNLOCK with our own token after state loss succeeds gracefully', async () => {
		const token = await lock('/a.txt');
		resetDavVolatileState();
		const res = await request('/a.txt', { method: 'UNLOCK', headers: { 'Lock-Token': token } });
		expect(res.status).toBe(204);
	});

	it('If-evaluation: a stale etag fails with 412 even for the lock owner', async () => {
		const token = await lock('/a.txt');
		const res = await request('/a.txt', {
			method: 'PUT',
			headers: { If: `(${token} ["stale-etag"])` },
			body: 'x',
		});
		expect(res.status).toBe(412);
	});

	it('honours a still-valid self-issued token after advisory state is lost', async () => {
		// Simulates isolate rotation: the record is gone, but the token the
		// client holds embeds its expiry and must keep working.
		const token = await lock('/a.txt');
		resetDavVolatileState();
		const res = await request('/a.txt', {
			method: 'PUT',
			headers: { If: `(${token})` },
			body: 'still writable',
		});
		expect(res.status).toBe(204);
		// Without the token, the fresh (empty) store no longer blocks either.
		expect((await request('/a.txt', { method: 'DELETE' })).status).toBe(204);
	});

	it('an Infinity lock on a collection guards its descendants', async () => {
		await request('/lockcoll', { method: 'MKCOL' });
		const token = await lock('/lockcoll');
		await request('/lockcoll/file.txt', { method: 'PUT', headers: { If: `(${token})` }, body: 'in' });
		// Un-tokened writes to a child are refused.
		expect((await request('/lockcoll/file.txt', { method: 'PUT', body: 'no' })).status).toBe(423);
		expect((await request('/lockcoll/child', { method: 'MKCOL' })).status).toBe(423);
		// Refresh through the child (token targets the collection).
		const refresh = await request('/lockcoll/file.txt', {
			method: 'LOCK',
			headers: { 'Content-Type': 'application/xml', If: `(${token})` },
			body: LOCK_BODY,
		});
		expect(refresh.status).toBe(200);
		// Unlock the collection; the child is free again.
		expect((await request('/lockcoll', { method: 'UNLOCK', headers: { 'Lock-Token': token } })).status).toBe(204);
		expect((await request('/lockcoll/file.txt', { method: 'PUT', body: 'free' })).status).toBe(204);
	});

	it('UNLOCK through a child releases the ancestor Infinity lock (§9.11)', async () => {
		// The collection's lock covers the child, so unlocking with that token
		// at the child MUST remove the lock — not answer 204 and leave the
		// 423 in force until the timeout expires.
		await request('/lockcol2', { method: 'MKCOL' });
		const token = await lock('/lockcol2');
		expect((await request('/lockcol2/file.txt', { method: 'PUT', body: 'guarded' })).status).toBe(423);

		const unlock = await request('/lockcol2/file.txt', {
			method: 'UNLOCK',
			headers: { 'Lock-Token': token },
		});
		expect(unlock.status).toBe(204);
		expect((await request('/lockcol2/file.txt', { method: 'PUT', body: 'free' })).status).toBe(201);
		// …and the collection itself is free too.
		expect((await request('/lockcol2', { method: 'DELETE' })).status).toBe(204);
	});

	it('UNLOCK with a token belonging to an unrelated lock is 409', async () => {
		const token = await lock('/a.txt');
		const res = await request('/dest.txt', { method: 'UNLOCK', headers: { 'Lock-Token': token } });
		expect(res.status).toBe(409);
		// The real lock is untouched.
		expect((await request('/a.txt', { method: 'PUT', body: 'no' })).status).toBe(423);
	});

	it('LOCK with an If token that does not cover the URI is 412 (§9.10.6)', async () => {
		const token = await lock('/a.txt');
		const res = await request('/dest.txt', {
			method: 'LOCK',
			headers: { 'Content-Type': 'application/xml', If: `(${token})` },
			body: LOCK_BODY,
		});
		expect(res.status).toBe(412);
		// No second lock may be minted REUSING the presented token: that would
		// make one token satisfy conditions on two unrelated resources.
		expect((await request('/dest.txt', { method: 'PUT', body: 'free' })).status).toBe(204);
		expect(
			(await request('/dest.txt', { method: 'UNLOCK', headers: { 'Lock-Token': token } })).status,
		).toBe(409);
		// The original lock still owns its token.
		expect((await request('/a.txt', { method: 'PUT', body: 'no' })).status).toBe(423);
	});

	it('does not invent properties from comments or CDATA', async () => {
		// A flat tag scan over the fragment would answer for a prop that only
		// appears inside a comment — and on the PROPPATCH path a comment
		// inside <D:prop> would silently CREATE dead state. The `>` before the
		// inner tag matters: it is what defeats a scan that merely skips to
		// the first `>` of the comment/CDATA construct.
		const find = await request('/a.txt', {
			method: 'PROPFIND',
			headers: { Depth: '0', 'Content-Type': 'application/xml' },
			body:
				'<D:propfind xmlns:D="DAV:" xmlns:X="urn:x"><D:prop><!-- n > 1 <D:displayname/> --> ' +
				'<![CDATA[ a > b <D:getcontentlength/> ]]> <X:real/></D:prop></D:propfind>',
		});
		expect(find.status).toBe(207);
		const findBody = await find.text();
		expect(findBody).not.toContain('<D:displayname>');
		expect(findBody).not.toContain('<D:getcontentlength>');

		const patch = await request('/a.txt', {
			method: 'PROPPATCH',
			headers: { 'Content-Type': 'application/xml' },
			body:
				'<D:propertyupdate xmlns:D="DAV:"><D:set><D:prop>' +
				'<!-- x > y <X:ghost xmlns:X="urn:x"/> --></D:prop></D:set></D:propertyupdate>',
		});
		expect(patch.status).toBe(207);
		const probe = await request('/a.txt', {
			method: 'PROPFIND',
			headers: { Depth: '0', 'Content-Type': 'application/xml' },
			body:
				'<D:propfind xmlns:D="DAV:"><D:prop>' +
				'<X:ghost xmlns:X="urn:x"/></D:prop></D:propfind>',
		});
		// 404 = never created. A 200 here means a comment mutated our state.
		expect(await probe.text()).toContain('HTTP/1.1 404 Not Found');
	});

	it('honours a shared scope declared with a hyphenated prefix', async () => {
		// XML NameChar allows '-' and '.' in a prefix; the old `[A-Za-z0-9_]*`
		// sniffing missed them and granted the request as EXCLUSIVE, which
		// would wedge every other client's shared lock.
		const body =
			'<D:lockinfo xmlns:D="DAV:" xmlns:my-ns="urn:mine">' +
			'<D:lockscope><my-ns:shared/></D:lockscope>' +
			'<D:locktype><D:write/></D:locktype><D:owner>t</D:owner></D:lockinfo>';
		const first = await request('/a.txt', {
			method: 'LOCK',
			headers: { 'Content-Type': 'application/xml' },
			body,
		});
		expect(first.status).toBe(200);
		expect(await first.text()).toContain('<D:shared/>');

		// Shared locks stack: a second shared request must be granted.
		const second = await request('/a.txt', {
			method: 'LOCK',
			headers: { 'Content-Type': 'application/xml' },
			body: SHARED_BODY,
		});
		expect(second.status).toBe(200);
	});

	it('LOCK without a lockinfo body or an If token is 400 (§9.10.1)', async () => {
		const res = await request('/dest.txt', { method: 'LOCK' });
		expect(res.status).toBe(400);
		expect((await request('/dest.txt', { method: 'PUT', body: 'no lock was taken' })).status).toBe(204);
	});

	it('renders activelock in RFC 4918 §14.12 order with lockroot and lowercase depth', async () => {
		const res = await request('/a.txt', {
			method: 'LOCK',
			headers: { 'Content-Type': 'application/xml' },
			body: LOCK_BODY,
		});
		expect(res.status).toBe(200);
		const xml = await res.text();
		const scope = xml.indexOf('<D:lockscope>');
		const type = xml.indexOf('<D:locktype>');
		const root = xml.indexOf('<D:lockroot>');
		expect(scope).toBeGreaterThan(-1);
		expect(type).toBeGreaterThan(scope); // DTD order: lockscope before locktype
		expect(root).toBeGreaterThan(type); // lockroot last, as §14.1 requires
		expect(xml).toContain('<D:depth>infinity</D:depth>'); // §14.4: lowercase
		expect(xml).toContain('<D:lockroot><D:href>/a.txt</D:href></D:lockroot>');
		await request('/a.txt', { method: 'UNLOCK', headers: { 'Lock-Token': res.headers.get('Lock-Token')! } });
	});

	it('keeps lockroot on the collection when refreshed through a descendant', async () => {
		// §14.12 lockroot is the href of the resource that is LOCKED. Answering
		// an indirect refresh through a child with the child's own href
		// advertises the wrong root for the rest of the lock's life.
		await request('/col2', { method: 'MKCOL' });
		await request('/col2/file.txt', { method: 'PUT', body: 'in' });
		const token = await lock('/col2');
		const refresh = await request('/col2/file.txt', {
			method: 'LOCK',
			headers: { 'Content-Type': 'application/xml', If: `(${token})` },
			body: LOCK_BODY,
		});
		expect(refresh.status).toBe(200);
		expect(await refresh.text()).toContain('<D:lockroot><D:href>/col2/</D:href></D:lockroot>');

		// …and a lockdiscovery PROPFIND on the child reports the same root.
		const probe = await request('/col2/file.txt', {
			method: 'PROPFIND',
			headers: { Depth: '0', 'Content-Type': 'application/xml' },
			body:
				'<D:propfind xmlns:D="DAV:"><D:prop><D:lockdiscovery/></D:prop></D:propfind>',
		});
		const body = await probe.text();
		expect(body).toContain('<D:lockroot><D:href>/col2/</D:href></D:lockroot>');
		expect(body).not.toContain('/col2/file.txt</D:href></D:lockroot>');

		await request('/col2', { method: 'UNLOCK', headers: { 'Lock-Token': token } });
		await request('/col2/file.txt', { method: 'DELETE' });
		await request('/col2', { method: 'DELETE' });
	});

	it('a resource-tag If does not substitute for a lockinfo body', async () => {
		// `(<http://host/a.txt>)` is a resource-tag condition (§10.4.1), not a
		// lock token: it must not satisfy the body-less-refresh gate and mint
		// a whole new lock (§9.10.1 defines body-less LOCK as refresh). The
		// header is present and yields no usable refresh credential → §9.10.6
		// 412 (round 11: was 400, which called a well-formed header malformed;
		// PUT answers 412 for the same shape).
		const res = await request('/dest.txt', {
			method: 'LOCK',
			headers: { If: `(<${ORIGIN}/a.txt>)` },
		});
		expect(res.status).toBe(412);
		expect((await request('/dest.txt', { method: 'PUT', body: 'no lock taken' })).status).toBe(204);
	});

	it('a refresh carrying an unrelated live token is 412 (§9.10.6)', async () => {
		const own = await lock('/a.txt');
		const other = await lock('/dest.txt');
		const res = await request('/a.txt', {
			method: 'LOCK',
			headers: { 'Content-Type': 'application/xml', If: `(${own})(${other})` },
			body: LOCK_BODY,
		});
		expect(res.status).toBe(412);
		// Neither lock was disturbed.
		expect((await request('/a.txt', { method: 'PUT', body: 'no' })).status).toBe(423);
		expect((await request('/dest.txt', { method: 'PUT', body: 'no' })).status).toBe(423);
	});
});

describe('audit hardening (Phase 2 regressions)', () => {
	it('retries a failed relocate instead of stranding lock state', async () => {
		// A single dropped relocate (DELETE/MOVE/COPY) would leave locks at
		// the old path — stale 423s for whatever lands there next — or a lock
		// that never followed a rename. safeRelocate must retry, not swallow.
		let attempts = 0;
		const store = new Proxy({} as DavStore, {
			get: (_target, prop) =>
				prop === 'relocate'
					? async () => {
							attempts += 1;
							if (attempts < 3) throw new Error('transient DO blip');
						}
					: async () => {
							throw new Error(`unexpected store call: ${String(prop)}`);
						},
		});
		await safeRelocate(store, [{ src: '/x.txt', mode: 'forget', recursive: false }]);
		expect(attempts).toBe(3);
	}, 15000);

	it('gives up after three relocate attempts without throwing', async () => {
		let attempts = 0;
		const store = new Proxy({} as DavStore, {
			get: (_target, prop) =>
				prop === 'relocate'
					? async () => {
							attempts += 1;
							throw new Error('down');
						}
					: async () => {
							throw new Error(`unexpected store call: ${String(prop)}`);
						},
		});
		// Advisory state must never fail the HTTP response it trails.
		await expect(safeRelocate(store, [{ src: '/x.txt', mode: 'forget', recursive: false }])).resolves.toBeUndefined();
		expect(attempts).toBe(3);
	}, 15000);


	describe('path traversal containment', () => {
		it('normalizes a percent-encoded ".." segment inside the path', async () => {
			// %2e%2e decodes to the literal ".." and must get the identical
			// cleanup as a raw dot-dot — never survive into the Terabox path.
			const res = await request('/docs/%2e%2e/a.txt');
			expect(res.status).toBe(200);
			expect(await res.text()).toBe('the quick brown fox\n');
		});

		it('cannot climb above the root even with repeated %2e%2e', async () => {
			const res = await request('/%2e%2e/%2e%2e/etc/passwd');
			expect(res.status).toBe(404);
			// The path normalized to /etc/passwd, it did NOT escape to a
			// raw ".." path the upstream could walk with.
			expect(tb.nodes.has('/etc/passwd')).toBe(false);
		});

		it('rejects a percent-encoded separator inside a segment (400)', async () => {
			// %2F decodes to "/" — fabricating path structure the client
			// never had a separator for. Must be refused, not guessed at.
			const res = await request('/docs%2F..%2Fa.txt');
			expect(res.status).toBe(400);
		});

		it('MOVE Destination with %2e%2e cannot escape either', async () => {
			const res = await request('/a.txt', {
				method: 'MOVE',
				headers: { Destination: ORIGIN + '/docs/%2e%2e/escaped.txt' },
			});
			// Normalizes to /escaped.txt — a sibling, not an upstream walk.
			expect(res.status).toBe(201);
			expect(tb.find('/escaped.txt')).toBeDefined();
			expect(tb.find('/docs/escaped.txt')).toBeUndefined();
		});
	});

	describe('metadata cache cap', () => {
		it('evicts the oldest entries once META_MAX_ENTRIES is exceeded', async () => {
			// Seed 2005 entries through the same write path the live stat
			// handler uses (cacheWrite: expiry sweep + FIFO cap). A per-entry
			// HTTP round-trip would take ~90s; the one real HEAD below proves
			// the live miss path lands in that same write.
			const N = 2005;
			const filler = { isdir: 0, size: 1, server_filename: 'x.txt' };
			for (let i = 0; i < N; i += 1) {
				metaCacheSeedForTest(`/cap-${i}.txt`, { ...filler, path: `/cap-${i}.txt` });
			}
			expect(metaCacheSize()).toBeLessThanOrEqual(2000);
			// 2005 inserts, cap 2000: the first five (cap-0..cap-4) were
			// FIFO-evicted during seeding; the oldest survivor is cap-5.
			expect(metaCacheHasForTest('/cap-0.txt')).toBe(false);
			expect(metaCacheHasForTest('/cap-4.txt')).toBe(false);
			expect(metaCacheHasForTest('/cap-5.txt')).toBe(true);
			// …while the newest entry survived.
			expect(metaCacheHasForTest(`/cap-${N - 1}.txt`)).toBe(true);

			// A real cache-miss HEAD re-fetches (filemetas) and writes through
			// cacheWrite — evicting the next-oldest survivor, cap-5.
			tb.seed('/live.txt', { content: 'x' });
			expect((await request('/live.txt', { method: 'HEAD' })).status).toBe(200);
			expect(metaCacheHasForTest('/live.txt')).toBe(true);
			expect(metaCacheHasForTest('/cap-5.txt')).toBe(false);
			// A second HEAD of the same path is a cache hit: no extra fetch.
			const callsBefore = tb.filemetasCalls;
			expect((await request('/live.txt', { method: 'HEAD' })).status).toBe(200);
			expect(tb.filemetasCalls).toBe(callsBefore);
		});
	});

	describe('If header bare forms (RFC 4918 §10.2.1)', () => {
		const LOCK_BODY =
			'<D:lockinfo xmlns:D="DAV:"><D:lockscope><D:exclusive/></D:lockscope>' +
			'<D:locktype><D:write/></D:locktype><D:owner><D:href>bare</D:href></D:owner></D:lockinfo>';

		const lock = async (path: string): Promise<string> => {
			const res = await request(path, {
				method: 'LOCK',
				headers: { 'Content-Type': 'application/xml' },
				body: LOCK_BODY,
			});
			expect(res.status).toBe(200);
			return res.headers.get('Lock-Token')!;
		};

		const bareToken = async (header: string): Promise<number> => {
			const token = await lock('/a.txt');
			const res = await request('/a.txt', {
				method: 'PUT',
				headers: { If: header.replace('%', token.slice(1, -1)) },
				body: 'x',
			});
			await request('/a.txt', { method: 'UNLOCK', headers: { 'Lock-Token': token } });
			return res.status;
		};

		it('accepts a bare paren-free lock token tag (Tag-list)', async () => {
			// If: <opaquelocktoken:…> with no wrapping parens — previously 400.
			expect(await bareToken('<%>')).toBe(204);
		});

		it('bare foreign lock token on a locked resource is 423, not 400', async () => {
			const token = await lock('/a.txt');
			const res = await request('/a.txt', {
				method: 'PUT',
				headers: { If: '<opaquelocktoken:00000000-0000-4000-8000-000000000000:1>' },
				body: 'forged',
			});
			expect(res.status).toBe(423);
			await request('/a.txt', { method: 'UNLOCK', headers: { 'Lock-Token': token } });
		});

		it('accepts a bare bracketed etag (No-tag-list)', async () => {
			const md5 = tb.find('/a.txt')!.md5;
			const ok = await request('/a.txt', {
				method: 'PUT',
				headers: { If: `["${md5}"]` },
				body: 'etag-gated write',
			});
			expect(ok.status).toBe(204);
			const stale = await request('/a.txt', {
				method: 'PUT',
				headers: { If: '["deadbeefdeadbeefdeadbeefdeadbeef"]' },
				body: 'nope',
			});
			expect(stale.status).toBe(412);
		});
	});

	describe('Terabox errno → HTTP status mapping', () => {
		it('maps storage-capacity refusals (-10) to 507 Insufficient Storage', async () => {
			tb.precreateErrno = -10;
			const res = await request('/full.txt', { method: 'PUT', body: 'x' });
			expect(res.status).toBe(507);
		});

		it('maps -32 and 58 (plan limits) to 507 as well', async () => {
			tb.precreateErrno = -32;
			expect((await request('/full2.txt', { method: 'PUT', body: 'x' })).status).toBe(507);
			tb.precreateErrno = 58;
			expect((await request('/full3.txt', { method: 'PUT', body: 'x' })).status).toBe(507);
		});

		it('maps a rejected file name (-7) to 403', async () => {
			tb.precreateErrno = -7;
			const res = await request('/badname.txt', { method: 'PUT', body: 'x' });
			expect(res.status).toBe(403);
		});

		it('maps an upstream HTTP failure (-5) to 502', async () => {
			// Every candidate upload host rejects → the failover exhausts and
			// the TeraboxError surfaces as a gateway problem.
			tb.locateServers = ['only-bad.example'];
			tb.rejectHosts.add('only-bad.example');
			const res = await request('/nowhere.txt', { method: 'PUT', body: 'x' });
			expect(res.status).toBe(502);
		});

		it('maps a missing parent (-11) and partial conflict (12) to 409', async () => {
			// Both are namespace conflicts the client resolves by re-reading
			// the tree (RFC 4918 §9.7.1/§9.9.3) — never a bare 500.
			tb.precreateErrno = -11;
			expect((await request('/n11.txt', { method: 'PUT', body: 'x' })).status).toBe(409);
			tb.precreateErrno = 12;
			expect((await request('/n12.txt', { method: 'PUT', body: 'x' })).status).toBe(409);
		});

		it('maps a shared-folder refusal (-22) to 403', async () => {
			tb.precreateErrno = -22;
			expect((await request('/shared.txt', { method: 'PUT', body: 'x' })).status).toBe(403);
		});

		it.each([-1, 6, -19])(
			'maps auth errno %s to 401 carrying the Basic challenge',
			async (errno) => {
				// Auth-class errnos must re-authenticate like -6/400141: a 401
				// without WWW-Authenticate makes davfs/rclone retry forever.
				tb.precreateErrno = errno;
				const res = await request('/auth-errno.txt', { method: 'PUT', body: 'x' });
				expect(res.status).toBe(401);
				expect(res.headers.get('WWW-Authenticate')).toBe(
					'Basic realm="terabox WebDAV", charset="UTF-8"',
				);
			},
		);

		it.each([
			[4, 400],
			[2, 400],
			[5, 409],
			[7, 403],
			[11, 403],
			[15, 502],
		])('maps non-auth upstream errno %s to %s, never a bare 500', async (errno, want) => {
			tb.precreateErrno = errno;
			const res = await request('/errno-map.txt', { method: 'PUT', body: 'x' });
			expect(res.status).toBe(want);
		});
	});

	describe('LOCK request validation and owner storage', () => {
		it('rejects a non-well-formed LOCK body with 400', async () => {
			const res = await request('/a.txt', {
				method: 'LOCK',
				headers: { 'Content-Type': 'application/xml' },
				body: '<D:lockinfo xmlns:D="DAV:"><D:lockscope><D:exclusive/>',
			});
			expect(res.status).toBe(400);
		});

		it('stores owner markup self-contained (prefixes hoisted from the request)', async () => {
			// The client declares X: only on the lockinfo root; the owner
			// fragment must not re-emerge namespace-dead in lockdiscovery.
			const lockRes = await request('/a.txt', {
				method: 'LOCK',
				headers: { 'Content-Type': 'application/xml' },
				body:
					'<D:lockinfo xmlns:D="DAV:" xmlns:X="urn:x-owner"><D:lockscope><D:exclusive/></D:lockscope>' +
					'<D:locktype><D:write/></D:locktype><D:owner><X:name>Ann</X:name></D:owner></D:lockinfo>',
			});
			expect(lockRes.status).toBe(200);
			const token = lockRes.headers.get('Lock-Token')!;
			const propfind = await request('/a.txt', {
				method: 'PROPFIND',
				headers: { Depth: '0', 'Content-Type': 'application/xml' },
				body: '<D:propfind xmlns:D="DAV:"><D:prop><D:lockdiscovery/></D:prop></D:propfind>',
			});
			const body = await propfind.text();
			expect(body).toContain('<X:name xmlns:X="urn:x-owner">Ann</X:name>');
			await request('/a.txt', { method: 'UNLOCK', headers: { 'Lock-Token': token } });
		});
	});

	describe('MOVE/COPY collection containment (RFC 4918 §9.9.3/§9.9.4)', () => {
		it('MOVE of a collection into its own descendant is 409', async () => {
			await request('/cycle', { method: 'MKCOL' });
			await request('/cycle/sub', { method: 'MKCOL' });
			const res = await request('/cycle', {
				method: 'MOVE',
				headers: { Destination: ORIGIN + '/cycle/sub/moved' },
			});
			expect(res.status).toBe(409);
			expect(tb.find('/cycle/sub/moved')).toBeUndefined();
		});

		it('COPY of a collection into its own descendant is 409', async () => {
			await request('/tree', { method: 'MKCOL' });
			await request('/tree/sub', { method: 'MKCOL' });
			const res = await request('/tree', {
				method: 'COPY',
				headers: { Destination: ORIGIN + '/tree/sub/copied' },
			});
			expect(res.status).toBe(409);
			expect(tb.find('/tree/sub/copied')).toBeUndefined();
		});

		it('MOVE onto an ANCESTOR of the source is 409, never a subtree wipe', async () => {
			// Overwrite: T pre-deletes the destination first — and /docs
			// CONTAINS the source, so the tree (recycle-bin only) would be
			// destroyed before the move could even run.
			const res = await request('/docs/b & c.txt', {
				method: 'MOVE',
				headers: { Destination: ORIGIN + '/docs' },
			});
			expect(res.status).toBe(409);
			expect(tb.find('/docs/b & c.txt')).toBeDefined();
			expect(tb.find('/docs')).toBeDefined();
			expect(tb.find('/docs/sub&dir')).toBeDefined();
		});

		it('refuses to MOVE or COPY the mounted root itself', async () => {
			// A root source normalises to `/`, whose descendant prefix is `//`
			// — nothing matches, so the containment test would let it through.
			const move = await request('/', {
				method: 'MOVE',
				headers: { Destination: ORIGIN + '/elsewhere' },
			});
			expect(move.status).toBe(403);
			const copy = await request('/', {
				method: 'COPY',
				headers: { Destination: ORIGIN + '/elsewhere' },
			});
			expect(copy.status).toBe(403);
			expect(tb.find('/elsewhere')).toBeUndefined();
		});
	});

	describe('PUT stat-error propagation', () => {
		it('a failed target stat is a 502, never a silent create/overwrite', async () => {
			// Only the TARGET stat fails (-5); its parent stays healthy, so
			// the request reaches handlePut's stat and must surface the error
			// instead of reinterpreting it as "absent → 201".
			tb.filemetasFailPaths.set('/a.txt', -5);
			const res = await request('/a.txt', { method: 'PUT', body: 'must not land' });
			expect(res.status).toBe(502);
			// The stored bytes are untouched — no silent overwrite happened.
			expect(new TextDecoder().decode(tb.find('/a.txt')!.content!)).toBe('the quick brown fox\n');
		});

		it('a genuinely absent target (-9) still creates with 201', async () => {
			const res = await request('/brand-new.txt', { method: 'PUT', body: 'created' });
			expect(res.status).toBe(201);
		});
	});

	describe('directory listing truncation guard', () => {
		it('a listing that would truncate fails loudly instead of lying', async () => {
			// The API caps a listing at 100 pages × 100 entries; silently
			// stopping would make sync clients treat the missing tail as
			// deletions on the next run.
			tb.listFullPages = true;
			const res = await request('/docs', { method: 'PROPFIND', headers: { Depth: '1' } });
			expect(res.status).toBe(502);
			const body = (await res.json()) as { error?: string };
			expect(body.error).toContain('truncated');
		});
	});

	describe('mtime fallback (server_mtime absent)', () => {
		it('falls back to the client-visible mtime for Last-Modified and etag', async () => {
			// Real list entries sometimes carry ctime/mtime INSTEAD of
			// server_mtime; epoch-0 Last-Modified breaks conditional requests.
			const node = tb.seed('/no-server-mtime.bin', { content: '0123456789', md5: '' });
			node.server_mtime = 0;
			node.mtime = 1704067200;
			const res = await request('/no-server-mtime.bin');
			expect(res.status).toBe(200);
			expect(res.headers.get('Last-Modified')).toBe(new Date(1704067200 * 1000).toUTCString());
			expect(res.headers.get('ETag')).toBe('W/"1704067200-10-0"');
		});

		it('falls back to ctime when mtime is missing too', async () => {
			const node = tb.seed('/no-mtime.bin', { content: 'abc', md5: '' });
			node.server_mtime = 0;
			node.ctime = 1700000000;
			const res = await request('/no-mtime.bin');
			expect(res.headers.get('Last-Modified')).toBe(new Date(1700000000 * 1000).toUTCString());
		});
	});

	describe('multi-chunk upload (subarray views, no body copies)', () => {
		it('PUTs a >4 MiB file as multiple chunks and round-trips intact', async () => {
			// Free-tier chunk size is 4 MiB; 5 MiB exercises two superfile2
			// uploads. The rewrite passes subarray VIEWS to md5/Blob instead
			// of slice() copies — behavior must be byte-identical.
			const size = 5 * 1024 * 1024 + 12345;
			const bytes = new Uint8Array(size);
			for (let i = 0; i < size; i += 1) bytes[i] = i & 0xff;
			const res = await request('/big.bin', { method: 'PUT', body: bytes });
			expect(res.status).toBe(201);
			expect(tb.superfile2Calls).toBe(2);
			const stored = tb.find('/big.bin')!;
			expect(stored.size).toBe(size);
			// Spot-check the reassembled bytes at chunk boundaries (3 MiB and
			// the 4 MiB seam where the second chunk starts) plus the tail —
			// full toEqual on 5 MiB is needlessly slow.
			expect(stored.content![3 * 1024 * 1024]).toBe((3 * 1024 * 1024) & 0xff);
			expect(stored.content![4 * 1024 * 1024]).toBe(0);
			expect(stored.content![size - 1]).toBe((size - 1) & 0xff);
			// GET serves the same validators as the upload produced.
			const get = await request('/big.bin');
			expect(get.status).toBe(200);
			expect(get.headers.get('ETag')).toBe(`"${stored.md5}"`);
		});

		it('an empty PUT still finalizes as a single zero-byte chunk', async () => {
			const res = await request('/empty2.bin', { method: 'PUT', body: new Uint8Array(0) });
			expect(res.status).toBe(201);
			expect(tb.find('/empty2.bin')!.size).toBe(0);
		});
	});

	describe('XML bare-& rejection', () => {
		it('PROPFIND with a bare & in element text is 400', async () => {
			const res = await request('/a.txt', {
				method: 'PROPFIND',
				headers: { Depth: '0', 'Content-Type': 'application/xml' },
				body: '<D:propfind xmlns:D="DAV:"><D:prop><D:displayname>Tom & Jerry</D:displayname></D:prop></D:propfind>',
			});
			expect(res.status).toBe(400);
		});

		it('PROPFIND with a well-formed &amp; entity is accepted', async () => {
			const res = await request('/a.txt', {
				method: 'PROPFIND',
				headers: { Depth: '0', 'Content-Type': 'application/xml' },
				body: '<D:propfind xmlns:D="DAV:"><D:prop><D:displayname>Tom &amp; Jerry</D:displayname></D:prop></D:propfind>',
			});
			expect(res.status).toBe(207);
		});

		it('LOCK with a bare & in the owner is 400', async () => {
			const res = await request('/a.txt', {
				method: 'LOCK',
				headers: { 'Content-Type': 'application/xml' },
				body:
					'<D:lockinfo xmlns:D="DAV:"><D:lockscope><D:exclusive/></D:lockscope>' +
					'<D:locktype><D:write/></D:locktype><D:owner>R&D</D:owner></D:lockinfo>',
			});
			expect(res.status).toBe(400);
		});
	});
});

describe('HTTP write preconditions (RFC 7232)', () => {
	it('accepts a matching If-Match and rejects a stale one with 412', async () => {
		const head = await request('/a.txt', { method: 'HEAD' });
		expect(head.status).toBe(200);
		const etag = head.headers.get('ETag')!;
		expect(etag).toBeTruthy();

		const ok = await request('/a.txt', {
			method: 'PUT',
			headers: { 'If-Match': etag },
			body: 'replaced under guard',
		});
		expect(ok.status).toBe(204); // existed → 204 No Content
		expect(await (await request('/a.txt')).text()).toBe('replaced under guard');

		// The tag fetched before the write is now stale: the guarded write
		// must fail instead of silently overwriting again.
		const stale = await request('/a.txt', {
			method: 'PUT',
			headers: { 'If-Match': etag },
			body: 'must not land',
		});
		expect(stale.status).toBe(412);
		expect(await (await request('/a.txt')).text()).toBe('replaced under guard');
	});

	it('If-None-Match: * creates but never overwrites', async () => {
		const create = await request('/if-none-star.txt', {
			method: 'PUT',
			headers: { 'If-None-Match': '*' },
			body: 'first',
		});
		expect(create.status).toBe(201);

		const clash = await request('/if-none-star.txt', {
			method: 'PUT',
			headers: { 'If-None-Match': '*' },
			body: 'second',
		});
		expect(clash.status).toBe(412);
		expect(await (await request('/if-none-star.txt')).text()).toBe('first');
	});

	it('If-Match: * on a missing resource is 412', async () => {
		const res = await request('/never-existed.txt', {
			method: 'PUT',
			headers: { 'If-Match': '*' },
			body: 'nope',
		});
		expect(res.status).toBe(412);
		expect(tb.find('/never-existed.txt')).toBeUndefined();
	});

	it('a past If-Unmodified-Since rejects the write', async () => {
		const res = await request('/a.txt', {
			method: 'PUT',
			headers: { 'If-Unmodified-Since': 'Thu, 01 Jan 1970 00:00:00 GMT' },
			body: 'must not land',
		});
		expect(res.status).toBe(412);
		expect(await (await request('/a.txt')).text()).toBe('the quick brown fox\n');
	});

	it('DELETE honours If-Match too', async () => {
		const head = await request('/dest.txt', { method: 'HEAD' });
		const etag = head.headers.get('ETag')!;
		const rejected = await request('/dest.txt', { method: 'DELETE', headers: { 'If-Match': '"nope"' } });
		expect(rejected.status).toBe(412);
		expect(tb.find('/dest.txt')).toBeDefined();
		const allowed = await request('/dest.txt', { method: 'DELETE', headers: { 'If-Match': etag } });
		expect(allowed.status).toBe(204);
		expect(tb.find('/dest.txt')).toBeUndefined();
	});

	it('If-None-Match on a write uses WEAK comparison (W/"x" blocks a PUT)', async () => {
		// RFC 7232 §6: unsafe methods with If-None-Match compare weakly, so the
		// W/-prefixed tag davfs2 sends must collide with our strong etag —
		// otherwise the guard silently never fires and the write lands.
		const head = await request('/a.txt', { method: 'HEAD' });
		const etag = head.headers.get('ETag')!;
		expect(etag.startsWith('"')).toBe(true);

		const rejected = await request('/a.txt', {
			method: 'PUT',
			headers: { 'If-None-Match': `W/${etag}` },
			body: 'must not land',
		});
		expect(rejected.status).toBe(412);
		expect(await (await request('/a.txt')).text()).toBe('the quick brown fox\n');

		// A different validator (weakly) still allows the write.
		const allowed = await request('/a.txt', {
			method: 'PUT',
			headers: { 'If-None-Match': 'W/"something-else"' },
			body: 'landed',
		});
		expect(allowed.status).toBe(204);
		expect(await (await request('/a.txt')).text()).toBe('landed');
	});

	it('MKCOL evaluates If-Match: a guard on a missing path is 412', async () => {
		const guarded = await request('/never-dir', {
			method: 'MKCOL',
			headers: { 'If-Match': '"whatever"' },
		});
		expect(guarded.status).toBe(412);
		expect(tb.find('/never-dir')).toBeUndefined();

		// If-None-Match: * on an unmapped path is the "create if absent" case.
		const create = await request('/fresh-dir', {
			method: 'MKCOL',
			headers: { 'If-None-Match': '*' },
		});
		expect(create.status).toBe(201);
		expect(tb.find('/fresh-dir')).toBeDefined();
	});

	it('evaluate preconditions against live metadata, not the 60 s cache', async () => {
		// Seed a deliberately stale etag into the read cache: a guarded write
		// must still be judged on what Terabox says NOW.
		const head = await request('/a.txt', { method: 'HEAD' });
		const live = head.headers.get('ETag')!;
		metaCacheSeedForTest('/a.txt', {
			path: '/a.txt',
			server_filename: 'a.txt',
			isdir: 0,
			size: 3,
			server_mtime: 1704067200,
			md5: 'ffffffffffffffffffffffffffffffff',
		} as never);
		expect(metaCacheHasForTest('/a.txt')).toBe(true);

		const staleShouldBlock = await request('/a.txt', {
			method: 'PUT',
			headers: { 'If-Match': '"ffffffffffffffffffffffffffffffff"' },
			body: 'nope',
		});
		expect(staleShouldBlock.status).toBe(412);

		const liveShouldPass = await request('/a.txt', {
			method: 'PUT',
			headers: { 'If-Match': live },
			body: 'guarded by the live etag',
		});
		expect(liveShouldPass.status).toBe(204);
	});
});

describe('review round 6: preflight, Allow, control-plane shapes, Destination, headers', () => {
	it('requires credentials for a CORS preflight (no unauthenticated branch)', async () => {
		const res = await SELF.fetch(ORIGIN + '/', {
			method: 'OPTIONS',
			headers: { 'Access-Control-Request-Method': 'PROPFIND' },
		});
		expect(res.status).toBe(401);
		expect(res.headers.get('WWW-Authenticate')).toContain('Basic');
	});

	it('PUT onto a collection answers 405 with the full Allow list', async () => {
		const res = await request('/docs/', { method: 'PUT', body: 'x' });
		expect(res.status).toBe(405);
		expect(res.headers.get('Allow')).toContain('PROPFIND');
		expect(res.headers.get('Allow')).toContain('OPTIONS');
	});

	it('resumable begin onto a collection answers 405 with Allow', async () => {
		const res = await request('/.resumable', {
			method: 'POST',
			body: JSON.stringify({ path: '/docs', size: 4 }),
		});
		expect(res.status).toBe(405);
		expect(res.headers.get('Allow')).toContain('PROPFIND');
	});

	it('MKCOL over an existing file answers 405 advertising discovery methods', async () => {
		const res = await request('/a.txt', { method: 'MKCOL' });
		expect(res.status).toBe(405);
		// The old hardcoded five-method list omitted OPTIONS/PROPFIND/PROPPATCH,
		// which made discovery clients conclude the resource supported nothing.
		expect(res.headers.get('Allow')).toContain('PROPFIND');
		expect(res.headers.get('Allow')).toContain('OPTIONS');
	});

	it('a root-level .resumable file stays reachable at its listed href', async () => {
		// The control plane owns only its four method×shape routes; a real
		// resource with the reserved name must still round-trip: the old
		// textual prefix match listed it via PROPFIND but 404'd at GET.
		const put = await request('/%2eresumable', { method: 'PUT', body: 'ghost content' });
		expect(put.status).toBe(201);
		const list = await request('/', { method: 'PROPFIND', headers: { Depth: '1' } });
		expect(await list.text()).toContain('/.resumable');
		const get = await request('/.resumable');
		expect(get.status).toBe(200);
		expect(await get.text()).toBe('ghost content');
		// The four control routes still belong to the control plane.
		const begin = await request('/.resumable', {
			method: 'POST',
			body: JSON.stringify({ path: '/new-res.txt', size: 4 }),
		});
		expect(begin.status).toBe(200);
	});

	it('MOVE ignores a query string on a relative Destination', async () => {
		const res = await request('/a.txt', {
			method: 'MOVE',
			headers: { Destination: '/moved-q.txt?token=1' },
		});
		expect(res.status).toBe(201);
		expect(tb.find('/moved-q.txt')).toBeTruthy();
		expect(tb.find('/moved-q.txt?token=1')).toBeFalsy();
		expect((await request('/a.txt')).status).toBe(404);
	});

	it('GET of a file carries nosniff and a sandbox CSP', async () => {
		const res = await request('/a.txt');
		expect(res.status).toBe(200);
		expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
		expect(res.headers.get('Content-Security-Policy')).toBe("sandbox; default-src 'none'");
	});

	it('JSON errors and the auth 401 carry nosniff', async () => {
		const missing = await request('/no-such-file.txt');
		expect(missing.status).toBe(404);
		expect(missing.headers.get('X-Content-Type-Options')).toBe('nosniff');
		const unauth = await SELF.fetch(ORIGIN + '/no-such-file.txt');
		expect(unauth.status).toBe(401);
		expect(unauth.headers.get('X-Content-Type-Options')).toBe('nosniff');
	});
});

describe('round 7 pins: lock conflicts, forged tokens, caps', () => {
	const LOCK_BODY =
		'<D:lockinfo xmlns:D="DAV:"><D:lockscope><D:exclusive/></D:lockscope>' +
		'<D:locktype><D:write/></D:locktype><D:owner><D:href>r7</D:href></D:owner></D:lockinfo>';

	// A token in our own minted shape (uuid + 13-digit epoch-ms expiry)
	// that no server instance ever issued.
	const forged = `opaquelocktoken:${crypto.randomUUID()}:${Date.now() + 3600000}`;

	const lock = async (path: string, init: RequestInit = {}): Promise<string> => {
		const res = await request(path, {
			...init,
			method: 'LOCK',
			headers: {
				'Content-Type': 'application/xml',
				...((init.headers as Record<string, string>) ?? {}),
			},
			body: init.body ?? LOCK_BODY,
		});
		expect(res.status).toBe(200);
		return res.headers.get('Lock-Token')!;
	};

	const LOCKDISCOVERY_PROPFIND =
		'<D:propfind xmlns:D="DAV:"><D:prop><D:lockdiscovery/></D:prop></D:propfind>';

	it('rejects LOCK on a member of an exclusively Infinity-locked collection', async () => {
		await request('/r7col', { method: 'MKCOL' });
		await request('/r7col/child.txt', { method: 'PUT', body: 'child' });
		await lock('/r7col');
		// RFC 4918 §9.10.3: the collection's exclusive Infinity lock already
		// covers every member — a LOCK on the child is a conflict (423),
		// not a second independent lock stacked underneath.
		const res = await request('/r7col/child.txt', {
			method: 'LOCK',
			headers: { 'Content-Type': 'application/xml' },
			body: LOCK_BODY,
		});
		expect(res.status).toBe(423);
	});

	it('rejects an Infinity LOCK over a subtree that already holds a member lock', async () => {
		await request('/r7tree', { method: 'MKCOL' });
		await request('/r7tree/mem.txt', { method: 'PUT', body: 'member' });
		await lock('/r7tree/mem.txt');
		// The requested lock would cover a member that is already locked;
		// granting it would overlap two exclusive locks on the same bytes.
		const res = await request('/r7tree', {
			method: 'LOCK',
			headers: { 'Content-Type': 'application/xml' },
			body: LOCK_BODY,
		});
		expect(res.status).toBe(423);
	});

	it('UNLOCK with a well-formed never-issued token is 409 while the real lock lives', async () => {
		await request('/r7un.txt', { method: 'PUT', body: 'locked file' });
		await lock('/r7un.txt');
		// Pre-fix this answered 204 ('lapsed'): our token shape with no live
		// record was treated as an already-lapsed lock — forging an unlock
		// acknowledged for a lock the caller never held (RFC 4918 §9.11).
		// §9.11's Lock-Token production is "<" URI ">", hence the brackets.
		const res = await request('/r7un.txt', {
			method: 'UNLOCK',
			headers: { 'Lock-Token': `<${forged}>` },
		});
		expect(res.status).toBe(409);
	});

	it('LOCK with a Depth header other than 0 or infinity is 400', async () => {
		const res = await request('/a.txt', {
			method: 'LOCK',
			headers: { 'Content-Type': 'application/xml', Depth: '1' },
			body: LOCK_BODY,
		});
		expect(res.status).toBe(400);
	});

	it('PROPPATCH beyond the dead-property size cap answers 507', async () => {
		const big = 'x'.repeat(40000);
		const res = await request('/a.txt', {
			method: 'PROPPATCH',
			headers: { 'Content-Type': 'application/xml' },
			body:
				'<D:propertyupdate xmlns:D="DAV:"><D:set><D:prop>' +
				`<X:big xmlns:X="urn:x">${big}</X:big>` +
				'</D:prop></D:set></D:propertyupdate>',
		});
		expect(res.status).toBe(507);
	});

	it('expired locks stop enforcing and vanish from lockdiscovery', async () => {
		await request('/r7exp.txt', { method: 'PUT', body: 'temporary' });
		await lock('/r7exp.txt', { headers: { Timeout: 'Second-1' } });
		expect((await request('/r7exp.txt', { method: 'PUT', body: 'nope' })).status).toBe(423);
		await new Promise((resolve) => setTimeout(resolve, 1400));
		expect((await request('/r7exp.txt', { method: 'PUT', body: 'freed' })).status).toBe(204);
		const res = await request('/r7exp.txt', {
			method: 'PROPFIND',
			headers: { Depth: '0', 'Content-Type': 'application/xml' },
			body: LOCKDISCOVERY_PROPFIND,
		});
		expect(await res.text()).toContain('<D:lockdiscovery/>');
	});

	it('COPY carries dead properties but never locks', async () => {
		await request('/a.txt', {
			method: 'PROPPATCH',
			headers: { 'Content-Type': 'application/xml' },
			body:
				'<D:propertyupdate xmlns:D="DAV:"><D:set><D:prop>' +
				'<X:r7k xmlns:X="urn:r7">round7</X:r7k></D:prop></D:set></D:propertyupdate>',
		});
		await lock('/a.txt');
		const copy = await request('/a.txt', {
			method: 'COPY',
			headers: { Destination: ORIGIN + '/r7copy-dest.txt' },
		});
		expect(copy.status).toBe(201);
		// RFC 4918 §9.3.1: COPY copies all dead properties…
		const props = await request('/r7copy-dest.txt', {
			method: 'PROPFIND',
			headers: { Depth: '0', 'Content-Type': 'application/xml' },
			body: '<D:propfind xmlns:D="DAV:"><D:prop><X:r7k xmlns:X="urn:r7"/></D:prop></D:propfind>',
		});
		expect(await props.text()).toContain('round7');
		// …but never the locks (§9.10.1 scope): the copy is writable with
		// no token while the source stays locked.
		expect((await request('/r7copy-dest.txt', { method: 'PUT', body: 'free' })).status).toBe(204);
		expect((await request('/a.txt', { method: 'PUT', body: 'blocked' })).status).toBe(423);
	});
});

describe('round 8 pins: If Resource-Tags and negation (memory fallback)', () => {
	const LOCK_BODY =
		'<D:lockinfo xmlns:D="DAV:"><D:lockscope><D:exclusive/></D:lockscope>' +
		'<D:locktype><D:write/></D:locktype><D:owner><D:href>r8</D:href></D:owner></D:lockinfo>';

	const lock = async (path: string): Promise<string> => {
		const res = await request(path, {
			method: 'LOCK',
			headers: { 'Content-Type': 'application/xml' },
			body: LOCK_BODY,
		});
		expect(res.status).toBe(200);
		return res.headers.get('Lock-Token')!;
	};

	it('COPY accepts a dest-tagged token over a locked destination (§7.5.1)', async () => {
		const tag = crypto.randomUUID().slice(0, 8);
		const destPath = `/r8mem-dest-${tag}.txt`;
		tb.seed(destPath, { content: 'locked dest\n' });
		const token = await lock(destPath);
		const copy = await request('/a.txt', {
			method: 'COPY',
			headers: {
				Destination: ORIGIN + destPath,
				If: `<${ORIGIN}${destPath}> (${token})`,
			},
		});
		expect(copy.status).toBe(204);
	});

	it('MOVE accepts source and destination tokens in tagged lists (§7.5)', async () => {
		const tag = crypto.randomUUID().slice(0, 8);
		const destPath = `/r8mem-mvdest-${tag}.txt`;
		tb.seed(destPath, { content: 'locked dest\n' });
		const srcToken = await lock('/a.txt');
		const destToken = await lock(destPath);
		const move = await request('/a.txt', {
			method: 'MOVE',
			headers: {
				Destination: ORIGIN + destPath,
				If:
					`<${ORIGIN}/a.txt> (${srcToken}) ` +
					`<${ORIGIN}${destPath}> (${destToken})`,
			},
		});
		expect(move.status).toBe(204);
	});

	it('(not <live-token>) on the locked resource itself fails the condition', async () => {
		const tag = crypto.randomUUID().slice(0, 8);
		const target = `/r8mem-not-${tag}.txt`;
		tb.seed(target, { content: 'locked\n' });
		const token = await lock(target);
		// Pre-fix `not` was case-sensitively MISSED, the term parsed
		// positive, the real token satisfied it and the write proceeded
		// (204). The negation makes it false → header false → 412.
		const put = await request(target, {
			method: 'PUT',
			headers: { If: `(not ${token})` },
			body: 'negated',
		});
		expect(put.status).toBe(412);
	});
});

describe('round 9 pins: If fail-closed, target cap, refresh-only LOCK, 413, %5c', () => {
	const LOCK_BODY =
		'<D:lockinfo xmlns:D="DAV:"><D:lockscope><D:exclusive/></D:lockscope>' +
		'<D:locktype><D:write/></D:locktype><D:owner><D:href>r9</D:href></D:owner></D:lockinfo>';

	it('fails an unresolvable Resource-Tag list even when its terms are negated (§10.4.10)', async () => {
		const foreign = 'https://foreign-origin.invalid/elsewhere.txt';
		const token = await request('/a.txt', {
			method: 'PUT',
			headers: {
				If: `<${foreign}> (Not <opaquelocktoken:00000000-0000-0000-0000-000000000000:0>)`,
			},
			body: 'x',
		});
		expect(token.status).toBe(412);
		const etag = await request('/a.txt', {
			method: 'PUT',
			headers: { If: `<${foreign}> (Not ["deadbeef"])` },
			body: 'x',
		});
		expect(etag.status).toBe(412);
	});

	it('caps distinct tagged If targets: the 9th answers 400', async () => {
		const lists = Array.from(
			{ length: 9 },
			(_, i) =>
				`<${ORIGIN}/r9cap-${i}.txt> (Not <opaquelocktoken:00000000-0000-0000-0000-000000000000:0>)`,
		).join(' ');
		const res = await request('/a.txt', { method: 'PUT', headers: { If: lists }, body: 'x' });
		expect(res.status).toBe(400);
	});

	it('body-less LOCK is refresh-only: tag-like or bogus If never mints (§9.10.1)', async () => {
		const path = '/r9refresh.txt';
		tb.seed(path, { content: 'seeded' });
		const relTag = await request(path, { method: 'LOCK', headers: { If: `</r9refresh.txt>` } });
		// §9.10.6 lock-token-matches-request-uri: 412 (was briefly 409 in
		// round 9; see round-10 pins below for the foreign-token shape).
		expect(relTag.status).toBe(412);
		const bogus = await request(path, {
			method: 'LOCK',
			headers: { If: '(<opaquelocktoken:00000000-0000-0000-0000-000000000000:0>)' },
		});
		expect(bogus.status).toBe(412);
		// Neither attempt may have left a lock behind: a real LOCK still succeeds.
		const fresh = await request(path, {
			method: 'LOCK',
			headers: { 'Content-Type': 'application/xml' },
			body: LOCK_BODY,
		});
		expect(fresh.status).toBe(200);
	});

	it('refuses an XML body over 4 MiB with 413 before buffering', async () => {
		const body =
			'<?xml version="1.0" encoding="utf-8"?>' +
			`<D:propfind xmlns:D="DAV:"><D:allprop/><D:pad>${'x'.repeat(4 * 1024 * 1024)}</D:pad></D:propfind>`;
		const res = await request('/a.txt', {
			method: 'PROPFIND',
			headers: { Depth: '0', 'Content-Type': 'application/xml' },
			body,
		});
		expect(res.status).toBe(413);
	});

	it('rejects percent-encoded backslash traversal, keeps plain backslash names', async () => {
		const evil = await request('/r9%5c..%5cx.txt', { method: 'PUT', body: 'x' });
		expect(evil.status).toBe(400);
		const plain = await request('/r9a%5cb.txt', { method: 'PUT', body: 'x' });
		expect(plain.status).toBe(201);
	});
});

describe('round 10 pins: 412 refresh gate, volatile grace, stream cap, JSON path, empty If', () => {
	const LOCK_BODY =
		'<D:lockinfo xmlns:D="DAV:"><D:lockscope><D:exclusive/></D:lockscope>' +
		'<D:locktype><D:write/></D:locktype><D:owner><D:href>r10</D:href></D:owner></D:lockinfo>';

	async function lock(path: string): Promise<string> {
		const res = await request(path, {
			method: 'LOCK',
			headers: { 'Content-Type': 'application/xml' },
			body: LOCK_BODY,
		});
		expect(res.status).toBe(200);
		const token = res.headers.get('Lock-Token');
		expect(token).toBeTruthy();
		return token!;
	}

	it('body-less LOCK with only another resource\'s live token answers 412 (§9.10.6)', async () => {
		// End-to-end RFC pin: the answer must be 412 no matter which layer
		// produces it (refresh gate or lockAcquire's owned-elsewhere rule).
		// The gate-SPECIFIC detector is the bogus-token pin in the round-9
		// describe — without the gate that one mints (200) instead of 412.
		const other = `/r10foreign-${crypto.randomUUID().slice(0, 8)}.txt`;
		tb.seed(other, { content: 'locked elsewhere' });
		tb.seed('/r10target.txt', { content: 'fresh target' });
		const foreign = await lock(other);
		const res = await request('/r10target.txt', { method: 'LOCK', headers: { If: `(${foreign})` } });
		expect(res.status).toBe(412);
	});

	it('body-less refresh re-establishes a lock whose memory record was lost (volatile grace)', async () => {
		const path = `/r10grace-${crypto.randomUUID().slice(0, 8)}.txt`;
		tb.seed(path, { content: 'grace' });
		const token = await lock(path);
		resetDavVolatileState();
		// Prove the record really is gone first — otherwise a genuine,
		// record-backed refresh would also answer 200 and this pin could not
		// distinguish the volatile grace from a no-op reset.
		const discovery = async (): Promise<string> => {
			const res = await request(path, {
				method: 'PROPFIND',
				headers: { Depth: '0', 'Content-Type': 'application/xml' },
				body: '<D:propfind xmlns:D="DAV:"><D:prop><D:lockdiscovery/></D:prop></D:propfind>',
			});
			return res.text();
		};
		expect(await discovery()).not.toContain('opaquelocktoken');
		const refresh = await request(path, { method: 'LOCK', headers: { If: `(${token})` } });
		expect(refresh.status).toBe(200);
		expect(await discovery()).toContain('opaquelocktoken');
	});

	it('a streamed XML body without content-length still trips the 413 cap', async () => {
		const chunk = new TextEncoder().encode('x'.repeat(1024 * 1024));
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				for (let i = 0; i < 5; i += 1) controller.enqueue(chunk);
				controller.close();
			},
		});
		const res = await request('/a.txt', {
			method: 'PROPFIND',
			headers: { Depth: '0', 'Content-Type': 'application/xml' },
			body,
		});
		expect(res.status).toBe(413);
	});

	it('resumable begin refuses a JSON path with backslash-hidden traversal', async () => {
		tb.seed('/r10dir', { isdir: 1 });
		const res = await request('/.resumable', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ path: '/r10dir/..\\..\\evil.txt', size: 10 }),
		});
		expect(res.status).toBe(400);
	});

	it('an empty If header is treated as absent on LOCK (parity with PUT)', async () => {
		const path = `/r10emptyif-${crypto.randomUUID().slice(0, 8)}.txt`;
		tb.seed(path, { content: 'seeded' });
		const res = await request(path, {
			method: 'LOCK',
			headers: { If: '', 'Content-Type': 'application/xml' },
			body: LOCK_BODY,
		});
		expect(res.status).toBe(200);
	});
});

describe('round 11 pins: LOCK If semantics, body caps, upload session cap, finalize', () => {
	const LOCK_BODY =
		'<D:lockinfo xmlns:D="DAV:"><D:lockscope><D:exclusive/></D:lockscope>' +
		'<D:locktype><D:write/></D:locktype><D:owner><D:href>r11</D:href></D:owner></D:lockinfo>';

	async function lock(path: string): Promise<string> {
		const res = await request(path, {
			method: 'LOCK',
			headers: { 'Content-Type': 'application/xml' },
			body: LOCK_BODY,
		});
		expect(res.status).toBe(200);
		const token = res.headers.get('Lock-Token');
		expect(token).toBeTruthy();
		return token!;
	}

	it('body-less LOCK whose If yields no token (tag or etag terms) answers 412', async () => {
		const path = '/r11notoken.txt';
		tb.seed(path, { content: 'seeded' });
		const tagged = await request(path, {
			method: 'LOCK',
			headers: { If: `(<${ORIGIN}/r11notoken.txt>)` },
		});
		expect(tagged.status).toBe(412);
		const etagged = await request(path, { method: 'LOCK', headers: { If: '(["deadbeef"])' } });
		expect(etagged.status).toBe(412);
	});

	it('a negated live token is not a refresh credential (Not polarity → 412)', async () => {
		const path = '/r11negated.txt';
		tb.seed(path, { content: 'seeded' });
		const token = await lock(path);
		const res = await request(path, { method: 'LOCK', headers: { If: `(Not ${token})` } });
		expect(res.status).toBe(412);
		// The lock itself is untouched.
		expect((await request(path, { method: 'PUT', body: 'x' })).status).toBe(423);
	});

	it('a create-LOCK whose If condition is false answers 412 instead of minting', async () => {
		const path = '/r11false.txt';
		tb.seed(path, { content: 'seeded' });
		const res = await request(path, {
			method: 'LOCK',
			headers: { 'Content-Type': 'application/xml', If: '(["stale-etag"])' },
			body: LOCK_BODY,
		});
		expect(res.status).toBe(412);
		// Nothing was minted: a plain LOCK still succeeds afterwards.
		const fresh = await request(path, {
			method: 'LOCK',
			headers: { 'Content-Type': 'application/xml' },
			body: LOCK_BODY,
		});
		expect(fresh.status).toBe(200);
	});

	it('a body-carrying LOCK without lockscope is 400 even when an If is present', async () => {
		const path = '/r11noscope.txt';
		tb.seed(path, { content: 'seeded' });
		const res = await request(path, {
			method: 'LOCK',
			headers: {
				'Content-Type': 'application/xml',
				If: '(<opaquelocktoken:00000000-0000-0000-0000-000000000000:0>)',
			},
			body: '<D:lockinfo xmlns:D="DAV:"><D:owner>x</D:owner></D:lockinfo>',
		});
		expect(res.status).toBe(400);
	});

	it('a content-length-less oversized chunk stream stops at expected+1 (400)', async () => {
		const begin = await request('/.resumable', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ path: '/r11chunk.bin', size: 1000 }),
		});
		expect(begin.status).toBe(200);
		const begun = (await begin.json()) as { uploadId: string; chunkCount: number };
		expect(begun.chunkCount).toBe(1);
		// 1005 bytes with NO content-length: the declared fast-path cannot
		// fire, so only the streaming cap may stop the body.
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new Uint8Array(1005).fill(0x61));
				controller.close();
			},
		});
		const res = await request(`/.resumable/${begun.uploadId}/0`, {
			method: 'PUT',
			body: stream,
		});
		expect(res.status).toBe(400);
		expect(await res.text()).toContain('exceeds');
		await request(`/.resumable/${begun.uploadId}`, { method: 'DELETE' });
	});

	it('resumable begin refuses a JSON body over 64 KiB (413)', async () => {
		const res = await request('/.resumable', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ path: '/r11big.json', size: 10, pad: 'x'.repeat(70 * 1024) }),
		});
		expect(res.status).toBe(413);
	});

	it(
		'caps OPEN upload sessions: finalized ones do not count, 65th open begin → 507',
		async () => {
			// Phase 1: fill the map with 64 FINALIZED sessions — bounded by
			// their 10 min grace, so they must NOT count toward the cap.
			for (let i = 0; i < 64; i += 1) {
				const begin = await request('/.resumable', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ path: `/r11done-${i}.bin`, size: 10 }),
				});
				expect(begin.status).toBe(200);
				const begun = (await begin.json()) as { uploadId: string };
				const put = await request(`/.resumable/${begun.uploadId}/0`, {
					method: 'PUT',
					body: new Uint8Array(10).fill(1),
				});
				expect(put.status).toBe(200);
				const fin = await request(`/.resumable/${begun.uploadId}/finalize`, {
					method: 'POST',
				});
				expect(fin.status).toBe(201);
			}
			// Phase 2: map size is 64 but zero sessions are open → still 200.
			// (A size-based cap would 507 here and brick batch uploads.)
			const next = await request('/.resumable', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ path: '/r11open-first.bin', size: 10 }),
			});
			expect(next.status).toBe(200);
			let openAccepted = 1;
			// Phase 3: NOW the open cap applies: 63 more open, the 65th refuses.
			let refused = false;
			for (let i = 0; i < 70 && !refused; i += 1) {
				const res = await request('/.resumable', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ path: `/r11open-${i}.bin`, size: 10 }),
				});
				if (res.status === 507) {
					refused = true;
					break;
				}
				expect(res.status).toBe(200);
				openAccepted += 1;
			}
			expect(refused).toBe(true);
			expect(openAccepted).toBe(64);
		},
		// ~256 serialized round-trips (64 begin+chunk+finalize + 64 begins);
		// parallel test-file CPU contention can stretch this 10-20x past its
		// isolated ~4.5 s.
		180_000,
	);

	it('finalize answers 201 when the target vanished after begin (fresh existence)', async () => {
		// /dest.txt is seeded: existed at begin (overwriteMode 3), so the
		// begin-time snapshot would answer 204 after the mid-flight delete.
		const begin = await request('/.resumable', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ path: '/dest.txt', size: 3 }),
		});
		expect(begin.status).toBe(200);
		const begun = (await begin.json()) as { uploadId: string; chunkCount: number };
		const put = await request(`/.resumable/${begun.uploadId}/0`, {
			method: 'PUT',
			body: new Uint8Array([1, 2, 3]),
		});
		expect(put.status).toBe(200);
		expect((await request('/dest.txt', { method: 'DELETE' })).status).toBe(204);
		const fin = await request(`/.resumable/${begun.uploadId}/finalize`, { method: 'POST' });
		expect(fin.status).toBe(201);
	});

	it('finalize evaluates a false If condition (412) and releases the claim', async () => {
		const begin = await request('/.resumable', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ path: '/r11fin.txt', size: 3 }),
		});
		expect(begin.status).toBe(200);
		const begun = (await begin.json()) as { uploadId: string; chunkCount: number };
		const put = await request(`/.resumable/${begun.uploadId}/0`, {
			method: 'PUT',
			body: new Uint8Array([1, 2, 3]),
		});
		expect(put.status).toBe(200);
		const fin = await request(`/.resumable/${begun.uploadId}/finalize`, {
			method: 'POST',
			headers: { If: '(["stale-etag"])' },
		});
		expect(fin.status).toBe(412);
		// The claim was released by the failure: a clean retry succeeds.
		const retry = await request(`/.resumable/${begun.uploadId}/finalize`, { method: 'POST' });
		expect(retry.status).toBe(201);
	});
});

describe('litmus protected: .DAV is a reserved segment (403 on every method)', () => {
	it('rejects every read/write/admin method on .DAV paths with 403', async () => {
		// Seed the exact shapes litmus's protected suite uses: a collection
		// `.DAV` under a test collection, plus a file inside it.
		expect((await request('/.DAV/test.txt', { method: 'PUT', body: 'x' })).status).toBe(403);
		const methods: Array<[string, RequestInit]> = [
			['GET', {}],
			['HEAD', {}],
			['PUT', { body: 'x' }],
			['DELETE', {}],
			['PROPFIND', {}],
			['PROPPATCH', { headers: { 'Content-Type': 'application/xml' }, body: '<?xml version="1.0"?><D:propertyupdate xmlns:D="DAV:"><D:set><D:prop><D:displayname>x</D:displayname></D:prop></D:set></D:propertyupdate>' }],
			['LOCK', { headers: { 'Content-Type': 'application/xml' }, body: '<?xml version="1.0"?><D:lockinfo xmlns:D="DAV:"><D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype><D:owner>x</D:owner></D:lockinfo>' }],
			['UNLOCK', {}],
			['MKCOL', {}],
		];
		for (const [method, init] of methods) {
			const res = await request('/.DAV/test.txt', { method, ...init });
			expect(res.status, `${method} /dav/.DAV/test.txt`).toBe(403);
		}
		// The collection itself and deeper paths are equally reserved.
		expect((await request('/.DAV', { method: 'PROPFIND' })).status).toBe(403);
		expect((await request('/.DAV', { method: 'GET' })).status).toBe(403);
		expect((await request('/.DAV', { method: 'DELETE' })).status).toBe(403);
		expect((await request('/.DAV', { method: 'MKCOL' })).status).toBe(403);
		expect((await request('/docs/.DAV/deeper', { method: 'GET' })).status).toBe(403);
		expect((await request('/sub/.DAV/x', { method: 'PUT', body: 'x' })).status).toBe(403);
	}, 30_000);

	it('is case-insensitive: .dav and .Dav are reserved too', async () => {
		expect((await request('/.dav/test.txt', { method: 'GET' })).status).toBe(403);
		expect((await request('/.Dav/test.txt', { method: 'PUT', body: 'x' })).status).toBe(403);
	});

	it('blocks COPY/MOVE on both source and reserved destinations', async () => {
		// Destination into the reserved directory.
		let res = await request('/a.txt', {
			method: 'COPY',
			headers: { Destination: ORIGIN + '/.DAV/copied.txt', Overwrite: 'T' },
		});
		expect(res.status).toBe(403);
		res = await request('/a.txt', {
			method: 'MOVE',
			headers: { Destination: ORIGIN + '/.DAV/moved.txt', Overwrite: 'T' },
		});
		expect(res.status).toBe(403);
		// Source out of / under the reserved directory.
		res = await request('/.DAV/test.txt', {
			method: 'COPY',
			headers: { Destination: ORIGIN + '/extracted.txt' },
		});
		expect(res.status).toBe(403);
		res = await request('/docs/.DAV/x', {
			method: 'MOVE',
			headers: { Destination: ORIGIN + '/extracted2.txt' },
		});
		expect(res.status).toBe(403);
		// The reserved tree was never created.
		const listing = await request('/', { method: 'PROPFIND', headers: { Depth: '1' } });
		expect(listing.status).toBe(207);
		expect(await listing.text()).not.toContain('.DAV');
	});

	it('leaves OPTIONS on .DAV allowed (harmless discovery)', async () => {
		expect((await request('/.DAV/test.txt', { method: 'OPTIONS' })).status).toBe(204);
	});

	it('does not over-block: a name merely containing .DAV stays usable', async () => {
		expect((await request('/.DAVx', { method: 'PUT', body: 'keeper' })).status).toBe(201);
		expect((await request('/.DAVx', { method: 'GET' })).status).toBe(200);
		expect((await request('/a.DAV', { method: 'MKCOL' })).status).toBe(201);
		expect((await request('/a.DAV', { method: 'DELETE' })).status).toBe(204);
		expect((await request('/.DAVx', { method: 'DELETE' })).status).toBe(204);
	});

	it('normal traffic is untouched by the reservation', async () => {
		expect((await request('/a.txt')).status).toBe(200);
		expect((await request('/docs', { method: 'PROPFIND', headers: { Depth: '1' } })).status).toBe(207);
		expect((await request('/new-col', { method: 'MKCOL' })).status).toBe(201);
	});
});

describe('PUT body paths: streaming above the threshold, capped buffer without Content-Length', () => {
	// A failed expectation above must not leak a live prototype spy into the
	// next case (vi.spyOn re-wraps an existing spy, carrying call counts).
	afterEach(() => {
		vi.restoreAllMocks();
	});

	const payloadOfSize = (size: number): Uint8Array => {
		const payload = new Uint8Array(size);
		const tile = new Uint8Array(65536);
		for (let i = 0; i < tile.length; i += 1) tile[i] = (i * 7 + 13) % 251;
		for (let off = 0; off < size; off += tile.length) {
			payload.set(tile.subarray(0, Math.min(tile.length, size - off)), off);
		}
		return payload;
	};

	it('streams a Content-Length body above 4 MiB and stores it byte-for-byte', async () => {
		const streamSpy = vi.spyOn(TeraboxClient.prototype, 'uploadStream');
		const bufferSpy = vi.spyOn(TeraboxClient.prototype, 'upload');
		const payload = payloadOfSize(5 * 1024 * 1024 + 7);

		const res = await request('/big-stream.bin', { method: 'PUT', body: payload });
		expect(res.status).toBe(201);
		expect(streamSpy).toHaveBeenCalledTimes(1);
		expect(bufferSpy).not.toHaveBeenCalled();
		// 5 MiB + 7 at a 4 MiB chunk size is exactly two superfile2 parts.
		expect(tb.superfile2Calls).toBe(2);

		const got = await request('/big-stream.bin');
		expect(got.status).toBe(200);
		expect(new Uint8Array(await got.arrayBuffer())).toEqual(payload);

		streamSpy.mockRestore();
		bufferSpy.mockRestore();
	}, 60_000);

	it('streams an overwrite too (204, new content)', async () => {
		const streamSpy = vi.spyOn(TeraboxClient.prototype, 'uploadStream');
		const payload = payloadOfSize(4 * 1024 * 1024 + 1);
		expect((await request('/a.txt', { method: 'PUT', body: payload })).status).toBe(204);
		expect(streamSpy).toHaveBeenCalledTimes(1);
		const got = await request('/a.txt');
		expect(new Uint8Array(await got.arrayBuffer())).toEqual(payload);
		streamSpy.mockRestore();
	}, 60_000);

	it('without Content-Length a body over the buffer cap is refused with 413 and never created', async () => {
		const bufferSpy = vi.spyOn(TeraboxClient.prototype, 'upload');
		const streamSpy = vi.spyOn(TeraboxClient.prototype, 'uploadStream');
		// 33 MiB in 1 MiB slices: the test process never holds the body, and
		// neither does the worker — the cap fires while reading.
		let sent = 0;
		const bounded = new ReadableStream<Uint8Array>({
			pull(controller) {
				sent += 1;
				if (sent > 33) {
					controller.close();
					return;
				}
				controller.enqueue(new Uint8Array(1024 * 1024));
			},
		});
		const res = await request('/too-big-nocl.bin', { method: 'PUT', body: bounded });
		expect(res.status).toBe(413);
		expect(bufferSpy).not.toHaveBeenCalled();
		expect(streamSpy).not.toHaveBeenCalled();
		expect((await request('/too-big-nocl.bin')).status).toBe(404);
		bufferSpy.mockRestore();
		streamSpy.mockRestore();
	}, 60_000);

	it('without Content-Length a small body still buffers through upload()', async () => {
		const streamSpy = vi.spyOn(TeraboxClient.prototype, 'uploadStream');
		const bufferSpy = vi.spyOn(TeraboxClient.prototype, 'upload');
		let sent = 0;
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				sent += 1;
				if (sent > 2) {
					controller.close();
					return;
				}
				controller.enqueue(new Uint8Array(512 * 1024));
			},
		});
		const res = await request('/small-nocl.bin', { method: 'PUT', body });
		expect(res.status).toBe(201);
		expect(bufferSpy).toHaveBeenCalledTimes(1);
		expect(streamSpy).not.toHaveBeenCalled();
		expect((await request('/small-nocl.bin', { method: 'DELETE' })).status).toBe(204);
		bufferSpy.mockRestore();
		streamSpy.mockRestore();
	});

	it('a body shorter than its Content-Length is a 400 and publishes nothing', async () => {
		const streamSpy = vi.spyOn(TeraboxClient.prototype, 'uploadStream');
		let sent = 0;
		const short = new ReadableStream<Uint8Array>({
			pull(controller) {
				sent += 1;
				if (sent > 1) {
					controller.close();
					return;
				}
				controller.enqueue(new Uint8Array(1024 * 1024));
			},
		});
		const res = await request('/truncated.bin', {
			method: 'PUT',
			headers: { 'Content-Length': String(5 * 1024 * 1024 + 7) },
			body: short,
		});
		expect(res.status).toBe(400);
		expect(streamSpy).toHaveBeenCalled();
		expect((await request('/truncated.bin')).status).toBe(404);
		streamSpy.mockRestore();
	});
});

describe('round 17 review pins', () => {
	it('rejects a PROPFIND naming more distinct properties than the cap', async () => {
		const props = Array.from({ length: 129 }, (_, i) => `<X:p${i}/>`).join('');
		const res = await request('/a.txt', {
			method: 'PROPFIND',
			headers: { Depth: '0', 'Content-Type': 'application/xml' },
			body: `<D:propfind xmlns:D="DAV:" xmlns:X="urn:x"><D:prop>${props}</D:prop></D:propfind>`,
		});
		expect(res.status).toBe(400);
	});

	it('dedupes repeated property names before the cap', async () => {
		const props = '<D:displayname/>'.repeat(200);
		const res = await request('/a.txt', {
			method: 'PROPFIND',
			headers: { Depth: '0', 'Content-Type': 'application/xml' },
			body: `<D:propfind xmlns:D="DAV:"><D:prop>${props}</D:prop></D:propfind>`,
		});
		expect(res.status).toBe(207);
		const body = await res.text();
		expect(body.split('<D:displayname>').length - 1).toBe(1);
	});

	it('does not treat a negated live token as a write credential', async () => {
		const lockRes = await request('/a.txt', {
			method: 'LOCK',
			headers: { 'Content-Type': 'application/xml' },
			body:
				'<D:lockinfo xmlns:D="DAV:"><D:lockscope><D:exclusive/></D:lockscope>' +
				'<D:locktype><D:write/></D:locktype><D:owner><D:href>tester</D:href></D:owner></D:lockinfo>',
		});
		expect(lockRes.status).toBe(200);
		const token = lockRes.headers.get('Lock-Token')!;
		// The second (trivially true) list used to make the header pass; the
		// negated live token then satisfied enforcement because collectTokens
		// keeps `Not` terms. Only a positive term is a capability.
		const res = await request('/a.txt', {
			method: 'PUT',
			headers: { If: `(Not ${token}) (Not <urn:uuid:deadbeef>)` },
			body: 'bypass',
		});
		expect(res.status).toBe(423);
		expect(new TextDecoder().decode(tb.find('/a.txt')!.content)).toBe('the quick brown fox\n');
	});

	it('rejects a weak If-Match validator on PUT (strong comparison)', async () => {
		tb.seed('/weak-etag.txt', { content: 'weak', md5: '' });
		const head = await request('/weak-etag.txt');
		const etag = head.headers.get('ETag')!;
		expect(etag.startsWith('W/')).toBe(true);
		const res = await request('/weak-etag.txt', {
			method: 'PUT',
			headers: { 'If-Match': etag },
			body: 'replacement',
		});
		expect(res.status).toBe(412);
		expect(new TextDecoder().decode(tb.find('/weak-etag.txt')!.content)).toBe('weak');
	});

	it('rejects PUT with Content-Range instead of storing the fragment whole', async () => {
		const res = await request('/ranged.txt', {
			method: 'PUT',
			headers: { 'Content-Range': 'bytes 0-3/10' },
			body: 'abcd',
		});
		expect(res.status).toBe(400);
		expect(tb.find('/ranged.txt')).toBeUndefined();
	});

	it('reserves .DAV even when sanitization would create it', async () => {
		const res = await request('/.DAV%E2%98%80', { method: 'MKCOL' });
		expect(res.status).toBe(403);
		expect(tb.find('/.DAV')).toBeUndefined();
	});

	it('reserves .DAV in the resumable begin path too', async () => {
		const res = await request('/.resumable', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ path: '/.DAV☀/x.bin', size: 1 }),
		});
		expect(res.status).toBe(403);
	});

	it('refuses a LOCK owner above the storage cap', async () => {
		const owner = 'x'.repeat(9 * 1024);
		const res = await request('/a.txt', {
			method: 'LOCK',
			headers: { 'Content-Type': 'application/xml' },
			body:
				'<D:lockinfo xmlns:D="DAV:"><D:lockscope><D:exclusive/></D:lockscope>' +
				`<D:locktype><D:write/></D:locktype><D:owner>${owner}</D:owner></D:lockinfo>`,
		});
		expect(res.status).toBe(507);
	});
});

describe('performance: HEAD and directory listings', () => {
	const PF_BODY =
		'<D:propfind xmlns:D="DAV:"><D:prop><D:displayname/></D:prop></D:propfind>';
	const pfInit = (depth: string): RequestInit => ({
		method: 'PROPFIND',
		headers: { Depth: depth, 'Content-Type': 'application/xml' },
		body: PF_BODY,
	});

	it('answers HEAD from cached metadata without walking the download ladder', async () => {
		tb.seed('/head-fast.txt', { content: 'head-fast-path' });
		const res = await request('/head-fast.txt', { method: 'HEAD' });
		expect(res.status).toBe(200);
		expect(res.headers.get('Content-Length')).toBe(String('head-fast-path'.length));
		expect(res.headers.get('ETag')).toBeTruthy();
		expect(await res.text()).toBe('');
		// The pin: a metadata probe must not mint a link or open a CDN body.
		expect(tb.dlCalls).toBe(0);
		expect(tb.downloadFidlists).toHaveLength(0);
	});

	it('answers a ranged HEAD from stat with the exact Content-Range', async () => {
		tb.seed('/head-range.bin', { content: '0123456789' });
		const res = await request('/head-range.bin', {
			method: 'HEAD',
			headers: { Range: 'bytes=2-5' },
		});
		expect(res.status).toBe(206);
		expect(res.headers.get('Content-Length')).toBe('4');
		expect(res.headers.get('Content-Range')).toBe('bytes 2-5/10');
		expect(tb.dlCalls).toBe(0);
	});

	it('collapses a repeated Depth:1 listing into one upstream page fetch', async () => {
		tb.seed('/list-cache', { isdir: 1 });
		tb.seed('/list-cache/one.txt', { content: '1' });
		const first = await request('/list-cache', pfInit('1'));
		expect(first.status).toBe(207);
		expect(tb.listCalls).toBe(1);
		const second = await request('/list-cache', pfInit('1'));
		expect(second.status).toBe(207);
		expect(await second.text()).toContain('one.txt');
		expect(tb.listCalls).toBe(1);
	});

	it('drops the cached listing when a write goes through the worker', async () => {
		tb.seed('/list-inv', { isdir: 1 });
		expect((await request('/list-inv', pfInit('1'))).status).toBe(207);
		expect(tb.listCalls).toBe(1);
		const put = await request('/list-inv/new.txt', { method: 'PUT', body: 'fresh' });
		expect(put.status).toBe(201);
		const after = await request('/list-inv', pfInit('1'));
		expect(after.status).toBe(207);
		expect(await after.text()).toContain('new.txt');
		expect(tb.listCalls).toBe(2);
	});
});

describe('range validity and listing races (round 18)', () => {
	const PF_BODY =
		'<D:propfind xmlns:D="DAV:"><D:prop><D:displayname/></D:prop></D:propfind>';
	const pfInit = (depth: string): RequestInit => ({
		method: 'PROPFIND',
		headers: { Depth: depth, 'Content-Type': 'application/xml' },
		body: PF_BODY,
	});

	it('ignores an inverted range for HEAD and GET (RFC 9110 §14.1.1)', async () => {
		tb.seed('/inverted.bin', { content: '0123456789' });
		const head = await request('/inverted.bin', {
			method: 'HEAD',
			headers: { Range: 'bytes=5-3' },
		});
		expect(head.status).toBe(200);
		expect(head.headers.get('Content-Length')).toBe('10');
		expect(head.headers.get('Content-Range')).toBeNull();
		const get = await request('/inverted.bin', { headers: { Range: 'bytes=5-3' } });
		expect(get.status).toBe(200);
		expect(await get.text()).toBe('0123456789');
	});

	it('does not cache a listing that was in flight when a write landed', async () => {
		tb.seed('/race-dir', { isdir: 1 });
		tb.seed('/race-dir/old.txt', { content: 'old' });
		let release!: () => void;
		const hold = new Promise<void>((resolve) => (release = resolve));
		let entered!: () => void;
		const started = new Promise<void>((resolve) => (entered = resolve));
		tb.listHold = hold;
		tb.listHoldStarted = entered;
		const pending = request('/race-dir', pfInit('1'));
		await started;
		expect((await request('/race-dir/new.txt', { method: 'PUT', body: 'fresh' })).status).toBe(201);
		release();
		expect((await pending).status).toBe(207);
		tb.listHold = null;
		tb.listHoldStarted = null;
		// The pre-write snapshot must not have been stored: the next listing
		// walks upstream again and sees the file.
		const after = await request('/race-dir', pfInit('1'));
		expect(after.status).toBe(207);
		expect(await after.text()).toContain('new.txt');
		expect(tb.listCalls).toBe(2);
	});
});

describe('collection mutations honour member locks (RFC 4918 §9.6.1/§9.9.4)', () => {
	const LOCK_BODY =
		'<D:lockinfo xmlns:D="DAV:"><D:lockscope><D:exclusive/></D:lockscope>' +
		'<D:locktype><D:write/></D:locktype><D:owner><D:href>member-tester</D:href></D:owner></D:lockinfo>';

	async function lockPath(path: string): Promise<string> {
		const res = await request(path, {
			method: 'LOCK',
			headers: { 'Content-Type': 'application/xml' },
			body: LOCK_BODY,
		});
		expect(res.status).toBe(200);
		return res.headers.get('Lock-Token')!;
	}

	it('DELETE of a collection requires the token of a locked member', async () => {
		tb.seed('/lock-coll', { isdir: 1 });
		tb.seed('/lock-coll/child.txt', { content: 'locked child' });
		const token = await lockPath('/lock-coll/child.txt');
		expect((await request('/lock-coll', { method: 'DELETE' })).status).toBe(423);
		expect(tb.find('/lock-coll/child.txt')).toBeDefined();
		const ok = await request('/lock-coll', {
			method: 'DELETE',
			headers: { If: `<${ORIGIN}/lock-coll/child.txt> (${token})` },
		});
		expect(ok.status).toBe(204);
		expect(tb.find('/lock-coll/child.txt')).toBeUndefined();
	});

	it('MOVE of a collection requires the token of a locked member', async () => {
		tb.seed('/lock-src', { isdir: 1 });
		tb.seed('/lock-src/child.txt', { content: 'locked child' });
		const token = await lockPath('/lock-src/child.txt');
		const dest = `${ORIGIN}/lock-moved`;
		expect(
			(await request('/lock-src', { method: 'MOVE', headers: { Destination: dest } })).status,
		).toBe(423);
		expect(tb.find('/lock-src/child.txt')).toBeDefined();
		expect(tb.find('/lock-moved/child.txt')).toBeUndefined();
		const ok = await request('/lock-src', {
			method: 'MOVE',
			headers: {
				Destination: dest,
				If: `<${ORIGIN}/lock-src/child.txt> (${token})`,
			},
		});
		expect(ok.status).toBe(201);
		expect(tb.find('/lock-moved/child.txt')).toBeDefined();
	});

	it('COPY over a collection requires the token of a locked destination member', async () => {
		tb.seed('/lock-source', { isdir: 1 });
		tb.seed('/lock-source/a.txt', { content: 'src' });
		tb.seed('/lock-dest', { isdir: 1 });
		tb.seed('/lock-dest/child.txt', { content: 'must survive' });
		const token = await lockPath('/lock-dest/child.txt');
		const dest = `${ORIGIN}/lock-dest`;
		expect(
			(await request('/lock-source', { method: 'COPY', headers: { Destination: dest } })).status,
		).toBe(423);
		expect(tb.find('/lock-dest/child.txt')).toBeDefined();
		const ok = await request('/lock-source', {
			method: 'COPY',
			headers: {
				Destination: dest,
				If: `<${ORIGIN}/lock-dest/child.txt> (${token})`,
			},
		});
		expect(ok.status).toBe(204);
	});
});
