# TeraBox limitations (and how this worker deals with them)

A catalog of the real, verified constraints TeraBox imposes. Everything here was
observed live during the campaigns in `live-testing.md`, taken from competing
clients' source (bclone/alist), or both. "Measured" = we ran it against the real
service from Cloudflare.

## 1. Account & storage

| Limit | Value | Source |
|---|---|---|
| Free storage | 1 TB per account | TeraBox free tier (product-wide) |
| Max file size, free | 4 GiB per file | bclone `api.go` (`size > 4 GiB && !isPremium` → rejected) |
| Max file size, premium | 128 GiB per file | bclone `api.go` (same check, premium branch) |
| Directory depth | ≤ 16 levels | documented drive-side constraint (also encoded in bclone's tree walker) |
| Filename length | ≤ 255 bytes per segment | measured (long/unicode/`%`/`#`/`?`/quote names all work up to 255) |
| Deleted files | recycle bin, auto-purge after 10 days | product behavior, verified: `DELETE` → file reappears in bin, not gone |

- Over-quota uploads fail at `precreate` with `-10` (or its errno alias), which
  the worker surfaces as **HTTP 507 Insufficient Storage**.
- `DELETE` moves to the recycle bin (web-app parity); it does **not** free quota
  immediately, and the worker deliberately never calls `/api/recycle/clear`
  (that would purge trash the user created themselves in the TeraBox app).

## 2. Rate limiting & anti-abuse (the big one)

| Behavior | Detail | Status |
|---|---|---|
| Call pacing | bclone sleeps **400 ms minimum** between upstream API calls; faster bursts earn `429` / `400141` / silent throttling | worker paces every outbound call with `MIN_GAP_MS` (400 default, `wrangler.toml` var) |
| jsToken | mintable from any root page (`/main?category=all`, `about`, `privacy`) with desktop `sec-ch-ua` headers; 128 hex chars | worker mints + caches (`JS_TOKEN_CACHE`, 5 min TTL), refreshes on `4000023` / `450016` |
| Missing token | `filemanager` without jsToken → `450016 need verify` (HTTP 200 body) | worker always attaches token |
| **IP-reputation gate (400141)** | **web dlink path (`/file/<hash>`) answers `400141 need verify` from datacenter IPs on every origin and flavour — plain `filemetas` dlink, `origin=dlna`, official `/api/download` token dlink, even host-rewritten browser URLs. A fresh jsToken does not clear it.** | **solved**: download uses the app-protocol **PCS route** `/rest/2.0/pcs/file?method=download` which 302s to CDN with no jsToken/sign (see §3) |
| Rate on API | ~1 req / 400 ms → a paced 3-step GET ≈ 2.9 s TTFB (measured) | ladder is lazy: extra phases only run if a phase fails |
| jsToken ↔ IP/session | refreshing it from a different IP invalidates the session context; keep it same-IP | worker mints from its own egress only |

## 3. Download paths

- **Two-hop shape**: signed dlink `/api/.../file/<hash>` → **302** → CDN
  capability URL. The CDN hop needs **no cookie at all**; the signed hop does.
- **Expiry**: `filemetas` dlinks ≈ **8 h**, official `/api/download` dlinks ≈ **1 h** (measured). The worker mints on demand — no URL cache yet (each GET re-mints; ~2.9 s TTFB).
- **Gate** (above): from datacenter IPs only the **PCS app-protocol route** survives:
  `GET /rest/2.0/pcs/file?method=download&app_id=250528&path=<path>` + session
  cookie → immediate `302` to CDN. Same route family as `locateupload`
  (live-proven reachable from Cloudflare).
- **Fallback ladder** (lazy, each phase only if the previous fails):
  1. PCS route on `<label>-d` / `<label>-data` / origin
  2. official `/api/download` token dlink (minted only if phase 1 fails)
  3. plain `filemetas` dlink
  4. last `400141` rethrown as **401** with `step: dlink@<host>`
- **Throughput (measured, 20 MB file, Cloudflare → TeraBox CDN)**:
  - single stream: **~1.5–2.0 MB/s ≈ 12–16 Mbps** sustained (md5 verified end-to-end)
  - 4 parallel `Range` GETs: all `206`, parts reassemble to the correct md5;
    aggregate ≈ same link cap (~1.4–1.8 MB/s) — bandwidth to the CDN appears
    capped per path, so extra transfers cut latency, not total time
  - TTFB ≈ **2.9 s** = the three paced API hops; the byte stream itself is not throttled
  - this is a **TeraBox free-tier CDN/account** speed, identical for every
    client; the worker adds zero per-byte delay (pacing is per *call*, not per byte)
- The user's own ISP path (TH → KL peering, ~29 KB/s measured) is bypassed
  entirely: bytes flow TeraBox CDN → Cloudflare → client.

## 4. Upload pipeline

- **Cluster table**: `locateupload` hands out per-session upload clusters
  (`dm1`/`dm2`/`kul-cdata…`); sometimes it answers only `-6`/no URL, so the
  worker falls back to base-host upload URLs (alist parity).
- **Signed params**: chunk upload needs `uploadsign` generated with the page's
  `bdstoken` + WEB UA/APP ID (web-app parity).
- **Chunks**: files split by `getChunkSize()`; each chunk POSTs to the chosen
  cluster, then `create` verifies `block_list` (per-chunk md5 + upload md5).
  Hash mismatch → `-32`.
- **`rtype` semantics** (filemanager): `0` = wait for sync, `1` = adaptive
  (returns before completion — the worker passes `rtype=1` and polling
  reconciles), `2` = pure async.
- **Pacing applies here too**: chunk uploads run through the same 400 ms gate —
  a 20 MB PUT measured **18.2 s** (5 chunks × paced calls). Upload is slow by
  design to keep the account unbanned.

## 5. Sessions & cookies

- Cookie = `ndus` + `stoken` (+ `BAIDUID`, `lang`). It is a **secret** (never
  committed; dashboard Secret only). Sessions expire — when they do, every
  call fails with `2/check/login` errno and the cookie must be refreshed.
- `JSTOKEN` is optional: only the cookie the WebDAV client sends is ever
  echoed back; the page-minted jsToken stays server-side.
- `bdstoken` is embedded in the account page HTML (used for `filemanager` +
  `uploadsign`); refreshed lazily when 4000023 fires.
- Region binding: accounts are tied to a deployment (`dm.terabox.com` cluster
  table); wrong origin → `31045` or `Url-Domain-Prefix` (`-6`) redirect.

## 6. What is *not* a TeraBox limit (worker-side design)

- **WebDAV locks & dead properties are per-isolate, in-memory state.** The
  worker has no storage binding, so LOCK records and PROPPATCH-set dead props
  live in the isolate that handled the request. Consequences, all deliberate:
  - Locks are **real**: un-tokened writes to a locked resource answer `423`,
    UNLOCK validates its token (`409`), `lockdiscovery` reports the active
    lock, shared locks stack, refresh works through `Depth: Infinity`
    ancestors, and `If` headers are evaluated (`412`/`423`).
  - After isolate rotation the state is gone. Enforcement then *relaxes*
    (an empty store allows the write), and a self-issued lock token stays
    valid for the rest of its embedded expiry so warm clients (Windows,
    litmus) are never bricked mid-session. Worst case a client re-locks.
  - Dead props survive PROPFIND/PROPPATCH/MOVE/COPY/DELETE within the
    isolate, are keyed by expanded `{namespace}local` name, and are cleared
    on DELETE.
- **PUT auto-creates missing parent collections** (Google Drive worker parity
  for clients that PUT deep paths without MKCOL). RFC 4918 §9.7.2 says 409;
  this is the one intentional litmus deviation (`basic/put_no_parent`).
  MKCOL and MOVE/COPY destinations *do* enforce the RFC rule (409).
- **Lazily re-minted dlinks / TTFB**: no isolate-global dlink cache yet; would
  be a worker optimization (cache signed URLs up to min(1 h, 8 h) expiry).
- **No parallel-range bandwidth gain**: limited by the CDN path cap, not by the
  worker.

## Quick reference: errno → HTTP mapping

| errno / condition | HTTP |
|---|---|
| ok (`0`) | 2xx |
| `-10` out of space (precreate) | 507 |
| `-32` chunk hash mismatch | 400 |
| `need verify` / `400141` / `450016` on a download | 401 (`step: dlink@<host>`) |
| `2/check/login` | 401 |
| `31045` wrong region | 502 |
| recycle/purge refused | kept out of band (never called) |

See also: `live-testing.md` (campaign log with every probe behind these claims).
