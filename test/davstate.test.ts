import { env, SELF, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	createDavStore,
	DavLimitError,
	DO_NAME,
	MAX_LOCK_OWNER_BYTES,
	MAX_LOCK_PATHS,
	MemoryDavStore,
	UPLOAD_FINALIZED_GRACE_MS,
	UPLOAD_SESSION_TTL_MS,
} from '../src/davstate';
import { resetDavVolatileState } from '../src/webdav';
import { resetTeraboxCaches } from '../src/terabox';
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
	// the pool's storage snapshots. Terabox module caches are isolate-global.
	resetDavVolatileState();
	resetTeraboxCaches();
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
	it('re-arms the sweep when finalize moves the expiry to +grace', async () => {
		const tag = crypto.randomUUID().slice(0, 8);
		const target = `/r8-fin-${tag}.txt`;
		const data = new Uint8Array(5).fill(9);
		const begin = await request('/.resumable', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ path: target, size: data.byteLength }),
		});
		expect(begin.status).toBe(200);
		const { uploadId, chunkCount } = (await begin.json()) as { uploadId: string; chunkCount: number };
		expect(chunkCount).toBe(1);
		const put = await request(`/.resumable/${uploadId}/0`, { method: 'PUT', body: data });
		expect(put.status).toBe(200);
		const fin = await request(`/.resumable/${uploadId}/finalize`, { method: 'POST' });
		expect(fin.status).toBe(201);
		const t0 = Date.now();
		// Pre-fix the alarm still pointed at the session's original 24h TTL
		// (or whatever an earlier state change armed): the finalized record
		// lingered in DO storage for up to a day past its 10-minute grace.
		// cloudflare:test's `env` type omits the DO binding (the src Env
		// declares it optional); this project's config binds it.
		const ns = (env as unknown as { DAV_STATE: DurableObjectNamespace }).DAV_STATE;
		const stub = ns.get(ns.idFromName(DO_NAME));
		const alarm = await runInDurableObject(stub, async (_instance, state) => state.storage.getAlarm());
		expect(alarm).not.toBeNull();
		expect(alarm!).toBeLessThanOrEqual(t0 + UPLOAD_FINALIZED_GRACE_MS + 10_000);
	});

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

	it('serializes concurrent finalize POSTs through the DO: one create, both 201', async () => {
		// RemoteDavStore.claimFinalize → DavState `/upload-claim` is the
		// production path for the atomic claim; a wrong route name or a
		// non-atomic read-modify-write would show up here as a second create.
		const racePath = `/do-race-${crypto.randomUUID().slice(0, 8)}.txt`;
		const data = new Uint8Array(64).fill(5);
		const begin = await request('/.resumable', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ path: racePath, size: data.byteLength }),
		});
		expect(begin.status).toBe(200);
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
		expect(tb.createCalls - before).toBe(1);
	}, 30000);

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

