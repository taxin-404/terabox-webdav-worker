import { SELF } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDavVolatileState } from '../src/webdav';
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
	// never leak locks or properties into each other.
	resetDavVolatileState();
	tb = new MockTerabox();
	seed(tb);
	installMock(tb);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('auth', () => {
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

	it('returns 405 for an existing resource', async () => {
		const res = await request('/a.txt', { method: 'MKCOL' });
		expect(res.status).toBe(405);
	});

	it('rejects creating the root', async () => {
		const res = await request('/', { method: 'MKCOL' });
		expect(res.status).toBe(403);
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

	it('reports the failing upload stage and errno in the error body', async () => {
		tb.precreateErrno = 4000023;
		const res = await request('/stuck.txt', { method: 'PUT', body: 'x' });
		expect(res.status).toBe(401);
		const body = (await res.json()) as { error: string; errno?: number; step?: string; upstream?: string };
		expect(body.errno).toBe(4000023);
		expect(body.step).toBe('precreate');
		expect(body.upstream).toBe('simulated verify required');
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
	it('MOVE to a new destination returns 201', async () => {
		const res = await request('/a.txt', {
			method: 'MOVE',
			headers: { Destination: ORIGIN + '/moved.txt' },
		});
		expect(res.status).toBe(201);
		expect(tb.find('/a.txt')).toBeUndefined();
		expect(tb.find('/moved.txt')?.size).toBe(tb.find('/moved.txt')?.size);
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
		expect(body).toContain('<D:owner><D:href>tester</D:href></D:owner>');
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
		expect(body).toContain('<D:owner><D:href>tester</D:href></D:owner>');
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
});
