# Live testing notes

State of the live-test campaign against the deployed worker. Update this file
after every campaign so future sessions (human or AI) start with context.

## Target

- Worker: `https://davbox.tes1ing.workers.dev/` (every push to `main` is built
  and deployed automatically by Workers Builds, ~30 s after the push — see
  "Repo map")
- Credentials: WebDAV basic-auth test pair **`test:test`** on the `tes1ing`
  deployment (the retired `crazy-gooner-mf` free domain is now a Cloudflare
  404 `error code: 1042`; `test:911` only ever answered there, so a probe
  aimed at it validates nothing). The pair ships as a default in
  `scripts/live-smoke.sh` / `scripts/live-litmus.sh`. Test-only — it is
  stored in the `USERS` secret, never changes again, and gets deleted
  together with the project when all work is done;
  the **Terabox session cookie + jsToken are env-only and never committed** —
  pass via `COOKIE`/`JSTOKEN` (and `USER_CRED` to override the test pair)
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
`npm install` once (`.npmrc` pins `legacy-peer-deps` for both local and CI installs), then `npm test` / `npm run typecheck`.

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
  cookie (ndus + stoken + BAIDUID …).** — **superseded 2026-10-11**: a
  cookie with no `stoken` ran precreate → superfile2 → create to `errno 0`
  on the `dm*` cluster; the `31045`/cluster rejection is an origin problem,
  not a missing `stoken` (see "Root cause found" below).
- **jsToken minting** (`GET /` → `window.jsToken` snippet) is IP/session
  sensitive: the root answers 302 `/simple-verify` when gated. Mitigations
  now in code: optional `JSTOKEN` secret (paste `window.jsToken`, Alist/CLI
  style), 5-min isolate cache, `/main?category=all` fallback, anonymous
  probe on failure reported via `upstream` (`/login=token anon:/login=token`).
- `cookieKeys` (server log only, after the round-17 review) = cookie **names
  only**; error bodies carry `errno`/`step` and never upstream text or cookie
  metadata.

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
- `check/login` on `dm` = `errno 0` (valid `uk`); on `www` = `-6`
- filemetas needs `target` (paths), not `fs_ids`; dlink host = `dm-d.terabox.com`
  → 302 to `kul-ddata.terabox.com` (region=kul)
- download speed from the user's PC: ~29 KB/s direct vs 2.5 Mbps via JP VPN
  (TH→KL peering); the Worker's Cloudflare egress is unaffected by this

### GET gate root cause found (2026-10-09) — fixed by the PCS route (`bb58ba2`)

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

### DELETE contract found (bclone parity, `6490bac`)

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

### Fixes shipped (`f7e66c8`, `af43e24`)

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
stays on one warm isolate, but occasionally a single request of the session
lands on a different isolate — and since each run reuses leftover state, the
artifacts cascade (one hop can poison a later test on the original isolate).
Five measured runs: full suite 31/33 and 35/38; locks-only reruns 39/40,
23/25, 38/40 — i.e. **~1–2 random misses per run, never the same test twice**
(e.g. `lock_excl` itself saw a stale record once and answered `423` instead
of `200`), and no ordering that a protocol-logic bug could produce. Real
clients are never harmed by the hopping: an empty store *allows* writes
(only enforcement relaxes), and lenient tokens cover UNLOCK. Making locks
100 % deterministic under Cloudflare scheduling requires a Durable Object —
**done in Campaign 4 below** (`f2302d3`).

### Verification tooling

- litmus built from source (binaries in `/tmp/opencode/litmus/`). Use the
  repo runner — it targets the
  **`/dav/litmus/`** collection (a root-level `/litmus/` 404s; the suites
  MKCOL `/dav/litmus/litmus/` and need the parent) and pre-flights the worker
  instead of hammering a dead quota:

  ```sh
  ./scripts/live-litmus.sh        # SUITES="basic copymove locks http props protected lockbomb"
  ```

  **Quota:** quota death was observed within minutes of a litmus-heavy
  window (accumulated same-window traffic may also contribute) — every
  request then 500s with `Exceeded allowed rows written…`. 00:00 UTC is the
  guaranteed reset; one 2026-10-12 window recovered mid-window (500 → 207
  within 25 min), so probe ONCE before declaring it dead, never retry-loop.
  At most one litmus run per quota window, smoke first.
- probe habit: to check which build is live, PUT to a path whose parent does
  **not** exist — `409` = new build, `201`/`204` = old build still serving.

### rclone end-to-end (v1.75.2, live)

Real-client proof on top of litmus (`vendor = other`, RFC-strict flow):

| step | result |
|---|---|
| `mkdir` tree, `copy` (2 parallel transfers, 1.3 MiB total) | ✓ |
| `ls` | 4 objects, correct sizes |
| `check --download` | **0 differences, 4/4 files md5-matched** |
| no-op `sync` | 0 differences |
| append + `sync` + `check --download` | 4/4 matched again |
| `moveto` (WebDAV MOVE) | ✓ |
| `size`, `delete` | ✓, empty after |

### Cleanup

Live test directories purged through the worker after the campaign:
`/litmus/` (litmus base), `/conf-test/`, leftover probe dirs from earlier
batteries (`/probe/`, `/livetestlive/`, `/livetest3/`) and the empty
`/rclone-test/`. Account root holds only real user data again.

