import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';

const compat = {
	compatibilityDate: '2026-04-15',
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
						miniflare: { ...compat },
					}),
				],
				test: { name: 'auth', include: ['test/auth.test.ts'] },
			},
		],
	},
});