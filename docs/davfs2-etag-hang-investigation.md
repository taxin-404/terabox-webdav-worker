# davfs2 large-file re-download investigation (open() "hangs forever")

Status: **root cause pinned by deduction (not wire-observed); fix implemented
on `fix/davfs2-etag-hang` (pending review — not yet on `main`/production).**
Originally written 2026-10-10 as a handoff; a second pass re-verified every
load-bearing davfs2 claim against the Debian master sources
(`src/webdav.c`, `src/cache.c`) and tightened the deduction (see
"Independent verification" below). Everything was established from the davfs2
source plus a live `strace -f` of the real daemon against the production
worker.

## TL;DR

Opening a large file through a davfs2 mount of this worker re-downloads the
**entire file on every open**, instead of revalidating with `If-None-Match` →
`304`. Small files revalidate correctly (measured: 15 ms, zero bytes). The
mechanism:

1. davfs2 `open()` = one synchronous whole-file `GET` (no `Range`, ever),
   streamed into its local cache. The FUSE loop is single-threaded, so the whole
   mount is frozen meanwhile — a1.1 GB file at ~1.4 MB/s ≈ 12+ min of apparent
   dead-hang, punctuated by CDN stalls that can trip davfs's 180 s read timeout
   and restart the download **from zero** (davfs deletes the partial cache on
   error; it never resumes).
2. davfs2 sends `If-None-Match` on revalidation **only if it stored an etag** for
   the file (`webdav.c:757`, `cache.c:2686`). It captures the etag from a GET
   response **only when the status is exactly `200`** (`webdav.c:818-838`). On
   any other 2xx (notably `206`) the etag local stays `NULL` and — in the
   fresh-download branch — **overwrites `node->etag` with NULL**
   (`cache.c:2701-2706`), wiping whatever the PROPFIND had provided.
3. Our worker passes the **upstream status through verbatim**
   (`webdav.ts:844`). TeraBox's PCS app-protocol endpoint can answer `206` +
   `Content-Range` for a no-Range request. If that happens even once for a file,
   the client's etag is destroyed and **every subsequent open of that file is a
   bare `GET` → full body → forever**, even though the worker *would* answer
   `304` if it received the validator (verified repeatedly with curl).

The298-byte TLS record of the daemon's revalidation request (vs the small
file's conditionally-identical request) is direct evidence that the request
carried **no** `If-None-Match` — i.e. the daemon's stored etag was NULL.

## Environment

- Worker: `https://terabox.taxin-404.workers.dev/` (Basic `REDACTED:REDACTED`),
  deployed from this repo's `main` (auto-deploy on push; run the gates below
  before every push).
- Mount: `/mnt/webdav1`, fstab entry
  `https://terabox.taxin-404.workers.dev/dav/ /mnt/webdav1 fuse noauto,user,cache_dir=/tmp/davfs-cache 0 0`.
  Non-root mount needs that `user` entry **and** the mounting user in
  `dav_group` (`network` on this box; must be the *primary* group — `mount(8)`
  drops supplementary groups in the helper chain).
- `/etc/davfs2/secrets` format is **whitespace-separated `URL user password`**
  (3 fields). A colon (`user:pass`) parses as username-only → interactive
  prompt → EOF → SIGABRT. `davfs2.conf` here is all-commented defaults
  (`file_refresh 1`, `dir_refresh 60`, `timeout 180`, `min_propset 0`,
  `use_locks 1`).
- `mount.davfs` refuses non-setuid execution (`geteuid()!=0` → abort), so
  tracing requires root: 

  ```
  sudo sh -c 'setsid nohup strace -f -tt -s 200 -o /tmp/opencode/davfs-root.strace /usr/bin/mount.davfs "https://terabox.taxin-404.workers.dev/dav/" /mnt/webdav1 </dev/null >/dev/null 2>&1 &'
  ```

  (survives terminal close; trace is world-readable).
- `/tmp` is tmpfs — traces are wiped on reboot. Durable copies from this
  session live in `~/davfs-investigation/` (`davfs-root.strace.gz`,
  davfs2 sources `davfs-webdav.c`, `davfs-cache.c`, `davfs-md.c`, and
  `direct-256k.bin` = first 256 KB of the video via a direct Range GET).

## Live session timeline (2026-10-10, all times local)

Test file: `John Wick (2014) 720p ... H264 ... -mkvC.mkv` in `/omacom`,
1,126,762,632 B (1074.5 MiB), md5 `618afe9737d991869fd235a63f0c0346`.

- 13:08:52 — download #1 starts (fresh open, plain GET, worker edge
  `104.21.68.249`/`172.67.200.133`). Throughput ~1.5 MB/s.