## Campaign 4 — Durable Object-backed state, litmus 105/105 (2026-10-10)

The only failure left after Campaign 3 was environmental: lock/dead-prop
state lived in per-isolate memory, so the occasional litmus request that
Cloudflare routed to a different isolate saw a stale or empty store
(~1–2 random misses per run, never the same test twice).

### Implementation (`f2302d3`)

- New `src/davstate.ts`: a `DavStore` interface with two implementations
  backed by **one set of pure core functions** (semantics cannot drift):
  - `RemoteDavStore` + `DavState extends DurableObject` — one serialized
    instance per account (`idFromName('terabox-dav-state')`), write-through
    SQLite storage, JSON routes (`/tokens`, `/lock`, `/unlock`, `/describe`,
    `/patch`, `/relocate`). Every worker isolate talks to this single
    object, so scheduling becomes irrelevant to lock semantics.
  - `MemoryDavStore` — the previous maps, used automatically when no
    binding is present (tests, fallback).
- `src/webdav.ts` refactored onto async store calls; HTTP behavior is
  byte-identical (the 125-test suite passed unchanged on the first run).
- `index.ts` re-exports `DavState` (required for the binding) and passes
  `createDavStore(env)` per request; `env.DAV_STATE` is optional.
- `wrangler.toml`: `[[durable_objects.bindings]] name = "DAV_STATE"` +
  a live `[exports.DavState]` entry (`type = "durable-object"`,
  `storage = "sqlite"`). **No `[[migrations]]` block**: the class was
  pre-created in the dashboard (namespace `dav-state`), and
  `new_sqlite_classes` would be rejected as a duplicate — a binding to an
  existing class needs no migration. Wrangler also rejects
  `existing_sqlite_classes` (unknown field since 4.146).

### Results (live, after deploy)

| Run | Result |
|---|---|
| locks ×1 | **40/40** |
| locks ×2 | **40/40** |
| locks ×3 | **40/40** |
| full (basic/copymove/props/locks/http) | **16/16 · 13/13 · 33/33 · 40/40 · 3/3 = 105/105** |

For comparison, the per-isolate build produced **zero** clean locks runs in
five measured attempts (31/33, 35/38, 39/40, 23/25, 38/40). Three
consecutive perfect runs plus a perfect full suite = the flake is gone;
**litmus is now 105/105 with zero failures and zero warnings.**

### Cleanup

`/litmus/` purged again through the worker after the campaign (204); account
root verified to hold only user data (BackupFolder, backup, entertainment,
hacking, mern, omacom, tools).

## Campaign 5 — live mount campaign: path fix, metadata cache, davfs2 model (2026-10-10)

Scope: end-to-end testing through a real davfs2 mount of the live worker,
prompted by two field reports — files with `+` in the name 404'd for davfs2,
and large-file reads through the mount "hung forever".

### Fixes shipped

- `440f809` — `decodePathname` applied form-encoding (`+` → space) to URL
  *path* segments; a literal `+` in a file name (e.g. `Hindi 5.1+English
  5.1...mkv`) broke lookup for every client that sends it raw (davfs2,
  browsers). Now plain `decodeURIComponent` per RFC 3986 (drive-worker
  parity). Live-verified after deploy: raw-`+` GET 404→206, PROPFIND 404→207.
  Five regression tests (raw `+`, `%2B`, `%20`, PROPFIND hrefs, MOVE).
- `440f809` — lockdiscovery used `Math.floor` of the remaining ms, so a
  fresh `Second-3600` lock intermittently rendered `Second-3599` (observed
  2/5 runs); `Math.ceil` makes it deterministic (130/130 ×3).
- `d9d4ea9` — read-path metadata cache (Google Drive worker parity, 60 s
  TTL). Every read paid a paced `filemetas` round-trip (~0.7-0.9 s of the
  ~2.4 s measured per request), and davfs2 stats paths constantly. The
  dlink-flavoured fill is shared by `statResource` and `handleGet`; writes
  invalidate exact path + subtree + parent; negatives are never cached;
  `resetDavVolatileState` clears it for test isolation. Live proof: first
  PROPFIND of a never-touched path 482 ms → second 105 ms (pure cache).
  136/136 tests.

### davfs2 behaviour: the "hang" is a design property, not a wedge

> Follow-up deep dive (full strace, per-window byte accounting, request-record
> forensics, then a connected `wrangler tail` + `journalctl` third pass): the
> 1.1 GB re-open "hangs" were **repeated whole-file re-downloads caused by
> davfs2's client-side `cache_size` default (50 MiB)** purging the large file's
> own cache entry while it was still open — every later open then restarted
> from zero. Root cause observed on the wire, fix is config
> (`cache_size` above the largest file), plus RFC 7233 hardening shipped
> separately. Full evidence and write-up:
> `docs/davfs2-etag-hang-investigation.md`.

Established from the davfs2 source (Debian sid tree) plus a full `strace -f`
of the live daemon during a mount read:

- davfs2 **never sends `Range` requests** (none in its own code; neon's
  `bytes=%ld-%ld` strings are unused capability). `open()` performs **one
  whole-file `GET`** — revalidated with `If-None-Match` after
  `file_refresh` (1 s; the worker answers `304`, so cached re-opens are
  free) — streamed into the local cache file (`update_cache_file` →
  `dav_get_file` → `file_reader`); every later read is a local `pread`.
