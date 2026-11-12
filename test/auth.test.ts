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
import { cookieNames, parseCredentials } from '../src/index';
import { sign, valuedCookie } from '../src/sign';
import { sanitizeNext } from '../src/login';

describe('parseCredentials fails closed on a malformed USERS mapping', () => {
	it('accepts a well-formed comma-separated list', () => {
		expect(parseCredentials('test:pass,üser:pässword')).toHaveLength(2);
	});

	it.each([
		['comma inside a password (truncation)', 'bob:h,unter'],
		['colon-less entry (silent drop)', 'admin,alice:x'],
		['empty password', 'bob:'],
		['empty username', ':pass'],
		['mixed valid and invalid entries', ':pass,alice:x'],
		['duplicate usernames', 'a:x,a:y'],
	])('rejects a %s instead of weakening the credential', (_label, users) => {
		expect(parseCredentials(users)).toBeNull();
	});

	it('treats unset/blank USERS as invalid', () => {
		expect(parseCredentials(undefined)).toBeNull();
		expect(parseCredentials('')).toBeNull();
		expect(parseCredentials('   ')).toBeNull();
	});
});

describe('round 9 pins: cookie normalization and signing', () => {
	it('wraps a bare ndus value even when pasted with base64 padding', () => {
		expect(valuedCookie('BdSzXnAbC123==')).toBe('ndus=BdSzXnAbC123==; lang=en');
		expect(valuedCookie('plain-bare')).toBe('ndus=plain-bare; lang=en');
		expect(valuedCookie('ndus=padded==')).toBe('ndus=padded==');
		expect(valuedCookie('lang=en')).toBe('lang=en');
		expect(valuedCookie('ndus=a; lang=en')).toBe('ndus=a; lang=en');
	});

	it('sign() returns an empty signature for an empty key', () => {
		expect(sign('', 'payload')).toBe('');
		expect(sign('key', 'payload')).not.toBe('');
	});
});

describe('round 17 pins: cookie diagnostics never expose values', () => {
	it('reduces a bare ndus token to its cookie name', () => {
		expect(cookieNames('BdSzXnAbC123')).toEqual(['ndus']);
		expect(cookieNames('BdSzXnAbC123==')).toEqual(['ndus']);
	});

	it('lists names only for a full cookie jar', () => {
		expect(cookieNames('ndus=secret; lang=en; browserid=abc')).toEqual(['ndus', 'lang', 'browserid']);
	});

	it('handles an absent cookie', () => {
		expect(cookieNames(undefined)).toEqual([]);
	});
});

describe('round 17 pins: redirect targets', () => {
	it('rejects control characters that browsers strip into a scheme-relative URL', () => {
		expect(sanitizeNext('/\t/evil.com')).toBeNull();
		expect(sanitizeNext('/\n/evil.com')).toBeNull();
		expect(sanitizeNext('//evil.com')).toBeNull();
		expect(sanitizeNext('/dav/')).toBe('/dav/');
	});
});
