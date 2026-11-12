# AGENTS.md — terabox-webdav-worker

## Standing rules

- **After every `git push` and every `npx wrangler deploy`: run the live smoke
  and do not consider the change done until it passes:**

  ```sh
  ./scripts/live-smoke.sh
  ```

  It must print `LIVE SMOKE: … passed, 0 failed`. A push that is not followed
  by a passing live smoke is an incomplete push.

- **Gate before every deploy:**

  ```sh
  npm run review   # tsc --noEmit + vitest + wrangler dry-run
  ```

- **Commit style:** `type: lowercase-summary` (e.g. `fix: review round N — …`).
  Commit only when explicitly asked; never push without the request.

- **Review rounds:** second-opinion subagent reviews are research-only.
  Every finding must be tagged REAL / STALE / HYPOTHETICAL, and every fixed
  finding gets a revert-verified pin (backup src+test, surgical revert, pin
  must fail, restore).

- **Free-tier quota discipline (learned the hard way, 2026-10-11):**
  - `500 {"error":"Internal Server Error"}` on EVERY path with wrangler tail
    showing `Exceeded allowed rows written in Durable Objects free tier`
    means the quota died — 00:00 UTC is the guaranteed reset (one window
    recovered mid-window, so probe ONCE and re-check later before declaring
    it dead). One probe confirms state; never *retry*-loop probes or re-runs
    against a dead worker within a working session. Deliberate wait-for-reset
    scripts are fine when they poll at long intervals (≥10 min) and stop at
    the window. While dead: work locally (`npm run review`, docs, review
    rounds) and push; run the deferred live smoke once the worker answers.
  - **litmus is quota-heavy** (locks/props/upload DO writes): quota death has
    been observed within minutes of a litmus-heavy window (same-window
    traffic may also contribute). Run it at most **once per quota window**,
    only after smoke is green. Use `./scripts/live-litmus.sh` (correct
    `/dav/litmus/` base, `TEST_NODEBUG=1` so neon's debug.log cannot grow,
    pre-flight + per-suite re-checks that abort instead of hammering a dead
    worker).
  - The live smoke stays the standing post-push rule, but when the quota is
    dead the smoke is *deferred, not skipped*: record it, verify at reset.

## Environment

- Node is not on the default PATH: `export PATH="$HOME/.local/node/bin:$PATH"`
- Live worker: `https://davbox.tes1ing.workers.dev/`, base `/dav/`.
- Tests: `npx vitest run` (projects: dav, mount, mount-utf8, auth, davstate).
  The `davstate` project binds the `DAV_STATE` Durable Object; `mount*`
  projects set `PATH` bindings.