describe('upload session retention', () => {
	// Unit-level: MemoryDavStore owns the expiry rules, and time is seeded by
	// writing past timestamps into the session rather than faking timers
	// (fake timers do not run inside the workerd test pool).
	const baseSession = {
		path: '/x.bin',
		size: 4,
		mtimeMs: 0,
		uploadId: 'u1',
		uploadSign: 's',
		chunkSize: 4,
		chunkCount: 1,
		chunkMd5s: ['a'] as Array<string | null>,
		hosts: ['h'],
		overwriteMode: 0,
	};

	it('keeps a finalized session for the retry grace window', async () => {
		const store = new MemoryDavStore();
		await store.init({ ...baseSession, createdAt: Date.now(), finalized: 201, finalizedAt: Date.now() - 60_000 });
		const got = await store.get('u1');
		expect(got?.finalized).toBe(201);
	});

	it('drops a finalized session once the grace window lapses', async () => {
		const store = new MemoryDavStore();
		await store.init({
			...baseSession,
			createdAt: Date.now() - 60 * 60_000,
			finalized: 201,
			finalizedAt: Date.now() - UPLOAD_FINALIZED_GRACE_MS - 1000,
		});
		expect(await store.get('u1')).toBeUndefined();
	});

	it('claims finalize once, replays after marking, and rejects a rival claim', async () => {
		const store = new MemoryDavStore();
		await store.init({ ...baseSession, createdAt: Date.now() });
		expect(await store.claimFinalize('u1')).toEqual({ kind: 'owned' });
		expect(await store.claimFinalize('u1')).toEqual({ kind: 'busy' });
		expect(await store.claimFinalize('missing')).toEqual({ kind: 'unknown' });
		await store.markFinalized('u1', 201);
		expect(await store.claimFinalize('u1')).toEqual({ kind: 'replay', status: 201 });
	});

	it('releases a failed claim so the next attempt can take it', async () => {
		const store = new MemoryDavStore();
		await store.init({ ...baseSession, createdAt: Date.now() });
		expect(await store.claimFinalize('u1')).toEqual({ kind: 'owned' });
		await store.releaseFinalize('u1');
		expect(await store.claimFinalize('u1')).toEqual({ kind: 'owned' });
	});

	it('keeps an unfinished session up to the full TTL', async () => {
		const store = new MemoryDavStore();
		await store.init({ ...baseSession, createdAt: Date.now() - UPLOAD_SESSION_TTL_MS + 60_000 });
		expect(await store.get('u1')).toBeDefined();
		await store.init({ ...baseSession, uploadId: 'u2', createdAt: Date.now() - UPLOAD_SESSION_TTL_MS - 1000 });
		expect(await store.get('u2')).toBeUndefined();
	});
});

describe('metadata generation (cross-isolate cache invalidation)', () => {
	it('bumps the shared generation on every write', async () => {
		// The read-side metadata cache lives per isolate; without this shared
		// counter a write in one isolate would leave the others serving stale
		// size/etag/dlink for the full TTL.
		const store = createDavStore(env);
		const before = await store.metaGeneration(false);
		const res = await request(`/gen-${crypto.randomUUID().slice(0, 8)}.txt`, {
			method: 'PUT',
			body: 'fresh',
		});
		expect(res.status).toBe(201);
		const after = await store.metaGeneration(false);
		expect(after).toBeGreaterThan(before);
	});

	it('reads the current generation without bumping it', async () => {
		const store = createDavStore(env);
		const first = await store.metaGeneration(false);
		const second = await store.metaGeneration(false);
		expect(second).toBe(first);
	});

	it('tracks a generation in the per-isolate memory fallback', async () => {
		const store = new MemoryDavStore();
		expect(await store.metaGeneration(false)).toBe(0);
		expect(await store.metaGeneration(true)).toBe(1);
		expect(await store.metaGeneration(false)).toBe(1);
	});

	it('rejects a well-formed never-issued token on the DO path (no volatile grace)', async () => {
		const target = `/do-strict-${crypto.randomUUID().slice(0, 8)}.txt`;
		tb.seed(target, { content: 'strict path\n' });
		// The memory fallback documents a self-issued-token grace for its
		// per-isolate records; the DO is the durable source of truth and must
		// not extend that grace to a shape-correct forgery. With the token
		// properly submitted (`<…>`, RFC 4918 §10.4.1) the condition fails
		// as an invalid lock-token: 412. Pre-fix the strict route admitted
		// it via the volatile grace and the write simply proceeded (2xx).
		const forged = `opaquelocktoken:${crypto.randomUUID()}:${Date.now() + 3600000}`;
		const put = await request(target, {
			method: 'PUT',
			headers: { If: `(<${forged}>)` },
			body: 'forged grant',
		});
		expect(put.status).toBe(412);
	});

	it('refuses a create whose If condition is false instead of adopting a forged token', async () => {
		const target = `/do-adopt-${crypto.randomUUID().slice(0, 8)}.txt`;
		tb.seed(target, { content: 'adoption path\n' });
		const forged = `opaquelocktoken:${crypto.randomUUID()}:${Date.now() + 3600000}`;
		// §6.5: lock tokens are capabilities, not client-chosen names. The
		// body-carrying LOCK's If (`(<forged>)`) is a FALSE condition — the
		// forged token locks nothing — so round 11 evaluates create-LOCK If
		// truth like every other mutating method: 412, no lock minted,
		// nothing adopted. (Rounds 9-10 ignored the condition and answered
		// 200 with a server-minted token.)
		const lock = await request(target, {
			method: 'LOCK',
			headers: { 'Content-Type': 'application/xml', If: `(<${forged}>)` },
			body: LOCK_BODY,
		});
		expect(lock.status).toBe(412);
		// Nothing was created from the false condition: a clean LOCK still
		// succeeds and the token it grants is the server's own.
		const fresh = await request(target, {
			method: 'LOCK',
			headers: { 'Content-Type': 'application/xml' },
			body: LOCK_BODY,
		});
		expect(fresh.status).toBe(200);
		const minted = fresh.headers.get('Lock-Token')!;
		expect(minted.slice(1, -1)).not.toBe(forged);
	});

	it('answers 507 for a dead-property write past the caps over the DO route', async () => {
		const target = `/do-cap-${crypto.randomUUID().slice(0, 8)}.txt`;
		tb.seed(target, { content: 'cap path\n' });
		const big = 'y'.repeat(40000);
		const res = await request(target, {
			method: 'PROPPATCH',
			headers: { 'Content-Type': 'application/xml' },
			body:
				'<D:propertyupdate xmlns:D="DAV:"><D:set><D:prop>' +
				`<X:big xmlns:X="urn:x">${big}</X:big>` +
				'</D:prop></D:set></D:propertyupdate>',
		});
		expect(res.status).toBe(507);
	});
});

