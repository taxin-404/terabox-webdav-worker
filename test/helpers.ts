import { vi } from 'vitest';
import { md5Hex } from '../src/md5';

export const ORIGIN = 'https://webdav.example';
export const BASE = 'https://mock.terabox.example';
export const UPLOAD_BASE = 'https://mock-up.example';

export const basic = (username: string, password: string): string =>
	'Basic ' + btoa(`${username}:${password}`);

export const AUTH = { Authorization: basic('test', 'pass') };

export const TEXT = (s: string): Uint8Array => new TextEncoder().encode(s);

const json = (data: unknown, status = 200, headers: Record<string, string> = {}): Response =>
	new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...headers } });

/** Inverse of the obfuscation decodeMD5 unwraps (used to fake server md5s). */
function encodeMD5(md5: string): string {
	const n = md5.slice(8, 16) + md5.slice(0, 8) + md5.slice(24, 32) + md5.slice(16, 24);
	let out = '';
	for (let i = 0; i < n.length; i++) {
		const v = parseInt(n[i]!, 16) ^ (i & 15);
		out += i === 9 ? String.fromCharCode(103 + v) : v.toString(16);
	}
	return out;
}

export interface MockNode {
	path: string;
	name: string;
	isdir: number;
	size: number;
	server_mtime: number;
	md5: string;
	fs_id?: string;
	content?: Uint8Array;
}

/**
 * In-memory Terabox API stand-in. Implements every endpoint the worker calls:
 * root html (jsToken), home/info, list, filemetas, download, create (mkdir and
 * file finalize), precreate, superfile2 chunk upload, membership, filemanager
 * and the direct dl URLs that GET/PROPFIND stream from.
 */
export class MockTerabox {
	nodes = new Map<string, MockNode>();
	private uploads = new Map<string, Map<number, Uint8Array>>();

	constructor() {
		this.nodes.set('/', { path: '/', name: '', isdir: 1, size: 0, server_mtime: 1704067200, md5: '' });
	}

	seed(path: string, opts: { content?: string | Uint8Array } & Omit<Partial<MockNode>, 'content'> = {}): MockNode {
		const content = typeof opts.content === 'string' ? TEXT(opts.content) : opts.content;
		const fsId = `fs-${this.nodes.size + 1}`;
		if (opts.isdir) {
			const node: MockNode = {
				path,
				name: path.split('/').filter(Boolean).pop() || '',
				isdir: 1,
				size: 0,
				server_mtime: opts.server_mtime ?? 1704067200,
				md5: '',
				fs_id: fsId,
			};
			this.nodes.set(path, node);
			return node;
		}
		const bytes = content ?? new Uint8Array(0);
		const node: MockNode = {
			path,
			name: path.split('/').filter(Boolean).pop() || '',
			isdir: 0,
			size: bytes.byteLength,
			server_mtime: opts.server_mtime ?? 1704067200,
			md5: opts.md5 ?? md5Hex(bytes),
			fs_id: fsId,
			content: bytes,
		};
		this.nodes.set(path, node);
		return node;
	}

	children(dir: string): MockNode[] {
		const prefix = dir === '/' ? '/' : dir + '/';
		return [...this.nodes.values()].filter((n) => n.path.startsWith(prefix) && n.path !== dir && !n.path.slice(prefix.length).includes('/'));
	}

	/** Raw Terabox wire shape the worker actually parses. */
	private wire(node: MockNode, withDlink = false): Record<string, unknown> {
		return {
			fs_id: node.fs_id,
			path: node.path,
			server_filename: node.name,
			size: node.size,
			server_mtime: node.server_mtime,
			md5: node.md5,
			isdir: node.isdir,
			...(withDlink ? { dlink: `${BASE}/dl/${encodeURIComponent(node.path)}` } : {}),
		};
	}

	/** Resolve a FormData body whether the stub delivered it as Request or init. */
	private async formDataOf(req: Request, init?: Parameters<typeof fetch>[1]): Promise<FormData | null> {
		if (init?.body instanceof FormData) return init.body;
		if (req.body !== null) {
			try {
				return await req.formData();
			} catch {
				return null;
			}
		}
		return null;
	}

	find(path: string): MockNode | undefined {
		return this.nodes.get(path);
	}

	findDeep(path: string): MockNode[] {
		const prefix = path === '/' ? '/' : path + '/';
		return [...this.nodes.values()].filter((n) => n.path.startsWith(prefix) && n.path !== path);
	}

