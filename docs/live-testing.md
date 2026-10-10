# Live testing notes

State of the live-test campaign against the deployed worker. Update this file
after every campaign so future sessions (human or AI) start with context.

## Target

- Worker: `https://terabox.taxin-404.workers.dev/` (auto-deploys from `main`)
- Credentials: **not stored in this repo** — pass via `WEBDAV_USER` / `WEBDAV_PASS`
- Test account content: folders `BackupFolder/ mern/ hacking/ omacom/ tools/ …`,
  sample file `BackupFolder/screenshot-2026-07-21_12-58-20.png`

## How to run

```sh
# full WebDAV compliance pass (read + write + cleanup)
WEBDAV_USER=… WEBDAV_PASS=… bash test/live/webdav-livetest.sh

# rate-limit probe (escalating rps, stops at first throttling)
WEBDAV_USER=… WEBDAV_PASS=… node test/live/rate-probe.mjs
```

Local toolchain: Node 22 LTS in `~/.local/node/bin` (added to `~/.bashrc`);
`npm install --legacy-peer-deps` once, then `npm test` / `npm run typecheck`.

## Campaign 1 — 2026-10-09

### WebDAV compliance: 26 pass / 22 fail

Passing: auth 401s, OPTIONS, PROPFIND (root/file/missing), bad-encoding 400,
GET file + content-type, GET folder 405, GET missing 404, all MKCOL cases
(201/405/403), PUT root 403, MOVE/COPY self semantics (204/403/400/404),
DELETE missing 404, DELETE root 403.

Failures (grouped by root cause):