describe('round 8 pins: If Resource-Tags, negation, sweep, caps', () => {
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
		// Pre-fix every list was judged against the Request-URI, so Td
		// "failed" on the (unlocked) source and the header answered 412 —
		// the only RFC- sanctioned way to overwrite a locked destination
		// was unreachable.
		const tag = crypto.randomUUID().slice(0, 8);
		const srcPath = `/r8-cp-src-${tag}.txt`;
		const destPath = `/r8-cp-dest-${tag}.txt`;
		tb.seed(srcPath, { content: 'copy me\n' });
		tb.seed(destPath, { content: 'locked dest\n' });
		const token = await lock(destPath);
		const copy = await request(srcPath, {
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
		const srcPath = `/r8-mv-src-${tag}.txt`;
		const destPath = `/r8-mv-dest-${tag}.txt`;
		tb.seed(srcPath, { content: 'move me\n' });
		tb.seed(destPath, { content: 'locked dest\n' });
		const srcToken = await lock(srcPath);
		const destToken = await lock(destPath);
		const move = await request(srcPath, {
			method: 'MOVE',
			headers: {
				Destination: ORIGIN + destPath,
				If:
					`<${ORIGIN}${srcPath}> (${srcToken}) ` +
					`<${ORIGIN}${destPath}> (${destToken})`,
			},
		});
		expect(move.status).toBe(204);
	});

	it('rejects a tagged token that belongs to a different resource (§10.4.10)', async () => {
		// The tag says "evaluate this token against /somewhere-else", where
		// it applies to nothing → the list is false and the header has no
		// other list → 412. Pre-fix the token was judged against the
		// Request-URI, matched its own lock, and the DELETE sailed through.
		const tag = crypto.randomUUID().slice(0, 8);
		const srcPath = `/r8-foreign-${tag}.txt`;
		tb.seed(srcPath, { content: 'delete me\n' });
		const token = await lock(srcPath);
		const res = await request(srcPath, {
			method: 'DELETE',
			headers: { If: `<${ORIGIN}/r8-elsewhere-${tag}.txt> (${token})` },
		});
		expect(res.status).toBe(412);
	});

	it('treats `not` case-insensitively: (not <forged>) negates (ABNF §2.3)', async () => {
		const tag = crypto.randomUUID().slice(0, 8);
		const target = `/r8-not-${tag}.txt`;
		tb.seed(target, { content: 'unlocked\n' });
		const forged = `opaquelocktoken:${crypto.randomUUID()}:${Date.now() + 3600000}`;
		// Pre-fix `not` parsed as a positive term, the forgery was
		// "invalid", and the request died412 despite the negation making
		// the condition true.
		const put = await request(target, {
			method: 'PUT',
			headers: { If: `(not <${forged}>)` },
			body: 'negated',
		});
		expect(put.status).toBe(204);
	});

	it('lock path cap sweeps expired records before refusing (memory fallback)', async () => {
		const store = new MemoryDavStore();
		const req = { shared: false, depth: '0', owner: '', presented: [] };
		for (let i = 0; i < MAX_LOCK_PATHS; i += 1) {
			// seconds: 0 → expiresAt = now → already expired for the next
			// check, so the map fills with dead entries (the fallback has
			// no alarm to reap them).
			await store.lockAcquire(`/r8sweep-${i}.txt`, { ...req, seconds: 0 });
		}
		// Pre-fix this40th path hit `locks.size >= MAX_LOCK_PATHS` against
		// 4096 expired corpses and answered 507 forever. Post-fix the sweep
		// clears the dead entries — the one live lock below must survive.
		await store.lockAcquire('/r8sweep-live.txt', { ...req, seconds: 3600 });
		const after = await store.lockAcquire('/r8sweep-new.txt', { ...req, seconds: 3600 });
		expect(after.ok).toBe(true);
		const state = await store.describe(['/r8sweep-live.txt']);
		expect(state['/r8sweep-live.txt']!.locks).toHaveLength(1);
	});
});