- ~13:16-13:19 — **stall**: writes collapse to ~70 KB/s (16.6 MB over 4 min);
  a `tail -1` during the stall caught the daemon back in its idle FUSE
  `pselect6` — the GET had died on davfs's 180 s read timeout, the partial
  cache file was **deleted** (`cache.c:2715-2723`), the pending FUSE open
  answered with an error (the reader process woke with EIO; its output file was
  empty). This is the "hangs forever" symptom: every retry restarts the whole
 1.1 GB from zero, and the single-threaded daemon freezes all other mount ops
  for the duration.
- 13:19:55 — re-open issued by the test harness → fresh download #2
  (no etag to revalidate with — consistent with the NULL established below).
- 13:20:03 — new TLS connection to the worker; full body streamed
  (`write(6,…)` cache-file accounting: 673 MB in [13:20,13:26) + 402 MB after
  = exactly1074.6 MB, i.e. one complete pass); completed ~13:30.
- 13:38-13:39 — small-file control (`bookmarks_7_23_26.html`, 26,698 B):
  fresh open 5165 ms / +21 cache writes (full GET); re-open after 4 s:
  **15 ms / 0 writes** (session-reused `304`); re-open after 70 s:
  **641 ms / 0 writes** (`304` on a fresh connection). The revalidation
  machinery works — for files that have an etag.
- 13:50:48 — re-open of the video: FUSE_LOOKUP arrives, daemon closes the idle
  session, reconnects, sends **one298-byte TLS record** (the small file's
  conditional GET was251+279 bytes with a ~90-byte-shorter path; arithmetic
  says the298 B record is a **bare GET with no conditional headers**), then
  13:50:53 the MKV magic hits the cache file again → **full download #3**
  (completed ~13:57; final `write(6)` count 363,387 lines ≈ two full video
  passes + the small file).
- 14:2x — probe results (see below) and shutdown of the investigation.

## Worker-side facts (all verified live)

- `GET … If-None-Match: "618afe…"` → **304** (curl). Plain GET → **200**,
  `Content-Length: 1126762632`, `ETag: "618afe…"`, no `Content-Range`.
  `Range: bytes=0-0` → **206** with the same ETag. HEAD → **200** + ETag.
- Etag is **stable across repeated fresh fills** (6 samples over ~5 min, both
  GET and PROPFIND, always `618afe…`). The md5-less-fill theory was tested and
  **rejected**.
- Code path: `src/webdav.ts:750` derives the ETag from `item.md5` **only** (no
  fallback, unlike `statResource` at line 190 which falls back to
  `"<mtime>-<size>-<isdir>"`); the INM check at 754-763 matches the exact
  quoted form and `W/`-prefixed; the ladder at 851-877 tries the PCS
  app-protocol route first, then the official dlink, then the filemetas dlink;
  `fetchDownload` (`src/terabox.ts:589`) forwards a `Range` header **only if
  the client sent one**; the response is returned with
  `{ status: upstream.status }` (`webdav.ts:844`) — **upstream status
  pass-through**.
- `wrangler tail` was unusable in this session (two detached runs wrote0 bytes;
  foreground runs untried with stderr visible) — the daemon-side strace was the
  reliable channel.

## davfs2-side facts (source-verified, Debian sid tree, `src/`)

- `cache.c:2644 update_cache_file`: cached+present → if older than
  `file_refresh` (1 s) → `dav_get_file(path, cache, &size, &node->etag,
  &smtime, &modified)` (revalidation). Not cached → creates the cache file and
  calls `dav_get_file` with a **fresh local `etag = NULL`**, then on success
  **unconditionally assigns** `node->etag = etag` (`cache.c:2705-2706`) — a
  non-200 response therefore *destroys* a previously-known etag. On error the
  partial cache file is deleted (`cache.c:2721`) — no resume, ever.
- `webdav.c:740 dav_get_file`: adds `If-None-Match: *etag` **only when
  `etag && *etag`** (757-758); adds `If-Modified-Since` when mtime is known
  (760-763); registers a body reader that streams into the cache file
  (`ne_accept_2xx`, so a `206` body streams just like a `200`); captures
  Content-Length / Last-Modified / ETag **only inside
  `if (!ret && status->code == 200)`** (818-838). `304` → no body, nothing
  updated, `modified` stays 0 — the correct fast path, *when the INM is sent*.
- `webdav.c:1581 normalize_etag`: always returns a **quoted** etag (adds quotes
  if the source was bare), drops `W/` only when `drop_weak_etags` is set.
  So the stored etag form matches our matcher — when it exists.
- `node->etag` sources: PROPFIND `props->etag` (`cache.c:1622`), `dav_head`
  (`cache.c:956`), and the GET capture above. davfs requests
  `DAV:getetag` in its PROPFIND (`full_prop_names`, `webdav.c:122-129`);
  `min_propset` defaults to 0 so the full set (incl. getetag) is used on this
  box — the "PROPFIND without etag" variant is **not** in play here.
