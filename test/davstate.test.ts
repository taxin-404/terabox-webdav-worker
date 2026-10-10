import { SELF } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDavVolatileState } from '../src/webdav';
import { AUTH, MockTerabox, ORIGIN, installMock } from './helpers';

// This vitest project binds DAV_STATE to the DavState Durable Object (see
// vitest.config.mts), so every lock/dead-prop operation flows through
// RemoteDavStore → DavState.fetch — the same serialized path the production
// deployment uses. The memory-store tests in dav.test.ts cover the fallback;
// this file proves the DO route end-to-end.

let tb: MockTerabox;
let srcPath: string;
let movedPath: string;
let propPath: string;

const request = (path: string, init: RequestInit = {}): Promise<Response> =>
	SELF.fetch(ORIGIN + path, {
		...init,
		headers: { ...AUTH, ...(init.headers as Record<string, string> | undefined) },
	});

const LOCK_BODY =
	'<D:lockinfo xmlns:D="DAV:"><D:lockscope><D:exclusive/></D:lockscope>' +
	'<D:locktype><D:write/></D:locktype><D:owner><D:href>do-tester</D:href></D:owner></D:lockinfo>';

beforeEach(() => {
	// Clears the per-isolate metaCache; DO storage is isolated per test by
	// the pool's storage snapshots.
	resetDavVolatileState();
	tb = new MockTerabox();
	// Fresh paths per test: the DavState DO caches locks/props in memory
	// (storage is only read at construction), so unique names keep cases
	// independent even if one fails mid-way and skips its cleanup.
	const tag = crypto.randomUUID().slice(0, 8);
	srcPath = `/do-a-${tag}.txt`;
	movedPath = `/do-moved-${tag}.txt`;
	propPath = `/do-b-${tag}.txt`;
	tb.seed(srcPath, { content: 'durable content\n' });
	tb.seed(propPath, { content: 'second file\n' });
	installMock(tb);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('DAV_STATE Durable Object', () => {
	it('enforces a lock across the DO round-trip: 423, then 204 with the token', async () => {
		const lock = await request(srcPath, {
			method: 'LOCK',
			headers: { 'Content-Type': 'application/xml' },
			body: LOCK_BODY,
		});
		expect(lock.status).toBe(200);
		const token = lock.headers.get('Lock-Token')!;
		expect(token).toContain('opaquelocktoken:');

		// The DO now holds the lock — an un-tokened write must be rejected.
		const blocked = await request(srcPath, { method: 'PUT', body: 'nope' });
		expect(blocked.status).toBe(423);

		// With the token the write proceeds.
		const allowed = await request(srcPath, {
			method: 'PUT',
			headers: { If: `(${token})` },
			body: 'written with token',
		});
		expect(allowed.status).toBe(204);

		const unlock = await request(srcPath, { method: 'UNLOCK', headers: { 'Lock-Token': token } });
		expect(unlock.status).toBe(204);

		const after = await request(srcPath, { method: 'PUT', body: 'unlocked write' });
		expect(after.status).toBe(204);
	});

	it('lockdiscovery through the DO reports the token and owner', async () => {
		const lock = await request(srcPath, {
			method: 'LOCK',
			headers: { 'Content-Type': 'application/xml' },
			body: LOCK_BODY,
		});
		const token = lock.headers.get('Lock-Token')!;
		const res = await request(srcPath, {
			method: 'PROPFIND',
			headers: { Depth: '0', 'Content-Type': 'application/xml' },
			body: '<D:propfind xmlns:D="DAV:"><D:prop><D:lockdiscovery/></D:prop></D:propfind>',
		});
		const body = await res.text();
		expect(body).toContain('<D:activelock>');
		expect(body).toContain('do-tester');
		expect(body).toContain(token.slice(1, -1));
	});

	it('stores dead properties in the DO and serves them back', async () => {
		const patch = await request(propPath, {
			method: 'PROPPATCH',
			headers: { 'Content-Type': 'application/xml' },
			body:
				'<D:propertyupdate xmlns:D="DAV:"><D:set><D:prop>' +
				'<X:tag xmlns:X="urn:x-example">do-value</X:tag></D:prop></D:set></D:propertyupdate>',
		});
		expect(patch.status).toBe(207);

		const res = await request(propPath, {
			method: 'PROPFIND',
			headers: { Depth: '0', 'Content-Type': 'application/xml' },
			body: '<D:propfind xmlns:D="DAV:"><D:prop><X:tag xmlns:X="urn:x-example"/></D:prop></D:propfind>',
		});
		const body = await res.text();
		expect(body).toContain('do-value');
		expect(body).toContain('HTTP/1.1 200 OK');
	});

	it('moves lock state with the resource on MOVE (withLocks)', async () => {
		const lock = await request(srcPath, {
			method: 'LOCK',
			headers: { 'Content-Type': 'application/xml' },
			body: LOCK_BODY,
		});
		const token = lock.headers.get('Lock-Token')!;

		const move = await request(srcPath, {
			method: 'MOVE',
			headers: { Destination: ORIGIN + movedPath, If: `(${token})` },
		});
		expect(move.status).toBe(201);

		// The lock followed the rename: the new path is locked (423) …
		const blocked = await request(movedPath, { method: 'PUT', body: 'nope' });
		expect(blocked.status).toBe(423);
		// … and the old path is free again.
		const freed = await request(srcPath, { method: 'PUT', body: 'fresh' });
		expect(freed.status).toBe(201);
	});

	it('rejects a foreign lock token with 423 through the DO', async () => {
		const lock = await request(srcPath, {
			method: 'LOCK',
			headers: { 'Content-Type': 'application/xml' },
			body: LOCK_BODY,
		});
		expect(lock.status).toBe(200);

		const res = await request(srcPath, {
			method: 'PUT',
			headers: { If: '<opaquelocktoken:00000000-0000-4000-8000-000000000000:1>' },
			body: 'forged',
		});
		expect(res.status).toBe(423);
	});
});
