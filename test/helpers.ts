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
	/** Optional client-visible timestamps — real list entries sometimes carry
	 *  these INSTEAD of server_mtime; the worker must fall back to them. */
	mtime?: number;
	ctime?: number;
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
	/** filemetas round-trips served — lets tests assert cache behaviour. */
	filemetasCalls = 0;

	/** Test knobs: force an endpoint to fail with this errno (0 = healthy). */
	membershipErrno = 0;
	precreateErrno = 0;
	/** Force the whole /api/filemetas response to fail with this errno. */
	filemetasErrno = 0;
	/** Per-path /api/filemetas failures — lets a test make ONE stat fail
	 *  (e.g. the PUT target) while its parent stays healthy. */
	filemetasFailPaths = new Map<string, number>();
	/** Every /api/list page answers a full `num` items forever — exercises
	 *  the worker's 100-page truncation guard without seeding 10k files. */
	listFullPages = false;
	/** superfile2 chunk uploads observed — lets tests assert multi-chunk PUTs. */
	superfile2Calls = 0;
	/** Override locateupload's candidate server list (default: [UPLOAD_BASE host]). */
	locateServers: string[] | null = null;
	/** Hosts whose superfile2 answers HTTP 403 error_code 31045 "user not exists". */
	rejectHosts = new Set<string>();
	/** Gate direct-download links like the live 400141 "need verify" endpoint:
	 *  'once' passes requests carrying jsToken (proves the retry remedy),
	 *  'always' fails every request (proves the mapped error path). */
	gateDownloads: 'once' | 'always' | undefined;
	/** Gate /dl/ targets reached via specific link flavours (the live web
	 *  dlink gate): 'plain' = filemetas dlink, 'official' = /api/download,
	 *  'pcs' = the 302 Location of the app-protocol route. Proves which
	 *  candidate in the ladder actually served the bytes. */
	gateDl: Array<'plain' | 'official' | 'pcs'> = [];
	/** Answer the PCS route itself with a 200 {error_code:400141} gate body
	 *  (app-route shape, pre-redirect) — proves error_code JSON is raised as
	 *  an error instead of streamed as file content. */
	gatePcs = false;
	/** Answer a *no-Range* /dl/ GET with 206 anyway — the live PCS flap that
	 *  poisons a davfs2 client's stored etag (it captures an etag only from an
	 *  exactly-200). 'full' sends the whole entity under a full-extent
	 *  Content-Range: the worker must re-state it as 200. */
	unrequestedFull206 = false;
	/** Flavours whose no-Range /dl/ GET answers a genuinely truncated 206 —
	 *  the worker must reject it and fall through the download ladder instead
	 *  of streaming a partial body as a complete file. */
	unrequestedPartial206: Array<'plain' | 'official' | 'pcs'> = [];

	constructor() {
		this.nodes.set('/', { path: '/', name: '', isdir: 1, size: 0, server_mtime: 1704067200, md5: '' });
	}

	seed(path: string, opts: { content?: string | Uint8Array } & Omit<Partial<MockNode>, 'content'> = {}): MockNode {
		const content = typeof opts.content === 'string' ? TEXT(opts.content) : opts.content;
		// Real Terabox fs_ids are numeric — downloadLink() sends them as
		// unquoted numbers in fidlist, so string ids ("fs-2") would never match.
		const fsId = String(1000000 + this.nodes.size);
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
			...(node.mtime !== undefined ? { mtime: node.mtime } : {}),
			...(node.ctime !== undefined ? { ctime: node.ctime } : {}),
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
			const flavour = (url.searchParams.get('via') || 'plain') as 'plain' | 'official' | 'pcs';
			const gated =
				this.gateDl.includes(flavour) ||
				this.gateDownloads === 'always' ||
				(this.gateDownloads === 'once' && !url.searchParams.has('jsToken'));
			if (gated) {
				return new Response(JSON.stringify({ request_id: 'mock-gate', errno: 400141, errmsg: 'need verify' }), {
					status: 200,
					headers: { 'Content-Type': 'application/json' },
				});
			}
			const probe = url.searchParams.get('i') === '1';
			const path = decodeURIComponent(pathname.slice(4));
			const node = this.nodes.get(path);
			if (!node || node.isdir) return new Response('not found', { status: 404 });
			const bytes = node.content ?? new Uint8Array(0);
			const range = req.headers.get('Range');
			if (!range && bytes.byteLength > 0) {
				// Unrequested-206 emulation (the live PCS flap under test).
				if (this.unrequestedFull206) {
					return new Response(bytes, {
						status: 206,
						headers: {
							'Content-Length': String(bytes.byteLength),
							'Content-Range': `bytes 0-${bytes.byteLength - 1}/${bytes.byteLength}`,
							'Accept-Ranges': 'bytes',
						},
					});
				}
				if (this.unrequestedPartial206.includes(flavour)) {
					const half = bytes.slice(0, Math.max(1, bytes.byteLength >> 1));
					return new Response(half, {
						status: 206,
						headers: {
							'Content-Length': String(half.byteLength),
							'Content-Range': `bytes 0-${half.byteLength - 1}/${bytes.byteLength}`,
							'Accept-Ranges': 'bytes',
						},
					});
				}
			}
			if (range) {
				const m = /^bytes=(\d*)-(\d*)$/.exec(range);
				if (m && (m[1] !== '' || m[2] !== '')) {
					let start: number;
					let end: number;
					if (m[1] === '') {
						// Suffix range: the last N bytes.
						const suffix = Number(m[2]);
						start = Math.max(0, bytes.byteLength - suffix);
						end = bytes.byteLength - 1;
					} else {
						start = Number(m[1]);
						end = m[2] === '' ? bytes.byteLength - 1 : Math.min(Number(m[2]), bytes.byteLength - 1);
					}
					if (start >= bytes.byteLength || start > end) {
						// RFC 7233: unsatisfiable → 416 with the total size.
						return new Response(null, {
							status: 416,
							headers: { 'Content-Range': `bytes */${bytes.byteLength}` },
						});
					}
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
				// Malformed / multi-part Range: the CDN ignores it and sends
				// the whole entity (RFC 7233 §3.1 allows both behaviours).
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
				const page = Number(url.searchParams.get('page') || '1');
				const num = Number(url.searchParams.get('num') || '100');
				const all = this.children(dir).sort((a, b) => (a.name < b.name ? -1 : 1));
				const list = this.listFullPages
					? // Synthesize an endless full page: same shape every time, never short.
						Array.from({ length: num }, (_, i) => {
							const src = all[i % Math.max(all.length, 1)];
							if (src) return this.wire(src);
							return this.wire({
								path: `${dir === '/' ? '' : dir}/full-${i}`,
								name: `full-${i}`,
								isdir: 0,
								size: 1,
								server_mtime: 1704067200,
								md5: '',
								fs_id: String(900000 + i),
							});
						})
					: all.slice((page - 1) * num, page * num).map((n) => this.wire(n));
				return json({ errno: 0, list });
			}
			if (pathname === '/api/filemetas') {
				this.filemetasCalls++;
				if (this.filemetasErrno) return json({ errno: this.filemetasErrno, msg: 'simulated filemetas outage' });
				const target = JSON.parse(url.searchParams.get('target') || '[]') as string[];
				const dlink = url.searchParams.get('dlink') === '1';
				const info = target.map((p) => {
					const forced = this.filemetasFailPaths.get(p);
					if (forced) return { errno: forced, path: p };
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
					dlink: nodes.slice(0, 1).map((n) => ({
						fs_id: n.fs_id,
						// `via=official` marks the token-bearing official flavour.
						dlink: `${BASE}/dl/${encodeURIComponent(n.path)}?via=official`,
					})),
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
				const chunkMd5s: string[] = [];
				for (const [, bytes] of sorted) {
					buf.set(bytes, offset);
					offset += bytes.byteLength;
					chunkMd5s.push(md5Hex(bytes));
				}
				const real = md5Hex(buf);
				const node = this.seed(path, { isdir: 0, content: buf, server_mtime: Math.floor(Date.now() / 1000) });
				node.md5 = real;
				// Live contract (bclone parity): a single-chunk create returns
				// the file md5; a multi-chunk create returns the CONTROL md5 —
				// md5 of the JSON array of per-chunk md5s — which is what the
				// worker validates its chunk list against.
				const wireMd5 = chunkMd5s.length === 1 ? real : md5Hex(new TextEncoder().encode(JSON.stringify(chunkMd5s)));
				return json({ errno: 0, md5: encodeMD5(wireMd5), uploadid: uploadId });
			}
			if (pathname === '/api/precreate' && method === 'POST') {
				if (this.precreateErrno) return json({ errno: this.precreateErrno, msg: 'simulated verify required' });
				const form = await this.formDataOf(req, init);
				await form?.get('path');
				const uploadId = 'upload-' + Math.random().toString(36).slice(2);
				this.uploads.set(uploadId, new Map());
				return json({ errno: 0, uploadid: uploadId, return_type: 0, uploadsign: 'mock-sign' });
			}
			if (pathname === '/api/filemanager' && method === 'POST') {
				const raw = await req.arrayBuffer();
				const body = new TextDecoder().decode(raw);
				const filelist = JSON.parse(new URLSearchParams(body).get('filelist') || '[]') as Array<
					string | { path?: string; dest?: string; newname?: string; ondup?: string }
				>;
				const opera = url.searchParams.get('opera');
				// Live contract (bclone parity): delete takes a plain array of
				// path strings; objects NPE the server into an empty HTTP 500.
				if (opera === 'delete' && !filelist.every((item) => typeof item === 'string')) {
					return new Response('', { status: 500 });
				}
				const info: Array<{ errno: number; path?: string }> = [];
				for (const item of filelist) {
					const src = (typeof item === 'string' ? item : item.path) || '';
					const node = this.nodes.get(src);
					if (opera === 'delete') {
						if (!node) {
							info.push({ errno: -9 });
							continue;
						}
						this.removeTree(src);
						info.push({ errno: 0 });
						continue;
					}
					// Non-delete operas always use the object form.
					if (typeof item === 'string') {
						info.push({ errno: -9 });
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
					// Live parity: filemanager move/copy never replaces an
					// existing target — `ondup` is documented but ignored and
					// the server answers -8 "The file already exists". A
					// WebDAV Overwrite: T must delete the target first.
					if (destNode) {
						info.push({ errno: -8 });
						continue;
					}
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
				if (this.membershipErrno) return json({ errno: this.membershipErrno });
				return json({ errno: 0, data: { member_info: { is_vip: 0 } } });
			}
		}

		// PCS app-protocol download (the ladder's first candidate): the session
		// cookie in, 302 straight to the CDN — no /file/<hash> dlink hop.
		if (pathname === '/rest/2.0/pcs/file' && url.searchParams.get('method') === 'download') {
			if (this.gatePcs) {
				return json({ request_id: 'mock-pcs-gate', error_code: 400141, error_msg: 'need verify' });
			}
			const path = url.searchParams.get('path') || '';
			const node = this.nodes.get(path);
			if (!node || node.isdir) return json({ error_code: -9, error_msg: "file doesn't exist" }, 404);
			// The live endpoint mints a fresh Location per request; via=pcs marks
			// which ladder flavour served the bytes for assertions.
			const location = new URL(`${BASE}/dl/${encodeURIComponent(path)}`);
			location.searchParams.set('via', 'pcs');
			return new Response(null, { status: 302, headers: { Location: location.toString() } });
		}

		// Upload-host discovery: the configured base origin answers with the
		// account's own cluster list (live: dm.terabox.com → dm1/dm2/kul-cdata)
		// — mirror that here. d.terabox.com / <prefix>-data.terabox.com are
		// valid fallbacks; everything else answers 400141 "need verify".
		if (pathname === '/rest/2.0/pcs/file' && url.searchParams.get('method') === 'locateupload') {
			const ok =
				url.hostname === new URL(BASE).hostname ||
				url.hostname === 'd.terabox.com' ||
				url.hostname.endsWith('-data.terabox.com');
			if (!ok) return json({ errno: 400141, msg: 'need verify' });
			const fallback = new URL(UPLOAD_BASE).host;
			const server = this.locateServers ?? [fallback];
			return json({ errno: 0, server, host: server[server.length - 1] ?? fallback });
		}

		// Chunk upload against a located host.
		if (pathname === '/rest/2.0/pcs/superfile2' && method === 'POST') {
			if (this.rejectHosts.has(url.hostname)) {
				return json({ error_code: 31045, error_msg: 'user not exists' }, 403);
			}
			this.superfile2Calls++;
			// The web client always echoes precreate's uploadsign back
			// (e.uploadSign = o.uploadsign) — lock that contract here; live
			// clusters reject mismatches with 31045 "user not exists".
			if (url.searchParams.get('uploadsign') !== 'mock-sign') {
				return json({ error_code: 31045, error_msg: 'user not exists' }, 403);
			}
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