- The FUSE loop is **single-threaded**: a large `open()` blocks the entire
  filesystem until the download completes. A 1,126,762,632-byte video
  measured **515 MB in 348 s ≈ 1.5 MB/s** through the worker (strace cache
  writes `write(6,…)` accounting), i.e. `open()` ≈ 12 minutes — during
  which even `stat` of *other* files queues behind it. That is the entire
  "wedge" story: earlier "zero packets" observations were filter artifacts
  (`ss` matched only the worker-edge IP; the stream goes to the TeraBox
  CDN host) and one broken tail session.
- `lost+found/` in the mount view is a davfs2 built-in
  (`DAV_BACKUP_DIR` in `defaults.h`) for failed uploads — it exists only
  in the client's view, never on the server.

### Client-side facts (now in README "davfs2 usage")

- Non-root mounts need an `/etc/fstab` `user` entry **and** membership in
  dav_group (`network` on Arch); `mount(8)` appears to drop supplementary
  groups in the helper chain — making `network` the *primary* group is the
  reliable fix.
- `mount.davfs` refuses to run non-setuid (`geteuid() != 0` → abort), so
  debug tracing requires `sudo strace -f`.
- Secrets format is whitespace-separated `URL user password`; this build's
  parser (`read_secrets`/`parse_line`) does **not** split `user:pass` on a
  colon — such a line parses as username-only and triggers the interactive
  password prompt (EOF → SIGABRT when no tty).
- Defaults worth tuning for a snappy mount: `cache_size 2048` (50 — **mandatory
  above the largest file**, see below), `buf_size 64` (16),
  `delay_upload 0` (10), `gui_optimize 1` (0), `use_locks 0` (1).

### Live session results (through the mount)

- Healthy read: `bookmarks_7_23_26.html` (26,698 B) in 3.9 s, byte-identical
  to a direct GET.
- `+`-named video: 206/207 via direct HTTP; ~1.5 MB/s whole-file stream
  through the mount (progress proven live in the daemon trace).
- Write probes (server-verified via direct API): MKCOL/PUT/file-MOVE/dir-MOVE
  201/204, deletes clean; rename issued milliseconds after create returns EIO
  (davfs `delay_upload` interplay, server state correct either way).
- `wrangler tail` proved flaky this session (two sessions captured
  zero bytes); the daemon-side `strace` was the reliable channel.

### Root cause closed: davfs2 `cache_size` purge (2026-10-10, third pass)

The large-file re-download loop (the "hang" above) was pinned to the **client,
not the worker**, by three direct observations:

- **`wrangler tail --format json`** (reconnected, backgrounded with stderr
  captured) observed the worker answering **`status: 200` + ETag** to the
  daemon's no-Range GETs — never a `206`. The daemon's bare requests were bare
  because a *purged cache file* sends the next open down davfs2's
  **fresh-download branch** (`cache.c:2696-2706`), which passes a local `NULL`
  etag by design — no `If-None-Match`, full body, from zero. No bad status
  was ever involved.
- **`journalctl -g 'max cache size'`** showed **ten purges** that day, each
  shortly before a fresh full-download episode; the strace caught one live:
  the daemon's own syslog line `open files exceed max cache size by 1025
  MiBytes`, then `unlink()` of **every** cached file within 15 ms — including
  the still-downloading large file's own entry (the open fd keeps the
  unlinked inode alive, so the in-flight download "completes" into a file
  that no longer exists).
- **Arithmetic pins the limit to the default**: file 1074.5 MiB − 1025 MiB
  over = **49.6 MiB ≈ the built-in `cache_size 50`** (the `/etc` conf ships
  that line commented out; nothing on the box set it).

Complete loop: open large file → whole-file `GET` into cache → tidy deletes it
(limit 50 MiB) → next open finds no cache file → fresh branch → bare full
`GET` → repeat, forever. Small files (< 50 MiB) kept their cache entries,
which is why they always revalidated (`304`, zero bytes) and masked the bug.

**Fix (config, no code):** `~/.davfs2/davfs2.conf` sets `cache_size 2048`
(MiB). **Verification recipe** (needs a remount to take effect): mount as the
user (the fstab entry reads `~/.davfs2/davfs2.conf`; a *root* mount reads the
`/etc` file instead), open the big file once (one final full download), then
re-open → expect an instant open, **zero** cache-write `write(6,…)` calls in
the daemon trace, and a quiet `journalctl -g 'max cache size'`.

The 206/etag footgun chased in the earlier passes is real (source-verified: a
successful non-`200` frees davfs2's stored etag) and is fixed on `main`
since `d065d53` as RFC 7233 §4.1 conformance hardening — defence-in-depth, not this
incident's cause. Full write-up: `docs/davfs2-etag-hang-investigation.md`.

## Campaign 6 — review rounds 4–6 + 4 GB upload proof (2026-10-11)

Second-opinion subagent reviews (rounds 4–6) against the live worker; every
finding fixed, revert-verified (surgical reverts → pinned failing tests), and
deployed (`7a370940`, 277 tests green, gate = `npm run review`).

**Round 4 (write path):** MOVE onto an ancestor → 409 with source intact;
protocol-relative `Destination: //evil` → 502; errno −11/−12 → 409, −22 → 403
(never a bare 500); conflict policy forced server-side (client `rtype`
ignored; `existed ? 3 : 0`); chunk `Content-Length` precheck; fresh metadata
at every write precondition. Batch 2: chunk failover gate widened to
`error instanceof TeraboxError` (200-with-no-md5 no longer aborts the host
ladder); `/meta-gen` DO route persists one key, not the whole state; **atomic
finalize claim** (`UploadSession.finalizing`, `/upload-claim` +
`/upload-claim-release`, 16×500 ms busy-poll, claim released on every exit) —
concurrent finalizes both answer `201`, retries replay the original status;
`safeRelocate` retries 3×; `DELETE /.resumable/:id` cancels a session
(204 / 404).

