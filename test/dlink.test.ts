import { describe, expect, it } from 'vitest';
import { browserDlinkUrl } from '../src/terabox';

// Parity with the web app's formatDownloadURL: the browser rewrites the
// dlink host before fetching, and the <prefix>-d gateway's /file/ path is
// what answers 400141 "need verify" from datacenter IPs.
describe('browserDlinkUrl (web-app formatDownloadURL parity)', () => {
	it('rewrites the <prefix>-d gateway to the main origin', () => {
		expect(browserDlinkUrl('https://dm-d.terabox.com/file/abc?x=1&y=2', 'dm.terabox.com')).toBe(
			'https://dm.terabox.com/file/abc?x=1&y=2',
		);
	});

	it('rewrites d.<host> to www.<host> on www pages', () => {
		expect(browserDlinkUrl('https://d.terabox.com/file/abc', 'www.terabox.com')).toBe(
			'https://www.terabox.com/file/abc',
		);
	});

	it('strips the d. label on non-www pages (app else-branch)', () => {
		expect(browserDlinkUrl('https://d.terabox.com/file/abc', 'dm.terabox.com')).toBe(
			'https://terabox.com/file/abc',
		);
	});

	it('leaves CDN hosts untouched', () => {
		expect(browserDlinkUrl('https://kul-ddata.terabox.com/file/abc?s=1', 'dm.terabox.com')).toBe(
			'https://kul-ddata.terabox.com/file/abc?s=1',
		);
	});

	it('leaves non-file paths and invalid input untouched', () => {
		expect(browserDlinkUrl('https://dm-d.terabox.com/other', 'dm.terabox.com')).toBe(
			'https://dm-d.terabox.com/other',
		);
		expect(browserDlinkUrl('not a url', 'dm.terabox.com')).toBe('not a url');
	});
});