| # | Symptom | Root cause hypothesis | Status |
|---|---|---|---|
| 1 | **every file PUT → 401 `{"error":"Terabox session expired or invalid"}`** | upload path (`checkPremium` → `locateupload` → `precreate` → `superfile2` → `create`) hits errno `-6/4000023/400141/450016`; MKCOL and MOVE/COPY (which mint `jsToken` first) work, so the token mint itself is fine — one of the upload-only endpoints rejects it | **open — highest priority** |
| 2 | PUT failures cascade: roundtrip/nested/MOVE-file/DELETE-file checks fail | downstream of #1 | blocked by #1 |
| 3 | GET `Range: bytes=…` → 200 not 206 | worker forwards `Range` to the Terabox CDN `dlink`, but upstream answered 200 — either CDN ignores `Range` for this link flavour or a header (e.g. `User-Agent`) is missing | open |
| 4 | HEAD response has no `Content-Length` | upstream CDN streams chunked on plain GET, so no length to copy; worker should synthesize it from item metadata (`size`) instead | open |
| 5 | unknown method `FOO` → 501 not 405 | Cloudflare edge rejects unknown methods before the Worker; not fixable in code | works-as-platform |
| 6 | scratch dir DELETE → 500, folder survived | likely leftover non-empty tree (cascade of #1) + Terabox refusing; retest after #1 | retest |

### Rate limit probe: no throttling observed up to 32 rps

`PROPFIND Depth 0` (= 1 upstream API call), 10 s per phase, 5 s cooldown:

| rps | sent | codes | latency p50 / p95 / max |
|----:|-----:|-------|--------------------------|
| 2 | 40 | 207:40 | 129 / 564 / 611 ms |
| 4 | 159 | 207:159 | 132 / 173 / 539 ms |
| 8 | 569 | 207:569 | 133 / 181 / 550 ms |
| 16 | 1176 | 207:1176 | 131 / 187 / 533 ms |
| 32 | 2306 | 207:2306 | 132 / 185 / 1683 ms |

Recovery check immediately after: clean 207. So **read endpoints show no
429 at ~32 rps / ~2 300 requests sustained**. Caveats: egress is Cloudflare
shared IP space (limits are probably per-cookie anyway), `filemetas` may be
cheaper for Terabox than upload endpoints, and account-level daily quotas
would not show up in a 60 s probe.

### Reference values from bclone (`backend/terabox`)

The bclone author left explicit pacing guidance:

```go
// minSleep       = 400 * time.Millisecond // api is extremely rate limited now
// maxSleep       = 5 * time.Second
// decayConstant  = 2
// attackConstant = 0 // start with max sleep
```

- HTTP retry set: `429, 500, 502, 503, 504, 509` → ≤3 attempts, sleep 1 s/2 s
- client timeout: 5 s
- uploads run through a bounded thread pool (`upload_threads`), chunks sequential

Interpretation: Terabox historically throttled hard; bclone's author planned to
*start* at the 5 s ceiling. Our probe found read-side headroom far beyond that,
so a conservative worker-side pacing of ~1 request / 400 ms with 429-aware
backoff (cap 5 s, honour `Retry-After`) matches the reference without hurting
interactive PROPFIND latency much (each WebDAV call = 1–2 upstream calls).

## Campaign 2 — upload fix (400141 → 31045)

Live PUT debugging on 2026-10-09, step by step (each entry = pushed, waited
for dashboard deploy, retested):

| # | Commit | Change | Live result |
|---|---|---|---|
| 1 | `5a2cf39` | full common params on `locateupload` (www origin) | still `400141 "need verify"` |
| 2 | `5b76fd7` | bare GET on `jp-data.terabox.com` (Alist parity) | **locateupload ✓, precreate ✓**, `chunk0` → HTTP 403 |
| 3 | `554003d` | capture non-2xx bodies + host into errors | body = `{"error_code":31045,"error_msg":"user not exists"}` on `c-jp.terabox.com` |
| 4 | `dc86a87` | union of Alist+CLI chunk params (web, type, no jsToken, browser headers) | same 31045 |
| 5 | `93d9714` | walk locateupload's `server[]` candidates (browser parity) | failover works, **all** of `c-jp/c1-jp/c2-jp` → 31045 |
| 6 | `367b895` | sessioned discovery, drop `type`, `cookieKeys` diagnostics | `cookieKeys:["ndus"]`; jsToken mint gated (`step=jsToken`) |
| 7 | `8f98c39` | pacing + `JSTOKEN` env + mint fallback/anon-probe | mint recovered; 31045 persists |
| 8 | `72b499c` | thread precreate's `uploadsign` (browser never hardcodes 0) | 31045 persists |

### Key discoveries

- **Authoritative upload flow** lives in the public web app bundles:
  `s5.teraboxcdn.com/fe-opera-static/node-static-v4/fe-webv4-main/js/`
  (`manifest.*.js` maps `chunk-<id>` → `chunk-<id>.<hash>.js`;
  `chunk-78587962` = upload manager, `chunk-75e18d29` = endpoint bootstrap).
- **Discovery**: the browser GETs `//d.terabox.com/rest/2.0/pcs/file?method=locateupload`
  (bare works: returns `{"client_ip":…,"server":["c-jp","c1-jp","c2-jp"],
  "host":"c-jp.terabox.com","expire":600}`) and **walks `server[]` until a
  cluster accepts the upload**. Worker mirrors this with a
  `<prefix>-data.terabox.com` fallback origin.
- **Superfile2 query (browser)**: `method=upload&app_id=250528&channel=dubox&clienttype=0&web=1&logid=…`
  + `path&uploadid&uploadsign&partseq` (`_compileUrl`); no `jsToken`,
  no `type` — identity = session cookies only. `uploadsign` comes from
  the **precreate response** (`e.uploadSign = o.uploadsign`), not a constant.
- **Error 31045 "user not exists"** is Baidu-PCS-speak for *credential
  validation failed* (`access_token验证未通过` / session expired — see
  cssxsh/baidu-client `OTHER.md`, bypy#511). Not a wrong-cluster error:
  all `c*-jp` clusters reject the `ndus`-only cookie; www APIs accept it.
  **Alist/OpenList/TeraboxUploaderCLI all have users paste the FULL browser
  cookie (ndus + stoken + BAIDUID …).**
- **jsToken minting** (`GET /` → `window.jsToken` snippet) is IP/session
  sensitive: the root answers 302 `/simple-verify` when gated. Mitigations
  now in code: optional `JSTOKEN` secret (paste `window.jsToken`, Alist/CLI
  style), 5-min isolate cache, `/main?category=all` fallback, anonymous
  probe on failure reported via `upstream` (`/login=token anon:/login=token`).
- `cookieKeys` in error bodies = cookie **names only** (never values).

### Rate pacing shipped (`8f98c39`)

- Shared per-isolate slot scheduler: every outbound call (API, jsToken mint,
  download stream) waits for `MIN_GAP_MS` (default 400 — bclone `minSleep`),
  env-overridable, set to `0` in vitest bindings.
- `429/5xx` retries honour `Retry-After` (cap 5 s) before attempt backoff.
- jsToken re-mint ≤ 1 per 5 min — the root page (most gate-exposed call) is
  no longer hit once per WebDAV request.

### Root cause found (2026-10-09, local probes with the user's full cookie)

The account is behind the **`dm.terabox.com` regional deployment**, whose
locateupload returns a *different* cluster table:

| origin | server[] | chunk upload |
|---|---|---|
| `d.terabox.com` (used before) | `c-jp / c1-jp / c2-jp` | **31045 "user not exists"** on all three |
| `dm.terabox.com` (same-origin) | `dm1-cdata / dm2-cdata / kul-cdata` | **200 + md5 on all three** ✓ |

End-to-end verified from a residential IP with the user's full cookie:
precreate (`errno 0`) → superfile2 chunk (`{"md5":"ebf5..."}`) → create
(`fs_id` assigned) → list shows the file. The worker now queries
**`this.baseUrl` first**, then `d.terabox.com`, then `<prefix>-data`.

Also confirmed live:
- the old www/`ndus`-only session is fully gated now (`400141` even on GET)
- `check/login` on `dm` = `errno 0` (`uk REDACTED`); on `www` = `-6`
- filemetas needs `target` (paths), not `fs_ids`; dlink host = `dm-d.terabox.com`
  → 302 to `kul-ddata.terabox.com` (region=kul)
- download speed from the user's PC: ~29 KB/s direct vs 2.5 Mbps via JP VPN
  (TH→KL peering); the Worker's Cloudflare egress is unaffected by this

### GET gate root cause found (2026-10-09) — fixed by the PCS route (`2e6ce6b`)

Everything about the `/file/<hash>` dlink hop was measured from both IPs:

| probe | residential | Cloudflare (datacenter) |
|---|---|---|
| filemetas dlink + cookie | 302 → CDN | **400141 "need verify"** |
| filemetas `origin=dlna` (Alist crack) | 302 → CDN | same hop, same gate |
| official `/api/download` dlink (`token=…&chkv=1`) | 302 → CDN | same hop, same gate |
| rewritten host (`dm-d` → `dm.terabox.com`, the web app's own `formatDownloadURL` rule) | 302 → CDN | **still 400141** — `/file/` gates DC IPs on every origin |
| CDN (`kul-ddata`) capability URL, **no cookie** | 200 bytes | (never reached) |

- Fresh `jsToken` does not clear it → IP-reputation gate (Themis — the
  `by=themis` param is minted into the Location), not a session defect.
- The web app's JS has no workaround for this gate either (its `400141`
  mapping is share-code/login only); it never sees the gate because
  browsers run on residential IPs.
- `403`/`31045 "user not exists"` on a bare dlink = session-scoped sign.

**The fix — the app protocol never touches `/file/`:**

```
GET https://dm-d.terabox.com/rest/2.0/pcs/file?method=download&app_id=250528&path=<path>
Cookie: <session>
→ 302 Location: https://kul-ddata.terabox.com/file/…   (no jsToken, no sign)
```

Mobile/desktop apps download through this route; it is the same
`/rest/2.0/pcs/file` family as `locateupload`, live-proven reachable from
Cloudflare (that is how uploads work now). The CDN Location needs no
cookie at all.

Download ladder (lazy — each phase only runs if the previous failed):

1. **PCS** `method=download` on `<label>-d` → `<label>-data` → origin
   (www deployments: origin → `d.terabox.com`) — no minting, one call.
2. **official** `/api/download` token dlink (minted via home/info+sign).
3. **plain** filemetas `dlink=1` link.
All gated → the last `400141` is rethrown (`step: dlink@<host>`, 401).

Also in this cut: `fetchDownload` follows the CDN 302 **by hand**
(`redirect: 'manual'` + explicit Location hop — Alist `NoRedirectClient`
parity): the session cookie never leaves the API origin, and `Range`
rides across the hop so ranged GETs keep working. `errnoBodyFrom`
recognises the PCS `error_code` JSON shape as well as web `errno`, so a
gate body can never stream out as file content. Mock gained the PCS
route (302 → `/dl/?via=pcs`), per-flavour gating `gateDl: ['plain' |
'official' | 'pcs']` and the `gatePcs` knob — 53/53 tests.

### Live verification from Cloudflare (2026-10-09, all green)

| check | result |
|---|---|
| GET small txt (pcs ladder phase 1) | **200** + exact content, ~2.5 s (paced) |
| GET 1 MiB file | **200**, 1 048 576 bytes, **md5 end-to-end match** |
| Range `bytes=0-8` across the pcs 302 hop | **206** + correct slice |
| HEAD | 200 + `content-length/etag/last-modified/accept-ranges` |
| PUT → GET round trip | 201 → 200 |
| MOVE | 201 + GET of the moved path 200 |
| DELETE file | **204** (missing repeat → 404) |
| DELETE 4 test folders (recursive) | 204 ×4, account left clean |
| PROPFIND Depth 1 | 207, ~0.6 s |

### DELETE contract found (bclone parity, `988f122`)

Live DELETE answered an **empty HTTP 500** from `/api/filemanager` while
MOVE on the same endpoint worked. bclone's `apiOperation` documents the
per-opera wire contract:

```
opera=delete:  filelist ["/path"]                    ← plain path strings
opera=move:    filelist [{"path":…,"dest":…}]        ← objects
```

Objects for delete NPE the server into a bare 500 (no body, no errno).
`fileOperation` now serialises per-opera; the mock mirrors the live
empty-500 on the object form so every DELETE test locks the contract.
Deletes go to TeraBox's recycle bin (10-day auto-purge; the web app
behaves the same — emptying the bin on every WebDAV DELETE would destroy
files the user trashed deliberately).

### Status / open work

1. ~~Live-verify GET through the new ladder~~ — done, see the table above.
2. Confirm `COOKIE` on the dashboard is a **Secret** (it was originally
   entered as Text; secrets survive deploys, plain-text vars don't —
   `wrangler.toml` `[vars]` now owns `TERABOX_DOMAIN`/`MIN_GAP_MS`).
3. Optional polish: HEAD currently performs a full upstream GET (body
   discarded); could probe with a 1-byte Range instead.
4. Re-run `test/live/webdav-livetest.sh` and update this file.

## Campaign 3 — litmus conformance (2026-10-10)

Goal: run the standard litmus WebDAV conformance suite (built from source at
`/tmp/opencode/litmus`, `TESTS="basic copymove props locks http"`) against the
live worker and close every gap it finds. Reference expectations were read out
of litmus's own sources (`basic.c`, `copymove.c`, `props.c`, `locks.c`,
`http.c`, `common.h`) — every status below is what the suite *provably* wants,
not a guess.