- The mount is single-threaded; `lost+found/` in the mount view is a davfs2
  built-in (`DAV_BACKUP_DIR`), never present on the server.

## What was ruled out (with the evidence)

- **Worker INM logic broken** — no: exact-curl 304s, and the small file
  revalidates through the mount.
- **Etag flapping / md5-less dlink fills** — no: 6/6 samples carried the md5
  etag; the dlink-flavoured fill includes md5.
- **Wrong etag form (unquoted/weak)** — no: `normalize_etag` always quotes; our
  matcher accepts both plain and `W/`-quoted.
- **Redirect-to-CDN swallowing the INM** — no: our GET streams (no 302; the
  trace shows a single sustained connection to the worker edge).
- **PROPFIND lacking getetag** — no: davfs uses the full prop set by default
  and our PROPFIND serves `getetag` for every resource.
- **The daemon sending a conditional request that failed to match** — no: the
  request record size (~298 B) matches a bare GET with the long path and
  *cannot* accommodate the ~50 B of conditional headers.

Remaining single link: **the worker's response to the daemon's downloads #2
(13:20) and #3 (13:50) was presumably not `200`** (most plausibly `206`
passed through from the PCS upstream), leaving `node->etag` NULL. Not directly
observed — the status was TLS-encrypted and `wrangler tail` was down.

## Independent verification (second pass, 2026-10-10)

Re-checked against Debian master `davfs2` sources rather than trusting this
handoff's line citations:

- `dav_get_file` (webdav.c:740): `If-None-Match` is added only under
  `if (etag && *etag)` — a NULL etag is exactly the observed bare request.
- The validator capture is strictly `if (!ret && status->code == 200)` and
  does `*etag = normalize_etag(response ETag)` — so any **successful** GET
  that is not a 200 (a 206, which `ne_accept_2xx` streams into the cache as
  a success), or a 200 lacking an ETag header, **frees and NULLs** the
  caller's stored etag.
- The fresh-download branch (cache.c:2696-2706) passes a **local NULL** etag
  and, on success, unconditionally assigns `node->etag = etag` — wiping the
  PROPFIND-provided validator. The error branch (2718-2723) deletes the
  partial cache and does **not** touch `node->etag`.

That last detail tightens the deduction beyond the original "presumed": a
*failed* download leaves `node->etag` intact, so the daemon's bare GET at
13:50 (its stored etag had to be NULL for `If-None-Match` to be absent) can
only be explained by a **successful** response that skipped the capture block
— a `206` (the md5-less-`200` alternative was already ruled out by the 6/6
md5 samples). Still an inference, not a wire capture: the 206 itself was
never observed. The fix removes the mechanism regardless of which flap
occurred, and no worker GET response shape can trigger the wipe path once it
is in: post-fix the only GET statuses emitted are `200` (always with ETag),
`206` (only when requested), `304` (leaves `node->etag` untouched) and
errors.

## How to close the last link

1. **Cheap flap hunt** (no mount needed): poll the video's no-Range GET status,
   spaced beyond the worker's 60 s metadata-cache TTL so each sample is a fresh
   upstream fetch:

   ```
   while :; do curl -s -u REDACTED:REDACTED -D - -o /dev/null --max-time 12 \
     'https://terabox.taxin-404.workers.dev/dav/John%20Wick%20(2014)%20720p%20BluRay%20x264%20ESub%20%5BDual%20Audio%5D%5BHindi%205.1+English%205.1%5D%20-mkvC.mkv' \
     2>/dev/null | grep -iE '^(HTTP|content-range|etag)' | tr -d '\r'; sleep 65; done
   ```

   Any `HTTP/… 206` or a `Content-Range` on a no-Range request confirms the
   pass-through mechanism end to end. (Each sample is killed after 12 s, so it
   costs only the first ~15 MB.)
2. **Definitive header capture**: remount under strace with TLS keylogging —
   `sudo pacman -S wireshark-cli` (tshark), then
   `touch /tmp/opencode/keys.log && chmod 666 …` and relaunch the mount with
   `SSLKEYLOGFILE=/tmp/opencode/keys.log` in the environment; decrypt with
   `tshark -o ssl.keylog_file:/tmp/opencode/keys.log -Y http -T fields -e http.request.method -e http.request.uri -e http.request.line -e http.response.code …`
   against a pcap or the live interface. This shows the daemon's exact
   `If-None-Match` on the wire.
3. **Self-healing check** (costs one more1.1 GB download): with the worker
   currently answering `200`+ETag, the *next* mount-open of the video captures
   the etag (status==200 branch) and the open after that should `304`
   instantly. If it does, the loop is confirmed as "one bad status poisons the
   client forever" and the fix below is exactly right.

