#!/usr/bin/env bash
# Full litmus conformance suite against the deployed worker (138 tests).
# STANDING RULE: run this ONCE per quota window, smoke first — litmus is
# DO-write heavy and quota death has been observed within a minute of a
# litmus-heavy window (every request then 500s until the quota refills;
# 00:00 UTC is the guaranteed reset, some windows recover mid-window —
# probe once before declaring it dead, never retry-loop it).
#
#   BASE=https://davbox.tes1ing.workers.dev/dav USER_CRED=user:pass \
#     ./scripts/live-litmus.sh
#
# Suites must run against the litmus COLLECTION under the WebDAV root
# (/dav/litmus/ — a root-level /litmus/ 404s; each suite MKCOLs its own
# /dav/litmus/litmus/ work collection and needs the parent to exist).
set -u
B="${BASE:-https://davbox.tes1ing.workers.dev/dav}"
A="${USER_CRED:-test:test}"
LITMUS_SRC="${LITMUS_SRC:-/tmp/opencode/litmus}"
# Note `-` not `:-` for SUITES: an explicitly empty SUITES must reach the
# empty-guard below and refuse (exit 2) instead of silently meaning
# "default suites" (`:-` swallows empty and made the guard dead code).
SUITES="${SUITES-basic copymove locks http props protected lockbomb}"

# neon's harness appends every byte to debug.log in cwd unless TEST_NODEBUG —
# that file has grown past 1 GB on this tmpfs; never let it grow again.
export TEST_NODEBUG=1

case "$A" in
  *:*) U="${A%%:*}"; P="${A#*:}" ;;
  *) echo "USER_CRED must be 'user:password' (got: $A)"; exit 2 ;;
esac
[ -n "$SUITES" ] || { echo "SUITES is empty — refusing to report green for 0 tests"; exit 2; }
for t in $SUITES; do
  [ -x "$LITMUS_SRC/$t" ] || { echo "missing litmus binary: $LITMUS_SRC/$t"; exit 2; }
done

# Cheap read-only pre-flight (PROPFIND Depth:0 does no DO writes). 207 =
# healthy; 404 = parent collection missing (self-heal below); anything else
# (500 = quota, 401 = creds) aborts before a single suite runs.
preflight() {
  curl -s -o /dev/null -w '%{http_code}' --max-time 15 \
    -X PROPFIND -H 'Depth: 0' -u "$A" "$B/litmus/" || true
}
code=$(preflight)
if [ "$code" = "404" ]; then
  # The parent is gone: create it (its own parent, /dav/, exists) rather
  # than letting all seven suites FAILHARD at begin.
  curl -s -o /dev/null --max-time 15 -X MKCOL -u "$A" "$B/litmus/" || true
  code=$(preflight)
fi
case "$code" in
  207) ;;
  *) echo "pre-flight: worker answering ${code:-000} — refusing to run (quota/creds)"; exit 3 ;;
esac

rc=0
ran=0
for t in $SUITES; do
  # Re-check between suites: quota can die mid-run (observed), and suites
  # against a 500ing worker produce output indistinguishable from a regression.
  code=$(preflight)
  if [ "$code" != "207" ]; then
    echo "== worker answering $code after $ran suite(s) — aborting remaining =="
    rc=3
    break
  fi
  echo "===== $t ====="
  (cd "$LITMUS_SRC" && "./$t" "$B/litmus/" "$U" "$P") || rc=1
  ran=$((ran + 1))
done
[ "$ran" -gt 0 ] || { echo "no suite ran"; exit 3; }
exit $rc