describe('account-wide API pacing (pace → DavState /api-slot)', () => {
	it('offers an account-wide slot reservation on the remote store', async () => {
		const store = createDavStore(env);
		expect(typeof store.apiSlot).toBe('function');
		// The DO's nextApiSlot is in-memory (not storage-backed) and survives
		// sibling tests, so force a cold timeline first — only then is
		// "the first reservation is immediate" a deterministic assertion
		// instead of a stale-timeline flake, while the delta below still
		// proves serialisation regardless of timeline state.
		const ns = (env as unknown as { DAV_STATE: DurableObjectNamespace }).DAV_STATE;
		const stub = ns.get(ns.idFromName(DO_NAME));
		await runInDurableObject(stub, async (instance) => {
			const timeline = instance as unknown as { nextApiSlot: number };
			// Read-back first: if the field is ever renamed, this fails loudly
			// instead of writing a dead own-property that no-ops the reset.
			expect(typeof timeline.nextApiSlot).toBe('number');
			timeline.nextApiSlot = 0;
		});
		const first = await store.apiSlot!(200);
		const second = await store.apiSlot!(200);
		expect(first).toBeLessThan(50); // cold timeline: no gap charged up front
		expect(second - first).toBeGreaterThanOrEqual(100); // second queues a full gap behind the first
	});

	it('wires the reservation into every paced upstream call of a request', async () => {
		const stats = (await import('../src/terabox')).paceAccountReservations;
		expect(stats).toBeDefined();
		expect(stats!.count).toBe(0);
		const res = await request(srcPath);
		expect(res.status).toBe(200);
		expect(stats!.count).toBeGreaterThan(0);
	});
});

describe('round 17 pins: advisory-state byte caps', () => {
	it('refuses a lock owner above the byte cap before storing it', async () => {
		const store = new MemoryDavStore();
		await expect(
			store.lockAcquire('/owner-cap.txt', {
				shared: false,
				depth: '0',
				owner: 'x'.repeat(MAX_LOCK_OWNER_BYTES + 1),
				presented: [],
				seconds: 3600,
			}),
		).rejects.toBeInstanceOf(DavLimitError);
		const state = await store.describe(['/owner-cap.txt']);
		expect(state['/owner-cap.txt']!.locks).toHaveLength(0);
	});

	it('enforces the dead-property caps when a recursive COPY duplicates them', async () => {
		const store = new MemoryDavStore();
		const big = 'x'.repeat(30 * 1024);
		for (let i = 0; i < 10; i += 1) {
			await store.propPatch(`/src/f${i}`, [{ op: 'set', key: '{urn:x}p', markup: big }]);
		}
		await expect(
			store.relocate([{ src: '/src', dest: '/dst', mode: 'copy', recursive: true }]),
		).rejects.toBeInstanceOf(DavLimitError);
		// The rejected relocation must leave the source intact and publish nothing.
		const src = await store.describe(['/src/f0']);
		expect(src['/src/f0']!.props['{urn:x}p']).toBe(big);
		const dst = await store.describe(['/dst/f0']);
		expect(dst['/dst/f0']!.props).toEqual({});
	});
});
