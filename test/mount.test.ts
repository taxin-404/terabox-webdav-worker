import { SELF } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AUTH, MockTerabox, ORIGIN, installMock } from './helpers';

// This vitest project deploys the worker with PATH="/dav" and ROOT_ID="/sub"
// (see vitest.config.mts): clients must live below /dav/ and see the Terabox
// folder /sub mounted as their root.

let tb: MockTerabox;

const request = (path: string, init: RequestInit = {}): Promise<Response> =>
	SELF.fetch(ORIGIN + path, {
		...init,
		// The 301 checks need the raw status; everything else ignores it.
		redirect: 'manual',
		headers: { ...AUTH, ...(init.headers as Record<string, string> | undefined) },
	});

beforeEach(() => {
	tb = new MockTerabox();
	tb.seed('/sub', { isdir: 1 });
	tb.seed('/sub/inside.txt', { content: 'inside data' });
	tb.seed('/sub/note & me.txt', { content: 'hostile name' });
	tb.seed('/top-level.txt', { content: 'outside the mount' });
	tb.seed('/other-dir', { isdir: 1 });
	tb.seed('/other-dir/x.txt', { content: 'outside the mount' });
	installMock(tb);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('base path (PATH=/dav)', () => {
	it('redirects the bare base path to its slash form', async () => {
		const res = await request('/dav');
		expect(res.status).toBe(301);
		expect(res.headers.get('Location')).toBe(ORIGIN + '/dav/');
	});

	it('404s requests outside the base path', async () => {
		expect((await request('/')).status).toBe(404);
		expect((await request('/top-level.txt')).status).toBe(404);
		// A sibling prefix ("/dave") is not under "/dav/".
		expect((await request('/dave/inside.txt')).status).toBe(404);
	});

	it('authenticates before revealing the path layout', async () => {
		const res = await SELF.fetch(ORIGIN + '/outside');
		expect(res.status).toBe(401);
	});

	it('OPTIONS and methods work under the base', async () => {
		const res = await request('/dav/', { method: 'OPTIONS' });
		expect(res.status).toBe(204);
		expect(res.headers.get('DAV')).toBe('1, 2');
	});
});

describe('mounted root (ROOT_ID=/sub)', () => {
	it('PROPFIND Depth 0 returns the mount root as /dav/', async () => {
		const res = await request('/dav/', { method: 'PROPFIND', headers: { Depth: '0' } });
		expect(res.status).toBe(207);
		const body = await res.text();
		expect(body).toContain('<D:href>/dav/</D:href>');
		expect(body).toContain('<D:collection/>');
	});

	it('PROPFIND Depth 1 lists only mounted children, with base-prefixed hrefs', async () => {
		const res = await request('/dav/', { method: 'PROPFIND', headers: { Depth: '1' } });
		expect(res.status).toBe(207);
		const body = await res.text();
		expect(body).toContain('<D:href>/dav/inside.txt</D:href>');
		expect(body).toContain('<D:href>/dav/note%20%26%20me.txt</D:href>');
		// Account-top entries and the mount root's own name must not leak.
		expect(body).not.toContain('top-level');
		expect(body).not.toContain('other-dir');
		expect(body).not.toContain('/sub');
	});

	it('GET serves files inside the mount', async () => {
		const res = await request('/dav/inside.txt');
		expect(res.status).toBe(200);
		expect(await res.text()).toBe('inside data');
	});

	it('404s paths that exist in the account but not under the root', async () => {
		expect((await request('/dav/top-level.txt')).status).toBe(404);
		expect((await request('/dav/other-dir/x.txt')).status).toBe(404);
		// Percent-encoded ".." must not escape the mount root either.
		expect((await request('/dav/%2E%2E/top-level.txt')).status).toBe(404);
	});

	it('PUTs land under the mount root', async () => {
		const res = await request('/dav/new.txt', { method: 'PUT', body: 'fresh' });
		expect(res.status).toBe(201);
		expect(tb.nodes.has('/sub/new.txt')).toBe(true);
		expect(tb.nodes.has('/new.txt')).toBe(false);
	});

	it('PUT creates missing parents under the mount root', async () => {
		const res = await request('/dav/deep/new.txt', { method: 'PUT', body: 'x' });
		expect(res.status).toBe(201);
		expect(tb.nodes.has('/sub/deep')).toBe(true);
		expect(tb.nodes.has('/sub/deep/new.txt')).toBe(true);
	});

	it('MKCOL creates folders inside the mount', async () => {
		const res = await request('/dav/folder', { method: 'MKCOL' });
		expect(res.status).toBe(201);
		expect(tb.nodes.has('/sub/folder')).toBe(true);
	});

	it('refuses mutations of the mount root itself with 403 (not 405)', async () => {
		expect((await request('/dav/', { method: 'MKCOL' })).status).toBe(403);
		expect((await request('/dav/', { method: 'DELETE' })).status).toBe(403);
		expect((await request('/dav/', { method: 'PUT', body: 'x' })).status).toBe(403);
		expect(tb.nodes.has('/sub')).toBe(true);
	});

	it('DELETE removes files inside the mount but keeps the root folder', async () => {
		const res = await request('/dav/inside.txt', { method: 'DELETE' });
		expect(res.status).toBe(204);
		expect(tb.nodes.has('/sub/inside.txt')).toBe(false);
		expect(tb.nodes.has('/sub')).toBe(true);
	});

	it('MOVE maps a base-prefixed Destination into the mount', async () => {
		tb.seed('/sub/a.txt', { content: 'AAA' });
		const res = await request('/dav/a.txt', {
			method: 'MOVE',
			headers: { Destination: ORIGIN + '/dav/b.txt' },
		});
		expect(res.status).toBe(201);
		expect(tb.nodes.has('/sub/b.txt')).toBe(true);
		expect(tb.nodes.has('/sub/a.txt')).toBe(false);
	});

	it('rejects a Destination outside the base path and leaves the source alone', async () => {
		tb.seed('/sub/a.txt', { content: 'AAA' });
		const res = await request('/dav/a.txt', {
			method: 'MOVE',
			headers: { Destination: ORIGIN + '/escaped.txt' },
		});
		expect(res.status).toBe(404);
		expect(tb.nodes.has('/sub/a.txt')).toBe(true);
		expect(tb.nodes.has('/escaped.txt')).toBe(false);
	});

	it('COPY keeps the source inside the mount', async () => {
		tb.seed('/sub/a.txt', { content: 'AAA' });
		const res = await request('/dav/a.txt', {
			method: 'COPY',
			headers: { Destination: ORIGIN + '/dav/c.txt' },
		});
		expect(res.status).toBe(201);
		expect(tb.nodes.has('/sub/a.txt')).toBe(true);
		expect(tb.nodes.has('/sub/c.txt')).toBe(true);
	});
});