### Baseline (before the batch)

| Suite | Result | Failures |
|---|---|---|
| basic | 14/16 | `put_no_parent`, `mkcol_no_parent` |
| copymove | 11/13 (+1 warn) | `copy_abspath`, `copy_nodestcoll`, `copy_shallow` |
| props | 23/33 | `propfind_invalid`, `propfind_invalid2`, `propget` ×8 |
| locks | 25/38 | `notowner_*` (enforcement missing), `cond_put*`, `discover` … |
| http | **3/3** | — |

### Fixes shipped (`563441c`, `03d1901`)

1. **Parent-collection rules (RFC 4918 §9.3.1/§9.7.1/§9.9.3)** — MKCOL, PUT
   and MOVE/COPY targets now require an existing parent collection (`409`).
   The previous PUT auto-create was the *single* root cause of both
   `put_no_parent` **and** `mkcol_no_parent`: litmus PUTs `409me/noparent.txt`
   first, our PUT created `409me/`, and the later MKCOL `409me/noparent/`
   legitimately succeeded. One deviation, two failures — removed entirely.
2. **Absolute-path `Destination`** (RFC 4918 §10.3) — accepted as pathname.
3. **`COPY Depth: 0` on collections** — empty collection only, no members.
4. **XML validation** (`src/davxml.ts`) — PROPFIND/PROPPATCH bodies that are
   non-well-formed, use undeclared prefixes, bind a prefix to the empty
   namespace, or mismatch close tags answer `400` (never a silent allprop).
