import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { ORIGIN, basic } from './helpers';

// This project runs the worker WITHOUT USERS and COOKIE bindings. The server
// must fail closed: no credentials can ever reach the WebDAV surface.
describe('worker without USERS/COOKIE bindings', () => {
	it('refuses the webdav root with a 500', async () => {
		const res = await SELF.fetch(ORIGIN + '/');
		expect(res.status).toBe(500);
		expect(await res.text()).toContain('not configured');
	});

	it('rejects even valid-looking credentials', async () => {
		const res = await SELF.fetch(ORIGIN + '/', {
			headers: { Authorization: basic('test', 'pass') },
		});
		expect(res.status).toBe(500);
	});
});