## Proposed fix (implemented on `fix/davfs2-etag-hang`)

1. **Never surface a `206` to a client that did not ask for a range** (and
   never surface a bare `200` body as if it satisfied a range): in
   `handleGet`'s `tryUrl`, normalize — client sent no `Range` and the upstream
   `206` is verifiably the whole entity (`Content-Range` spans `0-(total-1)`
   with a matching `Content-Length`, or the length equals the known size) →
   force status 200 and drop `Content-Range`; a genuinely partial body is
   **rejected** (ladder moves to the next candidate, never streamed as a
   complete file); client sent a `Range` and upstream answered `200` with the
   full entity → keep `200` (RFC 7233 allows it) but drop `Content-Range`.
   A `416` to a request that carried no `Range` is likewise treated as an
   upstream fault instead of being passed through. This removes the only
   mechanism that can destroy a davfs2 client's etag, and is a correctness
   fix in its own right (RFC 7233 §4.1: a server must not send `206` unless
   the request had a range).
2. **Stable etag for GET/HEAD** via the shared `etagFor(item)` helper (md5 →
   `"<server_mtime>-<size>-<isdir>"` fallback, exactly like `statResource`),
   so a fill without md5 can never strip the validator either — GET and
   PROPFIND now serve the identical value by construction.
3. Tests: unit tests with a mocked upstream answering `206` to a no-Range GET
   (client must see `200`, no `Content-Range`, `ETag` present, body intact);
   a truncated `206` must fall through the ladder, and all-truncated must
   answer 502 rather than a partial body; INM + upstream-`206` must still
   yield `304`; the etag fallback case for a md5-less item. All six fail
   against the pre-fix code (verified by stashing the source change).
4. Gates before push (they auto-deploy `main`):

   ```
   export PATH="$HOME/.local/node/bin:$PATH"
   npm run typecheck && npm test -- --run && npx wrangler deploy --dry-run
   ```

   Result on the branch: typecheck clean, 142/142 tests, dry-run bundles.
   Pre-fix differential: reverting `src/webdav.ts` to `a36c847` fails **4 of
   the 6** new tests (the unrequested-206 normalization, the truncated-206
   ladder fall-through, the all-truncated 502, the md5-less etag fallback);
   the remaining 2 are regression guards for behaviour that already worked
   (the `If-None-Match` short-circuit ahead of the ladder, and
   requested-range pass-through).
   (A 10-sample live flap hunt on 2026-10-10 answered `200` every time — the
   upstream flap is intermittent, so production verification still needs the
   mount check below after merge.)
5. Live verification through the mount: open the video once (one final full
   download), then re-open — expect instant open, zero `write(6,…)` cache
   writes in the strace, and a `304` visible as an empty-body dispatch.

## Session recipes & hazards (for whoever continues on this box)

- Daemon/trace lifecycle: the mount in this session was root-made under
  strace (pid of `mount.davfs` 9754, strace 9746, trace still growing at
  `/tmp/opencode/davfs-root.strace`). Teardown needs the user's sudo:
  `fusermount3 -uz /mnt/webdav1` then `sudo pkill -f davfs-root.strace` (the
  daemon survives the strace being killed; it dies when the FUSE connection is
  torn down).
- Never `timeout`-kill processes doing FUSE reads — they sit in D-state and
  only `fusermount3 -uz` recovers the mount. Use `head -c N` (clean close).
- `wrangler tail` flaked this session (backgrounded runs:0 bytes). If needed
  again, run it foregrounded with stderr visible before trusting a capture.
- Probe loops over `/proc` of D-state tasks and `ss` intermittently blocked
  for60 s+ in this session's harness; guard probes with `timeout 3` and prefer
  file-based evidence (the strace) over live process probing.
- Measurement one-liners that proved out: cache-byte accounting per time window
  (sum of the `= N` returns of `write(6,…)` lines, split by the timestamp
  field) to distinguish "one download with a stall" from "two downloads";
  TLS request-record sizes (`write(4, …) = N`) to infer whether conditional
  headers were present without decrypting.
- Direct TeraBox API for cross-checks: `GET /api/list?dir=%2Fomacom&…` with
  the cookie from `~/secrets.md` (lowercase `ndus=…` line) and a Firefox UA.
  `/api/filemetas` needs the worker's minted jsToken (errno 2 without it) —
  probe metadata through the worker instead.

## Related session work (already merged)

- `99e589a` — literal `+` in path segments (this very file's name exposed it);
  lockdiscovery `Math.ceil`.
- `17c7b12` —60 s read-path metadata cache (first PROPFIND of a fresh path
  482 ms → 105 ms).
- `b556c30` — README davfs2 usage section + Campaign 5 log in
  `docs/live-testing.md`.
