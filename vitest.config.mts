import { defineConfig } from 'vitest/config';
import { readFileSync } from 'node:fs';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';

// Tests must exercise the same runtime semantics as production deploys, so
// the date is read from wrangler.toml rather than duplicated (the pair had
// been pinned to a 22-month-old runtime). A malformed/absent value throws
// here — the suite can never silently test an older runtime than the one
// deployed.
const wranglerToml = readFileSync(new URL('./wrangler.toml', import.meta.url), 'utf8');
const dateMatch = /^\s*compatibility_date\s*=\s*"([^"]+)"\s*$/m.exec(wranglerToml);
if (!dateMatch) throw new Error('wrangler.toml is missing compatibility_date');
const compat = {
	compatibilityDate: dateMatch[1]!,
};

const davBindings = {
	// Second credential is non-ASCII: locks in RFC 7617 UTF-8 decoding of
	// the Basic header (see validBasicAuth — a latin1 atob can never match
	// a multi-byte password).
	USERS: 'test:pass,üser:pässword',
	COOKIE: 'ndus=mock-session-cookie; lang=en',
	TERABOX_DOMAIN: 'https://mock.terabox.example',
	// Rate pacing is exercised live; tests must not sleep.
	MIN_GAP_MS: '0',
};

export default defineConfig({
	test: {
		projects: [
			{
				plugins: [
					cloudflareTest({
						main: 'src/index.ts',
						miniflare: { ...compat, bindings: davBindings },
					}),
				],
				test: { name: 'dav', include: ['test/dav.test.ts', 'test/md5.test.ts', 'test/dlink.test.ts', 'test/client.test.ts', 'test/viewer.test.ts'] },
			},
			{
				plugins: [
					cloudflareTest({
						main: 'src/index.ts',
						miniflare: {
							...compat,
							bindings: { ...davBindings, PATH: '/dav', ROOT_ID: '/sub' },
						},
					}),
				],
				test: { name: 'mount', include: ['test/mount.test.ts'] },
			},
			{
				// Non-ASCII PATH: routing must percent-encode the base exactly
				// like the URL parser encodes request pathnames, or every
				// request on such a mount 404s (round-9 F8).
				plugins: [
					cloudflareTest({
						main: 'src/index.ts',
						miniflare: {
							...compat,
							bindings: { ...davBindings, PATH: '/döc' },
						},
					}),
				],
				test: { name: 'mount-utf8', include: ['test/mount-utf8.test.ts'] },
			},
			{
				plugins: [
					cloudflareTest({
						main: 'src/index.ts',
						miniflare: { ...compat },
					}),
				],
				test: { name: 'auth', include: ['test/auth.test.ts'] },
			},
			{
				// Same surface as `dav`, but with the DAV_STATE Durable Object
				// bound: locks and dead props flow through RemoteDavStore →
				// DavState.fetch, the deployment's real advisory-state path.
				plugins: [
					cloudflareTest({
						main: 'src/index.ts',
						miniflare: {
							...compat,
							bindings: davBindings,
							durableObjects: { DAV_STATE: { className: 'DavState' } },
						},
					}),
				],
				test: { name: 'davstate', include: ['test/davstate.test.ts'] },
			},
		],
	},
});