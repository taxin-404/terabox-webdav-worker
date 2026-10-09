import { describe, expect, it } from 'vitest';
import { md5Hex } from '../src/md5';
import { decodeMD5 } from '../src/sign';

describe('md5', () => {
	const text = (s: string): Uint8Array => new TextEncoder().encode(s);

	it('matches RFC 1321 test vectors', () => {
		expect(md5Hex(new Uint8Array(0))).toBe('d41d8cd98f00b204e9800998ecf8427e');
		expect(md5Hex(text('abc'))).toBe('900150983cd24fb0d6963f7d28e17f72');
		expect(md5Hex(text('The quick brown fox jumps over the lazy dog'))).toBe('9e107d9d372bb6826bd81d3542a419d6');
		expect(md5Hex(text('message digest'))).toBe('f96b697d7cb7938d525a2f31aaf161d0');
	});

	it('handles multi-block inputs and 64-byte-aligned lengths', () => {
		const aligned = new Uint8Array(64).fill(0x61); // 64 x 'a'
		expect(md5Hex(aligned)).toBe('014842d480b571495a4a0363793f7367');
		const oneMore = new Uint8Array(65).fill(0x61); // 65 x 'a'
		expect(md5Hex(oneMore)).toBe('c743a45e0d2e6a95cb859adae0248435');
		const long = new Uint8Array(5000).fill(0x61); // 79 blocks
		expect(md5Hex(long)).toBe('7aaa7dec709fa4fa82f3746abfd80bdb');
	});
});

describe('decodeMD5', () => {
	it('round-trips the wrapper formula', () => {
		const real =
			'5d41402abc4b2a76b9719d911017c592';
		const enc = (m: string): string => {
			const n = m.slice(8, 16) + m.slice(0, 8) + m.slice(24, 32) + m.slice(16, 24);
			let out = '';
			for (let i = 0; i < n.length; i++) {
				const v = parseInt(n[i]!, 16) ^ (i & 15);
				out += i === 9 ? String.fromCharCode(103 + v) : v.toString(16);
			}
			return out;
		};
		expect(decodeMD5(enc(real))).toBe(real);
	});
});