**Round 5 (read path):** `xmlEscape` sanitizes C0/PS chars → U+FFFD and
`validateXml` rejects raw control characters (hostile PROPPATCH/LOCK → 400;
PROPFIND output parses under a strict parser); `safeMtimeSeconds` (bogus mtime
→ 0: no RangeError 500, no header-hostile etag); GET/HEAD
`If-Match`/`If-Unmodified-Since` → 412; every 405 carries `Allow`; `bytes=`
range regex case-insensitive + canonicalized before upstream; If-Range requires
an exact date/strong-etag match; md5-less etags weak (`W/"…"`), If-None-Match
normalizes weak prefixes.

**Round 6 (auth/status/headers/session):** **H1** — the errno −6 re-root is
bounded (`rerooted` latch + no-op-host refusal; it previously recursed without
limit until the subrequest budget or client timeout); `AUTH_ERRNOS` is one set
shared by `statusFor` and the 401 challenge (−1/6/−19 → 401+challenge,
4/2 → 400, 5 → 409, 7/11 → 403, 15 → 502 — live control-char MKCOL now 400);
a fresh minted token outranks a stale env `JSTOKEN`, with a single in-flight
mint per isolate; CORS preflight fails closed to 401 (no unauthenticated
branch); `USERS` parsing is all-or-nothing (`bob:h,unter` → config 500, never
a silently truncated credential); the `.resumable` control plane is
shape-gated after path decoding (a real `.resumable` file lists and fetches at
its own href; begin/chunk/cancel/finalize stay owned); relative `Destination`
strips `?query`/`#fragment`; `X-Content-Type-Options: nosniff` on every
response plus a sandbox CSP on file GET; branchless credential compare (no
username-existence timing oracle); pacing comments now state per-isolate truth.

**4 GB upload proven live:** 1024 × 4 MiB chunks through the resumable API →
`201`, remote size exactly `4294967296` (free-tier ceiling
`MAX_FREE_FILE_BYTES = 4 GiB`), range GET 206, ~23 min (bandwidth-bound), then
deleted. Nautilus integration ships as
`~/.local/share/Nautilus/scripts/Upload to Terabox` (right-click → Scripts →
upload) driving `tbbig` — gvfs' native PUT still dies at Cloudflare's ~100 MB
body cap, so large files go through the script. No R2 anywhere: 4 MiB chunk
requests + the DO already cover any size, and S3 staging would not help gvfs.

Deferred (user decisions): taskid `async=1` confirmation (deliberate bclone
parity), uploadId nonce (would break the `tbbig` client).
~~account password rotation~~ **done 2026-10-12**: rotated to `test:911`
(test-only pair in the `USERS` secret; deleted together with the project
when all work is done — no further rotation planned). **2026-11-12:** the
`tes1ing` deployment carries `test:test`; `test:911` now only answers on the
retired `crazy-gooner-mf` domain, so any probe pointed there validates the
wrong worker.
~~DO-backed cross-isolate pacing~~ shipped
2026-10-11 (the DAV_STATE DO `/api-slot` route serializes the reservation
account-wide; the isolate floor is the backstop).

## Campaign 7 — the website: file manager, downloads-only, session sign-in (2026-10-12)

The in-page file viewer grew into a small file manager and then got
hardened as a **backup surface** (the user's framing: this is a serious
backup option, so uploads/downloads must be bulletproof and credentials
must never strand a transfer).

**File manager (`3582d03` → `d24dcd25`):** new folder (MKCOL), rename
(MOVE + `Overwrite: F`), delete (confirm), refresh, status-bar feedback,
row actions on touch; upload via XHR with real progress — fixed bottom
strip + toolbar chip (`name · 31%` → `100% · finishing…` → `✓ uploaded`),
`body.uploading` padding via MutationObserver; `..` parent row (hidden at
mount home); kind-colored badges; server MIME widened (+14 types) with a
client/server list-alignment pin.

**Downloads-only (`4b1ef7e`):** previews are gone — no drawer, no
`img-src`/`media-src` in the viewer CSP. Every file GET answers
`Content-Disposition: attachment` (ASCII fallback + RFC 5987
`filename*=UTF-8''…`), so a browser click or raw URL always downloads;
WebDAV clients ignore the header. Viewer CSP tightened to
`form-action 'self'` (sign-out form) and the viewer carries
`Cache-Control: no-store` + `Vary: Accept` as before. Litmus/smoke are
unaffected (they never send `Accept: text/html`).

**Session sign-in (`4b1ef7e` → live `b5fcb71a`):** closes the credential
persistence hole — Basic auth prompts are not cached, so closing the tab
orphaned in-flight PUTs as bare `network error`s. Now an unauthenticated
browser navigation (GET, accepts HTML, no `Authorization` presented) gets
a sign-in page instead of a 401:

