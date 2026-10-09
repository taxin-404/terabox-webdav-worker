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

## Open work (next sessions)

1. Fix upload 401 (#1) — instrument or reproduce `precreate`/`create` errno.
2. Add pacing + 429 backoff to `TeraboxClient.request()` per values above.
3. Fix Range/206 passthrough and HEAD `Content-Length` (#3, #4).
4. Re-run `test/live/webdav-livetest.sh` and update this file.

## Repo map (context for AI sessions)

- `taxin-404/terabox-webdav-worker` — this project (TypeScript Worker)
- `BenjiThatFoxGuy/bclone` — rclone fork; the Terabox backend ported here
  (`backend/terabox/*.go` is the reference for API semantics)
- `taxin-404/google-drive-webdav-workers` (branch `test/webdav-compliance`) —
  WebDAV compliance test suite this repo's tests are modelled on
