# Terabox WebDAV Worker

Expose a [Terabox](https://www.terabox.com) account as a WebDAV server on a
Cloudflare Worker. It is a from-scratch TypeScript port of the Terabox backend
of [bclone](https://github.com/BenjiThatFoxGuy/bclone) (itself a fork of
rclone), implemented against the private web API using the account session
cookie.

## How it works

- `src/sign.ts` — signature and path helpers (RC4-style download signature,
  jsToken scraping, chunk sizing, `decodeMD5`).
- `src/md5.ts` — dependency-free MD5 (Workers WebCrypto omits MD5; Terabox
  chunk checksums need it).
- `src/terabox.ts` — `TeraboxClient` speaking the web API: listing, metadata,
  mkdir, download links, filemanager ops (with async copy polling) and
  chunked uploads.
- `src/webdav.ts` — RFC 4918 surface (PROPFIND / MKCOL / GET / PUT / DELETE /
  MOVE / COPY / LOCK / UNLOCK / PROPPATCH) mapped over `TeraboxClient`.
- `src/davxml.ts` — XML validation and namespace self-containment helpers
  for PROPFIND/PROPPATCH bodies (malformed input → 400, never silent).
- `src/davstate.ts` — advisory state (lock records + dead properties) behind
  the `DavStore` interface: the `DavState` Durable Object (one serialized
  instance shared by every isolate) with per-isolate memory fallback.
- `src/index.ts` — entry point with basic auth that fails closed when `USERS`
  or `COOKIE` is unset.

## Setup

Everything is configured in **your** dashboard — the repo carries no
per-instance values. Only genuine credentials are Secrets; everything else
is an ordinary (optional) Variable:

| Key | Type | Example | Notes |
| --- | --- | --- | --- |
| `USERS` | **Secret** | `alice:s3cret,bob:hunter2` | comma/newline separated `user:pass` pairs |
| `COOKIE` | **Secret** | `ndus=...; stoken=...; lang=en` | **full** Terabox cookie string from your browser (all cookies — `stoken` matters for uploads) |
| `JSTOKEN` | **Secret**, optional | `a1b2c3...` | pre-minted `window.jsToken` from the terabox.com console (same as Alist/CLI); skips automatic minting |
| `TERABOX_DOMAIN` | Variable, optional | `https://dm.terabox.com` | origin mirror (default `https://www.terabox.com`). **Regional accounts must set their own** — the wrong origin rejects the cookie with `errno -6`; upload clusters come from this origin's locateupload |
| `MIN_GAP_MS` | Variable, optional | `400` | pacing between Terabox calls (default `400`; bclone parity) |
| `PATH` | Variable, optional | `/dav/` | base path the WebDAV is served under (gdrive parity): requests outside it 404, the bare base 301s to `/dav/`, hrefs include it |
| `ROOT_ID` | Variable, optional | `/backup` | Terabox folder mounted as the WebDAV root (gdrive parity; Terabox keys folders by path): clients see only that subtree |
| `LOG_PREFIX` | Variable, optional | `[prod]` | tag prepended to worker logs |

All Variables are user-made per instance (Workers → Settings → Variables
and Secrets) and deliberately not committed to `wrangler.toml` — each
deployment of this repo carries its own values, preserved across deploys by
`keep_vars = true`. Nothing beyond `USERS`/`COOKIE`/`JSTOKEN` needs to be a
secret: a mirror host or a base path is ordinary configuration.

**No manual Durable Object setup**: the `DavState` class (lock +
dead-prop state) is declared in `wrangler.toml` `[exports]` and provisioned
automatically on the first deploy.

```sh
wrangler secret put USERS
wrangler secret put COOKIE
# optional:
wrangler secret put JSTOKEN
npx wrangler deploy
```

Rate limiting: every outbound Terabox call (API, token mint, download stream)
is spaced by `MIN_GAP_MS`, retries honour `Retry-After` (capped at 5 s), and
the jsToken is re-minted at most once per 5 minutes — designed so the account
never trips Terabox's verification gate.

## Auto-deploy via the Cloudflare dashboard

The Worker auto-deploys from Git: the dashboard's Git integration watches
`main` and deploys on every push.

1. Dashboard → **Workers & Pages → Create application → Connect to Git**.
2. Choose `taxin-404/terabox-webdav-worker`.
3. Set **Production branch** to `main`.
4. Leave **Root directory** and **Build output directory** empty (this is a
   pure Worker, no assets).
5. Set **Build command** to:
   ```sh
   npm ci --legacy-peer-deps
   ```
6. In the created Worker → **Settings → Variables and Secrets**, add the
   three Secrets (`USERS`, `COOKIE`, optionally `JSTOKEN`) and any optional
   Variables you want (`TERABOX_DOMAIN`, `MIN_GAP_MS`, `PATH`, `ROOT_ID`,
   `LOG_PREFIX`). All env values are per-instance and user-made — none ship
   in `wrangler.toml` — and dashboard-only vars survive deploys via
   `keep_vars = true`.
   Dashboard deploys do not read `.dev.vars` or `wrangler secret put`.

Every `git push origin main` triggers a deploy; the first deploy also
provisions the `DavState` Durable Object class automatically.

## rclone usage

```sh
rclone config create terabox webdav \
  url https://terabox.taxin-404.workers.dev/ \
  vendor other \
  user alice \
  pass <your-webdav-password>
```

Uploads are buffered in memory and sent as Terabox chunks. Free accounts are
capped at 4 GiB files (error 58 beyond that); premium accounts up to 128 GiB.
If you set `PATH`, append it to the URL (e.g. `url = .../dav/`).

## davfs2 usage

Non-root davfs2 mounts require an `/etc/fstab` entry (davfs2's own rule, not a
worker limitation):

```
https://your-worker.workers.dev/dav/ /mnt/terabox davfs noauto,user,uid=1000,gid=1000 0 0
```

`mount /mnt/terabox` then works without sudo. Credentials live in
`~/.davfs2/secrets` (or `/etc/davfs2/secrets` for system-wide mounts), one
line per URL: `URL user:password`.

davfs2's access pattern shapes how the mount feels:

- **One whole-file `GET` per open** — davfs2 never sends `Range` requests;
  `open()` streams the entire file into its local cache and every later read
  is local. Small and medium files are quick; opening a multi-gigabyte video
  downloads all of it first (measured ~1.5 MB/s through this worker, i.e.
  roughly ten minutes per gigabyte — and the mount is unresponsive to
  everything else meanwhile, davfs2 being single-threaded) — use rclone for
  those.
- **Revalidation is cheap** — davfs2 re-opens with `If-None-Match` and the
  worker answers `304 Not Modified`, so a cached file re-opens with no body.
- **`~/.davfs2/davfs2.conf`** reduces chatter:

  ```
  delay_upload 0    # default 10: write back on close, not 10 s later
  gui_optimize 1    # one PROPFIND per directory instead of per-file stats
  use_locks 0       # skip advisory LOCK round-trips
  buf_size 64       # 16: larger kernel read/write buffer
  ```

- **`lost+found/`** in the mount view is a davfs2 built-in directory for
  failed uploads. It exists only in the client's view, never on the server.

## Limitations

- Non-zero `Depth` PROPFIND returns children (same policy as the drive WebDAV
  workers); infinite-depth listings are not crawled.
- Files download through a Terabox CDN link with `Range` support; HEAD only
  examines metadata.
- Real RFC 4918 locks (LOCK/UNLOCK with 423 enforcement, `If` evaluation,
  lockdiscovery) and dead properties, backed by the `DavState` Durable
  Object when bound (per-isolate memory fallback otherwise).

## Development

Commands for local build, review and deploy:

```sh
npm install --legacy-peer-deps   # wrangler pins + sharp override
npm run typecheck                # tsc --noEmit
npm test                         # 125 tests over the mock Terabox API
npm run review                   # typecheck + dry-run deploy (no upload)
npm run dev                      # local wrangler dev server (localhost:8787)
npm run deploy                   # wrangler deploy (push to production)
```

The test-suite mocks the Terabox API behind a stubbed global fetch, so the
whole stack (auth, routing, WebDAV, uploads) is exercised without a real
account. You still need a real `ndus` cookie to try a live account.