- `POST /.dav-login` (form-encoded `user`/`pass`/`next`) → `303` +
  `Set-Cookie: davbox_session=…; HttpOnly; Secure; SameSite=Strict; Path=/;
  Max-Age=2592000` (30 days). The token is HMAC-SHA256 over
  `b64url(user)|exp` keyed by the **raw USERS string** (rotating USERS or
  deleting a user kills sessions) and re-checks the user still exists.
- Auth gate: Basic first (clients/scripts unchanged — wrong Basic still
  gets `WWW-Authenticate`, every non-browser method still 401), then the
  cookie. Only the browser-with-no-credentials path sees the form.
- `POST /.dav-logout` clears the cookie (idempotent; `next` falls back to
  the same-origin Referer for the no-JS form). Token is stateless — what
  makes logout real is the browser dropping the cookie.
- Abuse controls: `Sec-Fetch-Site: cross-site` (or other hostile value) →
  403, 8 KB body cap → 413, 400 ms delay on failed login, `sanitizeNext`
  kills `//evil` open redirects, endpoints are POST-only (405 + `Allow`).
- The page shows the sign-out button only for cookie sessions
  (`data-session="1"`); Basic-authenticated page views keep it hidden.

**Verification:** gate **387/387** (+15: session-login describe,
attachment pins, CSP pins; the unauth-401 pin became "form for browsers /
401+challenge for WebDAV"), live smoke **34/34** on `b5fcb71a`, and a
fresh-profile Chromium run (`/tmp/opencode/viewer-login-e2e.tmp.mjs`,
**18/18**, no injected auth headers): login page deep-links `next`, wrong
password → error + no cookie, sign-in → viewer + hardened cookie
attributes, upload chip → `✓ uploaded` → row appears, fetch sees the
attachment header, real download lands with matching bytes while the
page stays put, a brand-new tab after closing the first is still signed
in, sign-out → form again + cookie gone. Screenshots:
`/tmp/opencode/up/login-{page,viewer,upload-mid,upload-done,newtab,after-logout}.png`.

**Big files in the browser (`8635196` + `4b79810`, live `eabbf04e`):**
the page's single XHR PUT could never exceed Cloudflare's ~100 MB
per-request body cap (a platform 413, not a Terabox limit), so uploads
over 64 MiB now switch to the worker's resumable control plane —
`POST /.resumable` begin (mount-relative JSON path — sending the URL path
409s on a bogus upstream parent — plus `If-None-Match: *` for the same
create-only/confirm-to-replace handshake as PUT) → 17 × 4 MiB chunk PUTs
with per-byte chip progress (capped at 99% until finalize) → finalize
201/204, `DELETE` of the session on any failure. Real-browser proof
(`/tmp/opencode/big-upload-e2e.tmp.mjs`, **5/5**): 68 MB file, create →
412 → confirm → replace → chunks → finalize → listing, HEAD
byte-exact 68,000,000. Two harness traps fixed en route: `body.textContent`
matches the page's own script source (the `'✓ uploaded'` literal lives in
the inline script — poll the chip *element* instead), and a faulty
test-file generator that wrote 69,048,576 bytes while asserting 68,000,000.

**UI retheme + layout polish (`2d1071d` + `c6c5115` + `e42c6f0`, live `da0faade`):**
the near-black + vermilion palette read as an AI template, so the viewer
and sign-in page were rethemed to petrol/brass (void `#0C1617`, brass
`#E3A857`, jade/coral accents): brass mono path segment and Upload button,
brass folder icon and login card top edge, borderless lowercase kind
badges, dashed empty-state tray, and guarded hover states
(`(hover: hover) and (pointer: fine)` — row wash, name-link brass
underline, actions reveal; touch keeps actions visible). Three bugs
surfaced in screenshot review and were fixed: auto table layout let long
names min-content-expand past the viewport, pushing the actions column
off-screen on narrow screens (fixed → `table-layout: fixed` with sized
Size/Modified/Actions columns so names ellipsize); lone wrapped Sign out
left-aligned oddly (`margin-left: auto`); and a failed login cleared the
username field (the error re-render now prefills it, HTML-escaped).
Verified live in headless Chromium at 390 px: longest name truncates,
actions column fully on-screen, sign-out right-aligned, prefill holds.

Harness gotchas discovered (live-only, invisible to unit tests): workers'
`fetch` has no cookie jar — tests asserting `Set-Cookie` on a `303` must
send `redirect: 'manual'` or they chase the redirect unauthenticated;
headless Chromium **wedges the whole tab** on the page's overwrite
`window.confirm` unless a `page.on('dialog')` handler answers it (the 412
create-only PUT fires it whenever the artifact name already exists); and
the live mount has no `docs` folder — harness paths go under `/dav/`.

## Campaign 8 — premium-tier limits: what changed at upgrade (2026-10-17)