	private removeTree(path: string): void {
		const doomed = [path, ...this.findDeep(path).map((n) => n.path)];
		for (const p of doomed) this.nodes.delete(p);
	}

	private cloneTree(src: string, dst: string): void {
		const source = this.nodes.get(src);
		if (!source) return;
		for (const node of [...this.nodes.values()].filter((n) => n.path === src || n.path.startsWith(src + '/'))) {
			const suffix = node.path.slice(src.length);
			this.nodes.set(dst + suffix, { ...node, path: dst + suffix, name: (dst + suffix).split('/').filter(Boolean).pop() || '' });
		}
	}

	async handle(input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> {
		const req = input instanceof Request ? input : new Request(String(input), init);
		const url = new URL(req.url);
		const { pathname } = url;
		const method = req.method;

		// Direct download links served by the CDN mock.
		if (pathname.startsWith('/dl/')) {
			const probe = url.searchParams.get('i') === '1';
			const path = decodeURIComponent(pathname.slice(4));
			const node = this.nodes.get(path);
			if (!node || node.isdir) return new Response('not found', { status: 404 });
			const bytes = node.content ?? new Uint8Array(0);
			const range = req.headers.get('Range');
			if (range) {
				const m = /^bytes=(\d+)-(\d*)$/.exec(range);
				if (m) {
					const start = Number(m[1]);
					const end = m[2] === '' ? bytes.byteLength - 1 : Math.min(Number(m[2]), bytes.byteLength - 1);
					if (start >= bytes.byteLength || start > end) return new Response(null, { status: 416 });
					const part = bytes.slice(start, end + 1);
					return new Response(part, {
						status: 206,
						headers: {
							'Content-Length': String(part.byteLength),
							'Content-Range': `bytes ${start}-${end}/${bytes.byteLength}`,
							'Accept-Ranges': 'bytes',
						},
					});
				}
				return new Response(null, { status: 416 });
			}
			return new Response(bytes, {
				status: 200,
				headers: { 'Content-Length': String(bytes.byteLength), 'Accept-Ranges': 'bytes' },
			});
		}

		// Root html payload carrying the jsToken fragment.
		if (method === 'GET' && pathname === '/') {
			const fragment = '`function%20fn%28a%29%7Bwindow.jsToken%20%3D%20a%7D%3Bfn%28%22mockedJsToken%22%29`';
			return new Response('<!doctype html><html><head><script src="/static/js/main.js"></script></head><body>' + fragment + '</body></html>');
		}

		if (url.host === new URL(BASE).host) {
			if (pathname === '/api/home/info') {
				return json({ errno: 0, data: { sign1: 'sign-one', sign3: 'sign-three', timestamp: 1704067200 } });
			}
			if (pathname === '/api/check/login') {
				return json({ errno: 0 });
			}
			if (pathname === '/api/list' && method === 'GET') {
				const dir = url.searchParams.get('dir') || '/';
				return json({ errno: 0, list: this.children(dir).sort((a, b) => (a.name < b.name ? -1 : 1)).map((n) => this.wire(n)) });
			}
			if (pathname === '/api/filemetas') {
				const target = JSON.parse(url.searchParams.get('target') || '[]') as string[];
				const dlink = url.searchParams.get('dlink') === '1';
				const info = target.map((p) => {
					const node = this.nodes.get(p);
					if (!node) return { errno: -9, path: p };
					return this.wire(node, dlink);
				});
				// Real API: a missing target yields top-level errno 12 with the
				// real cause in info[0].errno, never a bare top-level -9.
				const anyMissing = info.some((entry) => entry.errno === -9);
				return json({ errno: anyMissing ? 12 : 0, info });
			}
			if (pathname === '/api/download') {
				const fidlist = JSON.parse(url.searchParams.get('fidlist') || '[]') as number[];
				const want = new Set(fidlist.map(String));
				const nodes = [...this.nodes.values()].filter((n) => n.fs_id && want.has(n.fs_id));
				return json({
					errno: 0,
					dlink: nodes.slice(0, 1).map((n) => ({ fs_id: n.fs_id, dlink: `${BASE}/dl/${encodeURIComponent(n.path)}` })),
				});
			}
			if (pathname === '/api/create' && method === 'POST') {
				const form = await this.formDataOf(req, init);
				const path = String(form?.get('path'));
				const isdir = form?.get('isdir');
				if (isdir === '1') {
					if (this.nodes.has(path)) return json({ errno: -8 });
					this.seed(path, { isdir: 1, server_mtime: Math.floor(Date.now() / 1000) });
					return json({ errno: 0 });
				}
				// Finalize a chunked upload.
				const uploadId = String(form?.get('uploadid'));
				const rtype = Number(url.searchParams.get('rtype') || '0');
				const existing = this.nodes.get(path);
				if (existing && rtype === 0) return json({ errno: -8 });
				const parts = this.uploads.get(uploadId) || new Map<number, Uint8Array>();
				const sorted = [...parts.entries()].sort((a, b) => a[0] - b[0]);
				let total = 0;
				for (const [, bytes] of sorted) total += bytes.byteLength;
				const buf = new Uint8Array(total);
				let offset = 0;
				for (const [, bytes] of sorted) {
					buf.set(bytes, offset);
					offset += bytes.byteLength;
				}
				const real = md5Hex(buf);
				const node = this.seed(path, { isdir: 0, content: buf, server_mtime: Math.floor(Date.now() / 1000) });
				node.md5 = real;
				return json({ errno: 0, md5: encodeMD5(real), uploadid: uploadId });
			}
			if (pathname === '/api/precreate' && method === 'POST') {
				const form = await this.formDataOf(req, init);
				await form?.get('path');
				const uploadId = 'upload-' + Math.random().toString(36).slice(2);
				this.uploads.set(uploadId, new Map());
				return json({ errno: 0, uploadid: uploadId, return_type: 0 });
			}
			if (pathname === '/api/filemanager' && method === 'POST') {
				const raw = await req.arrayBuffer();
				const body = new TextDecoder().decode(raw);
				const filelist = JSON.parse(new URLSearchParams(body).get('filelist') || '[]') as Array<{
					path?: string;
					dest?: string;
					newname?: string;
					ondup?: string;
				}>;
				const opera = url.searchParams.get('opera');
				const info: Array<{ errno: number; path?: string }> = [];
				for (const item of filelist) {
					const src = item.path || '';
					const node = this.nodes.get(src);
					const overwrite = item.ondup === 'overwrite';
					if (opera === 'delete') {
						if (!node) {
							info.push({ errno: -9 });
							continue;
						}
						this.removeTree(src);
						info.push({ errno: 0 });
						continue;
					}
					if (!node) {
						info.push({ errno: -9 });
						continue;
					}
					const dest = item.dest || '/';
					const base = item.newname || node.name;
					const dst = (dest === '/' ? '/' : dest) + (dest.endsWith('/') ? '' : '/') + base;
					if (dst === src) {
						info.push({ errno: 0 });
						continue;
					}
					const destNode = this.nodes.get(dst);
					if (destNode && !overwrite) {
						info.push({ errno: -1 });
						continue;
					}
					if (destNode && overwrite) this.removeTree(dst);
					if (opera === 'copy') {
						this.cloneTree(src, dst);
					} else if (opera === 'move' || opera === 'rename') {
						this.cloneTree(src, dst);
						this.removeTree(src);
					}
					info.push({ errno: 0 });
				}
				return json({ errno: 0, taskid: 0, info });
			}
			if (pathname === '/rest/2.0/membership/proxy/user') {
				return json({ errno: 0, data: { member_info: { is_vip: 0 } } });
			}
			if (pathname === '/rest/2.0/pcs/file') {
				return json({ errno: 0, host: new URL(UPLOAD_BASE).host });
			}
		}

		// Chunk upload against the located host.
		if (pathname === '/rest/2.0/pcs/superfile2' && method === 'POST') {
			const uploadId = url.searchParams.get('uploadid') || '';
			const partseq = Number(url.searchParams.get('partseq') || '0');
			const form = await this.formDataOf(req, init);
			const file = form?.get('file');
			let bytes = new Uint8Array(0);
			if (file) {
				bytes = new Uint8Array(await (file as unknown as Blob).arrayBuffer());
			}
			const bucket = this.uploads.get(uploadId) || new Map<number, Uint8Array>();
			bucket.set(partseq, bytes);
			this.uploads.set(uploadId, bucket);
			return json({ errno: 0, md5: md5Hex(bytes) });
		}

		return json({ error: `unhandled ${method} ${pathname} on ${url.host}` }, 501);
	}
}

export function installMock(mock: MockTerabox): void {
	vi.stubGlobal('fetch', (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
		mock.handle(input, init)
	);
}