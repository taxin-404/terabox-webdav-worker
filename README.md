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
  MOVE / COPY) mapped over `TeraboxClient`.
- `src/index.ts` — entry point with basic auth that fails closed when `USERS`
  or `COOKIE` is unset.

## Setup

Create the Worker with three secrets/vars:

| Key | Example | Notes |
| --- | --- | --- |
| `USERS` | `alice:s3cret,bob:hunter2` | comma/newline separated `user:pass` pairs |
| `COOKIE` | `ndus=...; lang=en` | Terabox session cookie from your browser |
| `TERABOX_DOMAIN` | `https://www.terabox.com` | optional mirror host (default) |

```sh
wrangler secret put USERS
wrangler secret put COOKIE
npx wrangler deploy
```

Prefer secrets over vars: `COOKIE` is genuine credentials.

## rclone usage

```sh
rclone config create terabox webdav \
  url https://terabox-webdav.<your-subdomain>.workers.dev/ \
  vendor other \
  user alice \
  pass <your-webdav-password>
```

Uploads are buffered in memory and sent as Terabox chunks. Free accounts are
capped at 4 GiB files (error 58 beyond that); premium accounts up to 128 GiB.

## Limitations

- Non-zero `Depth` PROPFIND returns children (same policy as the drive WebDAV
  workers); infinite-depth listings are not crawled.
- Files download through a Terabox CDN link with `Range` support; HEAD only
  examines metadata.
- No lock tokens; LOCK/UNLOCK is not implemented (rclone doesn't need it).

## Development

```sh
npm install --legacy-peer-deps   # wrangler pins + sharp override
npm run typecheck
npm test                         # 40 tests over the mock Terabox API
npm run dev                      # local wrangler dev server
```

The test-suite mocks the Terabox API behind a stubbed global fetch, so the
whole stack (auth, routing, WebDAV, uploads) is exercised without a real
account. You still need a real `ndus` cookie to try a live account.