The account behind the worker's `COOKIE` became **premium** (`member_info.is_vip`
live-verified today through `checkPremium()`), so the plan-tier catalog that
only existed as code and bclone citations faced its live test — on a *new*
deployment: the worker now also runs via **Cloudflare Workers Builds** (git
integration, deploy target `davbox` in the `tes1ing` account,
`https://davbox.tes1ing.workers.dev/dav/`, credentials `test:test`). Every push
to `main` built and deployed automatically **while that integration was
attached** — and still does: every push lands a deployment about 30 s later
(see "Repo map" for the correlation). The
`review` gate before push
and the live smoke after still apply. A repo-root `.npmrc`
(`legacy-peer-deps=true`) was shipped first to make CI's strict
`npm clean-install` resolve the same tree local sessions have always used
(wrangler 4.146 wants workers-types ^5; vitest-pool-workers bundles wrangler
4.105, which wants ^4).

### Upload side: the size-cap catalog is live (zero-byte probes)

Via `POST /.resumable begin` — each accepted session canceled (`204`) before
any chunk was sent, so nothing was ever created upstream:

| Probe | Size | Result |
|---|---|---|
| 1 MiB control | 1 MiB | 200 · 4 MiB chunks (both tiers) |
| just over free cap | 4 GiB + 1 MiB | **200 · accepted** → free 4 GiB check bypassed (premium detected). Pre-fix premium bucket: 8 MiB × 513 |
| headroom | 40 GiB | 200 · accepted, 32 MiB × 1280 (top bucket) |
| over premium cap | 129 GiB | **507 · `errno 58` "File is too large for your plan"** — the 128 GiB ceiling |

Live recipe: `bash scripts/premium-limits.sh` (campaign 8's probe battery,
zero bytes uploaded).

### Download side: the free-tier speed cap lifts, shape unchanged

Range GETs (206, exact slices) against two movie files (~380–514 MiB):

| Metric | Free era (2026-10-11) | Premium (today) |
|---|---|---|
| single stream (200 MiB) | ~1.5–2.0 MB/s | **11.2 MB/s** (file A) / **3.7 MB/s** (file B) |
| 4 × 50 MiB parallel | ~same as single (no gain) | 10.5 MiB/s aggregate — **still no parallel gain** |
| cold TTFB | ~2.7 s | 0.4–7.7 s (per-path/cluster variance persists) |
| cached reopen TTFB | 0.12–0.24 s | 0.24 s ✓ |

Per-path cap lifted ~3–6× but stays per-path (per-file/cluster), not one
account-level number.

### The 1102 discovery: premium chunk sizes exceed the free-plan CPU budget

The >4 GiB **byte-proof** (real upload through
`precreate → superfile2 → create`, 4 GiB + 1 MiB staged locally) passed the
gate twice — first at the pre-fix 8 MiB premium bucket (chunks 0–88
accepted, then `503 error code: 1102` = "Worker exceeded resource limits"
streaks from ~chunk 89 on, re-failing persistently at 99–122), then at the
post-fix 4 MiB cap (chunks through ~195 accepted with rising retry noise,
then a persistent 1102 wall at chunk 198; ~78 failing attempts across ~198
chunks). Root cause: the chunk-PUT request cost (streamed 4–8 MiB body +
session bookkeeping + the DO-slot hop) sits near the Workers **free
plan** per-request CPU budget, and the edge kills over-budget requests
sporadically with 1102. Retry ladders absorb blips, but late-session
failure rates rise past what client patience survives.

Shipped while finding this: **`MAX_CHUNK_BYTES`** (`src/sign.ts`
`getChunkSize(fileSize, isVIP, capBytes?)`, default 4 MiB = the free-plan-
proven size; raise on Workers paid plans or via dashboard env to restore the
tier's larger buckets) — `fix: chunk-size cap — premium 8 MiB buckets exceed
free-plan CPU (live 1102)` (`008a2c3`), deployed by the new pipeline, smoke
34/34, and begin-with-the-fix live-verified: the same >4 GiB begin now
answers `chunkSize: 4194304, chunkCount: 1025` (4 MiB, premium account).

**Still open:** the >4 GiB end-to-end byte-proof itself — the 4 GiB free-tier
proof (Campaign 6) stands, premium *acceptance* of >4 GiB is live-verified,
but a full premium byte pass needs a Workers paid plan (see the 31299
finding below: it cannot be dodged by shrinking chunks).
The Playbook: stage a 4 GiB+1 MiB random file, `begin` at that
size, PUT the chunks (the 4 MiB recipe above), finalize, HEAD size match.
Session was canceled (204) and staging cleaned after the 1102 wall.

### The 31299 discovery: TeraBox floors the first full part at 4 MiB

Afternoon follow-up (user brief: free-plan deployments must have a workable
default; paid ones the bigger buckets). Hypothesis: shrink chunks to 2 MiB
to halve per-request CPU and survive the 1102 wall. Shipped `baef326`
(default 2 MiB), deployed, smoke 34/34, and the >4 GiB begin negotiated the
new default live — but **every upload cluster (kul/dm1/dm2) refused chunk 0
with upstream `error_code 31299`**: `"Size of superfile2 first part should
not be smaller than slice size"`. Discriminating probes (all live, all at
2 MiB parts, this account):

- >4 GiB premium-stage file, full 2 MiB part → **31299** (502 through the
  worker; the host ladder exhausts).
- 5 MiB **free-class** file, full 2 MiB first part → **31299** — so the rule
  is not premium-class-only.
- 64 KB single-part PUT and Campaign 8's 1 MiB control → **accepted** — the
  one part of a single-part upload is the short *last* part, which the rule
  does not cover.