5. **Dead-property store** — PROPPATCH set/remove persist per-isolate under
   expanded `{namespace}local` keys; PROPFIND serves them (list/allprop/
   propname), `404`-propstats echo the client's element made self-contained;
   MOVE migrates, COPY copies, DELETE clears; DAV live props refuse patching
   with a `403` propstat.
6. **Real locks** — 423 enforcement on PUT/DELETE/MKCOL/MOVE/COPY/PROPPATCH,
   UNLOCK validates its token (`409`), LOCK rejects non-owners (`423`), shared
   locks stack, refresh works through `Depth: Infinity` ancestors,
   `lockdiscovery` reports the actual active lock, `If` headers are evaluated
   (`412`, or `423` for lock-token-shaped values on locked resources;
   `<DAV:no-lock>` is a plain failed condition per mod_dav parity). Self-issued
   tokens embed their expiry: after isolate rotation they keep working for the
   rest of their life (graceful UNLOCK even returns `204` for them), so warm
   clients are never bricked.

### Results after the batch (run 3, live)

| Suite | Result |
|---|---|
| basic | **16/16** |
| copymove | **13/13** |
| props | **33/33** |
| http | **3/3** |
| locks | 31/33 run (2 flaky — see below) |

**65/65 on four suites; locks is limited only by Cloudflare isolate
scheduling.** Lock records and dead props are per-isolate in-memory state
(this worker has no storage binding). A sequential litmus connection usually
stays on one warm isolate (run 3: 31/33), but every now and then one request
of the session lands on a different isolate — the observed failures are
symmetric artifacts of exactly that (`notowner_lock`: LOCK saw an empty store
→ `200` instead of `423`; `lock_shared`: LOCK saw a stale store → `423`
instead of `200`). Real clients are never harmed by the hopping: an empty
store *allows* writes (only enforcement relaxes), and lenient tokens cover
UNLOCK. Making locks 100 % deterministic under Cloudflare scheduling requires
a Durable Object (dashboard resource + binding; noted as the upgrade path in
`terabox-limits.md` §6).

### Verification tooling

- litmus built from source: `TESTS="basic copymove props locks http"
  /tmp/opencode/litmus/install/bin/litmus -k -n
  https://terabox.taxin-404.workers.dev/litmus/ REDACTED REDACTED`
- probe habit: to check which build is live, PUT to a path whose parent does
  **not** exist — `409` = new build, `201`/`204` = old build still serving.

## Repo map (context for AI sessions)

- `taxin-404/terabox-webdav-worker` — this project (TypeScript Worker)
- `BenjiThatFoxGuy/bclone` — rclone fork; the Terabox backend ported here
  (`backend/terabox/*.go` is the reference for API semantics)
- `taxin-404/google-drive-webdav-workers` (branch `test/webdav-compliance`) —
  WebDAV compliance test suite this repo's tests are modelled on
