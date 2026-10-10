import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';

// Match wrangler.toml's compatibility_date so tests exercise the same
// runtime semantics as production deploys.
const compat = {
	compatibilityDate: '2024-12-01',
};

const davBindings = {
	USERS: 'test:pass',
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
				test: { name: 'dav', include: ['test/dav.test.ts', 'test/md5.test.ts', 'test/dlink.test.ts'] },
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