- This morning's 4 MiB first parts (1025-chunk run) → accepted through
  chunk ~195 — the same 2-entry placeholder `block_list`; the slice floor
  comes from upstream per the file class, not from our block list.

Conclusion: **no full-size first part below 4 MiB is legal for any
splitting upload**; shrinking chunks cannot rescue the free-plan CPU wall.
`MAX_CHUNK_BYTES` below 4 MiB can only (legally) apply to single-part
files, where it is pointless. Shipped the correction (`027a366`):

- `DEFAULT_MAX_CHUNK_BYTES` back to 4 MiB (Campaign-6-proven).
- `getChunkSize` floors any file that actually splits at 4 MiB even when
  `MAX_CHUNK_BYTES` shrinks below it — a tiny cap cannot steer a real
  upload into the 31299 trap; single-part files keep the small size.
- Tests: pins for the floor (`5 MiB @ cap 2 MiB → 4 MiB`,
  `1 KB @ cap 1 MiB → 1 MiB`) plus the restored tier pins; review 388/388,
  dry-run green, smoke 34/34 after the deploy.
- Live closing proof (free-class, default build): 9 MiB file through the
  resumable plane — begin answered `chunkSize 4194304 / chunkCount 3`, all
  three parts (4 MiB, 4 MiB, 1 MiB tail) accepted with upstream md5s,
  finalize 201, size exact, **full-file md5 round-trip MATCH**; probe file
  deleted.

**Final verdict for the user's use case (>4 GiB backups through this
worker):** on the Workers free plan, ≤ 4 GiB files are fully workable
(4 MiB parts; Campaign 6 proved a complete 1024-chunk session), but > 4 GiB
sessions die late in the 1102 wall — twice reproduced — and can NOT be
made legal at smaller chunks (31299). That class needs a Workers paid
plan; the paid recipe is `MAX_CHUNK_BYTES=8` (or 16/32) to restore the
tier's larger premium buckets: fewer, larger parts, and CPU headroom.

### Housekeeping in this campaign

- Campaign 8 folders (`/premium-campaign/…`) were created for the byte-proof
  and cleaned up afterwards; account keeps only real data.
- Deployments checked via
  `CLOUDFLARE_ACCOUNT_ID=d5d15d42e8e4fd5a159feb81ae38f036 npx wrangler
  deployments list` (davbox lives in the `tes1ing` account; three accounts
  share the token).

## Campaign 9 — per-tab viewer sessions: closing the tab signs out (2026-10-18)

The user requirement: **whenever this tab closes, the session must end — no
saved cookie, ever.** Campaign 7's HttpOnly cookie (`davbox_session`,
`Max-Age=30d`) was the direct opposite, so the browser auth model is replaced:

- **The credential lives in `sessionStorage`** (`davbox_auth` = the Basic
  header value), which the browser destroys with the tab. Reload (F5) keeps
  working in place; a new tab or middle-click signs in again — that IS the
  requirement. The server never issues a session cookie any more; legacy
  cookies are inert (the gate ignores them) and the sign-out button still
  wipes them via `/.dav-logout`.
- **The viewer shell is served without auth** (static, ships no data): an
  unauthenticated browser navigation gets the page, which opens an in-page
  sign-in card (`#authov`); everything real still 401s without the
  credential. Reserved dot-paths keep the bare 401 challenge.
- **Folder navigation is JS-driven** (`history.pushState` + re-render): a
  folder click can no longer be a full page load, because such a load could
  never carry a per-tab credential. Breadcrumbs, name links, row clicks and
  the sheet's Open all route through it; `popstate` re-lists on
  Back/Forward.
- **File opens/downloads mint a 60 s signed URL** (`POST /.dav-sign` →
  `?ot=<token>`): a navigation-grade request cannot carry sessionStorage, so
  the page signs the decoded path first — a stateless HMAC over the raw
  USERS string, bound to the exact path, GET/HEAD only, verified at the
  gate. A copied link works for a minute, then 401s.
- WebDAV clients (mpv/gvfs/rclone) unchanged: per-request Basic.
- `src/login.ts` shrank to the sign minter + logout clear + form-hardening
  helpers (the login page HTML and session-mint code are gone); the viewer
  gained the card, the nav and the sign flow (bundle 219 → 224 KiB).
- Pins (suite 425/425): JSON login (ok / 401-without-challenge / unicode),
  inert legacy cookie, public shell, reserved-path 401, token
  mint/verify (path-bound, 60 s expiry, forgery, PUT/DELETE-with-token
  refusal, sign-path traversal/junk 400s), POST-only contracts.
- **Post-deploy support case (same day)**: Nautilus reported `HTTP Error:
  (null)` copying `Chapter_:_01.mkv` into the mount. Root cause = size, not
  the name: the file is 1.07 GB (past the ~100 MB single-request edge cap —
  the kill leaves gvfs with no status to print, hence "(null)"). The colon
  was cleared innocent twice on the live worker: raw `:` PUT → 201 (stored
  as `#`), and the same copy through `gio copy` (gvfsd-dav itself) →
  success, stored `colonprobe-#_01.txt`. Remedy for files this size: the
  web viewer's chunked uploader or the TeraBox app; no WebDAV single-PUT
  client can exceed the cap on the free plan.

## Repo map (context for AI sessions)

