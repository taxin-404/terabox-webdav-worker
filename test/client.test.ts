import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TeraboxClient, resetTeraboxCaches } from '../src/terabox';

// Unit tests for TeraboxClient request-layer behavior that the worker-level
// suite cannot reach: the -6 re-root recursion bound (review H1) and the
// jsToken cache/configured-token precedence (review M2). Global fetch is
// stubbed exactly the way test/helpers.ts installMock does it.

const BASE = 'https://terabox.com';
const JPBASE = 'https://jp.terabox.com';

const tokenHtml = (token: string): string =>
  '<html><script>`function%20fn%28a%29%7Bwindow.jsToken%20%3D%20a%7D%3Bfn%28%22' +
  token +
  '%22%29`</script></html>';

const errnoResponse = (errno: number, prefix?: string): Response =>
  new Response(JSON.stringify({ errno }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      ...(prefix ? { 'Url-Domain-Prefix': prefix } : {}),
    },
  });

beforeEach(() => {
  resetTeraboxCaches();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('-6 re-root is bounded (review H1)', () => {
	// The stubs degrade to a prefix-less -6 after a couple of calls so the
	// UNFIXED code fails the assertions (extra calls) instead of spinning
	// forever — the pin must never hang the suite.
	it('refuses a no-op re-root naming the host it is already on', async () => {
		const calls: string[] = [];
		vi.stubGlobal('fetch', async (input: unknown) => {
			const withPrefix = calls.length < 1;
			calls.push(String(input));
			return errnoResponse(-6, withPrefix ? 'jp' : undefined);
		});
		const client = new TeraboxClient('ndus=x', JPBASE, { minGapMs: 0 });
		await expect(client.quota()).rejects.toMatchObject({ errno: -6 });
		// Same host as baseUrl → refuse the no-op re-root outright (the old
		// code re-entered request() unconditionally and re-rooted forever).
		expect(calls.length).toBe(1);
	});

	it('re-roots at most once when the prefix names a different host', async () => {
		const calls: string[] = [];
		vi.stubGlobal('fetch', async (input: unknown) => {
			const withPrefix = calls.length < 2;
			calls.push(String(input));
			return errnoResponse(-6, withPrefix ? 'jp' : undefined);
		});
		const client = new TeraboxClient('ndus=x', BASE, { minGapMs: 0 });
		await expect(client.quota()).rejects.toMatchObject({ errno: -6 });
		// One genuine re-root (terabox.com → jp.terabox.com), then the latch
		// refuses a second: exactly two upstream calls, then a clean errno.
		expect(calls.length).toBe(2);
		expect(calls[1]).toContain('jp.terabox.com');
	});

	it('a -6 without a prefix header fails fast without recursing', async () => {
		let calls = 0;
		vi.stubGlobal('fetch', async () => {
			calls += 1;
			return errnoResponse(-6);
		});
		const client = new TeraboxClient('ndus=x', BASE, { minGapMs: 0 });
		await expect(client.quota()).rejects.toMatchObject({ errno: -6 });
		expect(calls).toBe(1);
	});
});

describe('jsToken cache precedence and mint dedup (review M2)', () => {
	it('prefers a freshly minted cached token over a stale configured one', async () => {
		vi.stubGlobal('fetch', async () => new Response(tokenHtml('fresh-token-abc'), { status: 200 }));
		const first = new TeraboxClient('ndus=x', BASE, { minGapMs: 0 });
		await (first as never as { ensureJsToken(force?: boolean): Promise<void> }).ensureJsToken(true);
		expect((first as never as { jsToken: string }).jsToken).toBe('fresh-token-abc');

		const second = new TeraboxClient('ndus=x', BASE, {
			jsToken: 'stale-env-token',
			minGapMs: 0,
		});
		await (second as never as { ensureJsToken(force?: boolean): Promise<void> }).ensureJsToken();
		// Old order: configured env token won forever → every write repeated
		// reject → force-mint → retry even with a valid token cached.
		expect((second as never as { jsToken: string }).jsToken).toBe('fresh-token-abc');
	});

	it('still uses the configured token while the cache is cold', async () => {
		const client = new TeraboxClient('ndus=x', BASE, { jsToken: 'cold-env-token', minGapMs: 0 });
		await (client as never as { ensureJsToken(force?: boolean): Promise<void> }).ensureJsToken();
		expect((client as never as { jsToken: string }).jsToken).toBe('cold-env-token');
	});

	it('shares one in-flight mint across concurrent force callers', async () => {
		let mintFetches = 0;
		vi.stubGlobal('fetch', async () => {
			mintFetches += 1;
			return new Response(tokenHtml('shared-token'), { status: 200 });
		});
		const a = new TeraboxClient('ndus=x', BASE, { minGapMs: 0 });
		const b = new TeraboxClient('ndus=x', BASE, { minGapMs: 0 });
		await Promise.all([
			(a as never as { ensureJsToken(force?: boolean): Promise<void> }).ensureJsToken(true),
			(b as never as { ensureJsToken(force?: boolean): Promise<void> }).ensureJsToken(true),
		]);
		expect(mintFetches).toBe(1);
		expect((a as never as { jsToken: string }).jsToken).toBe('shared-token');
		expect((b as never as { jsToken: string }).jsToken).toBe('shared-token');
	});
});

describe('upstream network failures stay TeraboxErrors (lockbomb 500 fix)', () => {
	// Root cause of the litmus lockbomb "500 Internal Server Error": under
	// load a JS-token errno triggers a force-mint, and fetchMintPage's raw
	// fetch()/text() threw a plain TypeError that escaped every wrapper —
	// index.ts's non-TeraboxError branch answered a generic 500. Every
	// other fetch site already wraps as TeraboxError(-5) → 502.
	it('wraps a mint-page network failure as TeraboxError -5, never a raw throw', async () => {
		vi.stubGlobal('fetch', async () => {
			throw new TypeError('fetch failed');
		});
		const client = new TeraboxClient('ndus=x', BASE, { minGapMs: 0 });
		await expect(
			(client as never as { ensureJsToken(force?: boolean): Promise<void> }).ensureJsToken(true),
		).rejects.toMatchObject({ errno: -5 });
	});

	// The 60 s handlers behind litmus's "connection timed out": no fetch
	// carried an AbortSignal, so a hung upstream held the request until the
	// edge cut the client's connection. Bodiless calls are bounded; a
	// multipart upload body must NOT get the signal (a slow 16 MB chunk
	// would abort mid-transfer).
	it('passes an abort signal on bodiless API fetches', async () => {
		const signals: Array<AbortSignal | undefined> = [];
		vi.stubGlobal('fetch', async (_input: unknown, init?: { signal?: AbortSignal }) => {
			signals.push(init?.signal);
			return new Response(JSON.stringify({ errno: 0 }), { status: 200 });
		});
		const client = new TeraboxClient('ndus=x', BASE, { minGapMs: 0 });
		await client.quota();
		expect(signals.length).toBeGreaterThan(0);
		expect(signals[0]).toBeInstanceOf(AbortSignal);
	});

	it('omits the abort signal when a request carries an upload body', async () => {
		const signals: Array<{ signal?: AbortSignal } | undefined> = [];
		vi.stubGlobal('fetch', async (_input: unknown, init?: { signal?: AbortSignal }) => {
			signals.push(init);
			return new Response(JSON.stringify({ errno: 0 }), { status: 200 });
		});
		const client = new TeraboxClient('ndus=x', BASE, { minGapMs: 0 });
		await (client as never as {
			request<T>(path: string, opts?: Record<string, unknown>): Promise<T>;
		}).request('/api/create', { method: 'POST', body: 'x=1' });
		expect(signals.length).toBeGreaterThan(0);
		expect(signals[0]?.signal).toBeUndefined();
	});

	it('passes an abort signal on the mint page fetch', async () => {
		const signals: Array<AbortSignal | undefined> = [];
		vi.stubGlobal('fetch', async (_input: unknown, init?: { signal?: AbortSignal }) => {
			signals.push(init?.signal);
			return new Response(tokenHtml('timeout-token'), { status: 200 });
		});
		const client = new TeraboxClient('ndus=x', BASE, { minGapMs: 0 });
		await (client as never as { ensureJsToken(force?: boolean): Promise<void> }).ensureJsToken(true);
		expect(signals.length).toBeGreaterThan(0);
		expect(signals[0]).toBeInstanceOf(AbortSignal);
	});
});

describe('fetchDownload resolved URLs (download-URL cache path)', () => {
	it('fetches a resolved URL verbatim — no browser rewrite, and reports the final URL', async () => {
		// The cache stores the final post-302 capability URL: re-running the
		// browser /file/ host rewrite on it would send the fetch somewhere the
		// bytes never came from, so the resolved flag must bypass it. The
		// URL is direct-200 (never hopped), so the session still rides along.
		const seen: string[] = [];
		vi.stubGlobal('fetch', async (input: unknown) => {
			seen.push(String(input));
			return new Response('bytes', { status: 200 });
		});
		const client = new TeraboxClient('ndus=x', BASE, { minGapMs: 0 });
		const { response, finalUrl } = await client.fetchDownload(
			'https://d.mock.terabox.com/file/abc',
			undefined,
			{ resolved: true, cookieless: false },
		);
		expect(seen[0]).toBe('https://d.mock.terabox.com/file/abc');
		expect(finalUrl).toBe('https://d.mock.terabox.com/file/abc');
		expect(response.status).toBe(200);
	});
});

describe('account-wide slot reserver (pace hook)', () => {
	it('takes the reserver before the download fetch', async () => {
		const order: string[] = [];
		vi.stubGlobal('fetch', async () => {
			order.push('fetch');
			return new Response('bytes', { status: 200 });
		});
		const client = new TeraboxClient('ndus=x', BASE, { minGapMs: 0 });
		client.apiSlotReserver = async () => {
			order.push('reserver');
			return 0;
		};
		const { response } = await client.fetchDownload('https://cdn.example/file/x');
		expect(response.status).toBe(200);
		expect(order).toEqual(['reserver', 'fetch']);
	});

	it('falls back to isolate-local pacing when the reserver fails, without retry-storming', async () => {
		const order: string[] = [];
		let calls = 0;
		vi.stubGlobal('fetch', async () => {
			order.push('fetch');
			return new Response('bytes', { status: 200 });
		});
		const client = new TeraboxClient('ndus=x', BASE, { minGapMs: 0 });
		client.apiSlotReserver = async () => {
			calls++;
			order.push('reserver');
			throw new Error('dav-state down');
		};
		const { response } = await client.fetchDownload('https://cdn.example/file/x');
		expect(response.status).toBe(200);
		expect(order[0]).toBe('reserver');
		expect(calls).toBe(1);
		// Cooldown: a sick DO costs one failure per window, not one per call.
		await client.pace();
		expect(calls).toBe(1);
	});
});

describe('resolved fetches: credential boundary + header bound (reviews R14/R15)', () => {
	it('omits Cookie/Referer on a post-hop capability replay, keeps them on every credentialed path', async () => {
		// The session cookie only ever crosses to API origins: the hop loop's
		// UA-only headers are the documented shape. A cached post-302 URL
		// lives on the CDN host, so replaying it with the cookie would leak
		// the session off-origin — while a cached URL that never hopped (or
		// the ladder's own first fetch) still NEEDS the cookie or the gate 403s.
		const seen: Array<{ url: string; cookie: string | null; referer: string | null; ua: string | null }> = [];
		vi.stubGlobal('fetch', async (input: unknown, init?: { headers?: Record<string, string> }) => {
			seen.push({
				url: String(input),
				cookie: init?.headers?.['Cookie'] ?? null,
				referer: init?.headers?.['Referer'] ?? null,
				ua: init?.headers?.['User-Agent'] ?? null,
			});
			return new Response('bytes', { status: 200 });
		});
		const client = new TeraboxClient('ndus=secret', BASE, { minGapMs: 0 });

		// (A) cookieless capability URL (post-302 CDN hop): no credentials.
		await client.fetchDownload('https://kul-cdn.example/file/real', null, {
			resolved: true,
			cookieless: true,
		});
		expect(seen[0]!.cookie).toBeNull();
		expect(seen[0]!.referer).toBeNull();
		expect(seen[0]!.ua).toBeTruthy();

		// (B) a resolved URL that never hopped still answers only to the session.
		await client.fetchDownload('https://dm.terabox.com/file/abc', null, {
			resolved: true,
			cookieless: false,
		});
		expect(seen[1]!.cookie).toContain('ndus=secret');
		expect(seen[1]!.referer).toBe(BASE);

		// (C) the ladder's first fetch keeps its credentials (no over-correction).
		await client.fetchDownload('https://dm.terabox.com/file/abc');
		expect(seen[2]!.cookie).toContain('ndus=secret');
	});

	it('makes no jsToken remedy attempt for a resolved replay — one fetch, then the ladder owns recovery', async () => {
		// A resolved URL is a post-verification artifact: re-walking the ladder
		// is the correct remedy for a gate, not a token mint against a URL that
		// was minted under a previous token.
		let calls = 0;
		vi.stubGlobal('fetch', async () => {
			calls++;
			return new Response(JSON.stringify({ request_id: 'r1', errno: 400141, errmsg: 'need verify' }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			});
		});
		const client = new TeraboxClient('ndus=x', BASE, { minGapMs: 0 });
		await expect(
			client.fetchDownload('https://kul-cdn.example/file/real', null, { resolved: true, cookieless: true }),
		).rejects.toThrow();
		expect(calls).toBe(1);
	});

	it('bounds the header phase of a resolved replay so a hanging URL aborts into the ladder (review R14 #2)', async () => {
		// A cached URL that accept-then-hangs must not stick for the cache TTL:
		// there is no retry left once the cache exists. The timer covers only
		// the header phase — it clears before the body is read, so a healthy
		// 70 MB stream is never raced against it.
		let capturedSignal: AbortSignal | undefined;
		vi.stubGlobal('fetch', async (_input: unknown, init?: { signal?: AbortSignal | null }) => {
			capturedSignal = init?.signal ?? undefined;
			return new Promise<Response>((_resolve, reject) => {
				const signal = init?.signal;
				if (!signal) return; // never settles — the assertion below fails first
				signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
			});
		});
		const client = new TeraboxClient('ndus=x', BASE, { minGapMs: 0 });
		const pending = client.fetchDownload('https://kul-cdn.example/file/hang', null, {
			resolved: true,
			cookieless: true,
			headerTimeoutMs: 50,
		});
		await new Promise((r) => setTimeout(r, 10));
		expect(capturedSignal).toBeInstanceOf(AbortSignal);
		await expect(pending).rejects.toThrow();
	});

	it('disarms the header timer — no bound timer survives a completed resolved fetch (round-15 #3)', async () => {
		// The bound covers ONLY the header phase: the timer must be cleared
		// in `finally` the moment fetchDownload returns. Pinned with fake
		// timers + getTimerCount because workerd does NOT error an
		// already-resolved body when a late abort fires (verified), so the
		// observable regression is the zombie timer itself — a future
		// runtime change wiring abort → body would then be caught by the
		// contract this keeps true: headers phase bounded, body never raced.
		vi.useFakeTimers();
		try {
			vi.stubGlobal('fetch', async () => new Response('bytes', { status: 200 }));
			const client = new TeraboxClient('ndus=x', BASE, { minGapMs: 0 });
			const { response } = await client.fetchDownload('https://kul-cdn.example/file/ok', null, {
				resolved: true,
				cookieless: true,
				headerTimeoutMs: 15_000,
			});
			expect(vi.getTimerCount()).toBe(0);
			await expect(response.text()).resolves.toBe('bytes');
		} finally {
			vi.useRealTimers();
		}
	});
});

describe('round 17 pins: upstream JSON and 64-bit ids', () => {
	it('inspects info[].errno even when filemanager returns a taskid', async () => {
		const { MockTerabox, installMock } = await import('./helpers');
		const tb = new MockTerabox();
		tb.seed('/src.txt', { content: 'x' });
		tb.seed('/dst.txt', { content: 'y' });
		tb.filemanagerTaskid = 7;
		tb.filemanagerReportedErrno = -9;
		installMock(tb);
		const client = new TeraboxClient('ndus=x', 'https://mock.terabox.example', { minGapMs: 0 });
		await expect(
			client.fileOperation('move', [{ path: '/src.txt', dest: '/dst.txt' }]),
		).rejects.toMatchObject({ errno: -9 });
	});

	it('keeps a 64-bit fs_id outside the safe-integer range verbatim', async () => {
		const { MockTerabox, installMock } = await import('./helpers');
		const tb = new MockTerabox();
		tb.seed('/big.bin', { content: 'x', fs_id: '9007199254740993' });
		installMock(tb);
		const client = new TeraboxClient('ndus=x', 'https://mock.terabox.example', { minGapMs: 0 });
		const url = await client.downloadLink('9007199254740993');
		expect(url).toContain('via=official');
		expect(tb.downloadFidlists.at(-1)).toEqual(['9007199254740993']);
	});
});