Branch state (2026-11-12 — the worker lives in the `tes1ing` account as
`davbox`, hence `https://davbox.tes1ing.workers.dev/dav/` and creds
`test:test`; the retired `crazy-gooner-mf` free subdomain now answers a
Cloudflare 404 `error code: 1042` and no longer reaches the worker):
production. **Every push to `main` builds and deploys automatically** via
Workers Builds — the deployment lands roughly 30 s after the push
(correlated against `git log`: 2026-10-18 03:36/05:13/06:10/07:19/08:14/09:16
and 2026-11-12 15:22/15:37 all trail their commit by 26-87 s). Those build
deployments show up in `wrangler deployments list` as `Source: Upload` /
"Automatic deployment on upload", exactly like a manual `wrangler deploy`, so
the list alone cannot tell the two apart — a previous round mis-read that as
"deploys are manual"; use the timestamp-commit correlation instead.
Instance config lives only in the deployer's dashboard and survives deploys
via `keep_vars = true` (`PATH=/dav/`, `ROOT_ID=/test`,
`TERABOX_DOMAIN=https://dm.terabox.com`); never add `[vars]` to this public
repo. The `npm run review` gate applies to every push and the live smoke to
every push and deploy. Current verification: `live-smoke.sh` 34/34 +
**444 unit tests** + 11 revert-verified round-17 pins (litmus was last green
at 138/138 on 2026-10-17). Latest shipped work:
the Campaign 8 premium-limit campaign — `.npmrc` legacy-peer-deps for CI
(`85b9082`), tier-aware `MAX_CHUNK_BYTES` chunk cap after the live 1102
finding (`008a2c3`; begin-with-fix live-verified: >4 GiB begin answers
4 MiB × 1025), and the zero-byte probe battery `scripts/premium-limits.sh`
— before that: viewer/sign-in UI retheme + fixed table layout + login
username prefill (`e42c6f0`, live `da0faade`), browser chunked upload for >64 MiB files (`4b79810`, live `eabbf04e`), session sign-in form + attachment downloads + preview removal (`4b1ef7e`), download-URL cache (repeat-open TTFB
0.12 s, `96b1273`), account-wide API pacing through the DAV_STATE DO
(`2ef74a7`), Worker Placement dead-end documented (`d0b83fb` — the ~1.8 MB/s
cap is TeraBox free-tier, colo-independent), review rounds 14–17 (rounds 14–15 = the session-cookie boundary work below; 16–17 = test/doc/script hardening, findings in `scripts/live-litmus.sh` + quota discipline in AGENTS.md; session
cookie never replays to a CDN host: the cookieless boundary is recorded when a
URL hops and replayed from the cache — pinned end-to-end by asserting the mock
`/dl/` handler never observes a Cookie on a `via=pcs` replay, with both halves
revert-verified; resolved fetches take a discriminated `ResolvedFetchOpts` so
a forgotten `cookieless` is a type error, skip the jsToken remedy — the ladder
re-mints — and run a 15 s header-phase bound, disarmed in `finally` so bodies
stream unbounded; phase-0 hits slide the TTL (hot files never re-ladder
mid-session) without rewriting the mint-time flag; the DO slot test forces a
cold timeline via `runInDurableObject` so both the immediacy and the
serialisation halves assert deterministically). Note: hitting the Workers
free tier daily quota (`Exceeded allowed rows written in Durable Objects
free tier`) 500s EVERY request until the 00:00 UTC reset — this is
environmental, not a code regression; wait for the reset rather than
debugging. Post-verification of these deploys runs from
`/tmp/opencode/postreset-verify.sh` (auto-probes for 207, then smoke +
litmus via `scripts/live-litmus.sh`; results land in
`/tmp/opencode/postreset/`). **Verified 2026-10-12** on `v4708a473`
(`538963e`): live smoke **34/34** + litmus **138/138** (basic 16,
copymove 13, locks 40, http 3, props 33, protected 30, lockbomb 3) after
the 00:00 UTC quota reset; then re-verified the Campaign 7 deploys
(`b5fcb71a`, then `eabbf04e`): smoke **34/34** + gate 388/388 +
real-Chromium login flow 18/18 + big-file chunked upload 5/5. The branch also
includes the RFC 7233 GET/ETag conformance hardening (merged `d065d53`,
deployed) and the full-repo audit hardening (merged `4d87f47`: traversal
containment, metaCache cap, errno→status maps, DO-backed lock/prop tests,
docs/config fixes — see the Phase 2–4 commit messages). All feature branches (`fix/davfs2-etag-hang`, `fix/audit-hardening`,
`docs/ndus-cookie-lifetime`, `docs/openapi-full-extraction`) are merged and
deleted; only `main` remains. Git history was rewritten (filter-repo) to purge
leaked credentials — pre-rewrite SHAs in old sessions map via the subjects.
Gates before any push to `main`: `npm run review` (typecheck + tests +
dry-run deploy).

- `taxin-404/terabox-webdav-worker` — this project (TypeScript Worker)
- `BenjiThatFoxGuy/bclone` — rclone fork; the Terabox backend ported here
  (`backend/terabox/*.go` is the reference for API semantics)
- `taxin-404/google-drive-webdav-workers` (branch `test/webdav-compliance`) —
  WebDAV compliance test suite this repo's tests are modelled on
