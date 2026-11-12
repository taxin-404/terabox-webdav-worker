#!/usr/bin/env bash
# Zero-byte plan-limit probes against the worker's resumable control plane
# (Campaign 8 recipe, 2026-10-17). Proves tier detection and the size-cap
# catalog WITHOUT uploading anything: every accepted begin is canceled
# (204) before any chunk is sent and no finalize ever runs — nothing is
# created upstream and only a handful of paced API calls are spent.
#
# Tier-aware: interprets >4 GiB acceptance as premium, rejection as free,
# and cross-validates 40 GiB / 129 GiB against that verdict.
#
# Usage:
#   BASE=https://davbox.tes1ing.workers.dev/dav USER_CRED=test:test \
#     bash scripts/premium-limits.sh
set -u
BASE="${BASE:-https://davbox.tes1ing.workers.dev/dav}"
A="${USER_CRED:-test:test}"
B="$BASE/.resumable"
STAMP=$(date +%s)
PASS=0; FAIL=0
TIER=""
ok() { PASS=$((PASS+1)); printf '  ok  %s\n' "$1"; }
no() { FAIL=$((FAIL+1)); printf '  XX  %s\n' "$1"; }

cancel() { [ -n "${1:-}" ] && curl -s -o /dev/null -u "$A" -X DELETE "$B/$1"; }

begin() { # name size -> echoes uploadId
  local body; body=$(curl -s -u "$A" -X POST "$B" -H 'Content-Type: application/json' \
    --data "{\"path\":\"/campaign8-probe-$1-$STAMP.bin\",\"size\":$2}")
  echo "$body" | grep -o '"uploadId":"[^"]*"' | cut -d'"' -f4
}

reject_code() { # name size -> echoes HTTP code
  curl -s -o /dev/null -u "$A" -X POST "$B" -H 'Content-Type: application/json' \
    --data "{\"path\":\"/campaign8-probe-$1-$STAMP.bin\",\"size\":$2}" -w "%{http_code}"
}

echo "== plan-limit probe battery (zero bytes uploaded) =="

ID=$(begin small 1048576)
if [ -n "$ID" ]; then ok "1 MiB begin accepted (both tiers)"; cancel "$ID"; else no "1 MiB begin rejected?"; fi

ID=$(begin over4gib 4296015872)
if [ -n "$ID" ]; then
  ok ">4 GiB accepted -> account is PREMIUM (free cap bypassed)"; cancel "$ID"; TIER="premium"
else
  CODE=$(reject_code over4gib2 4296015872)
  if [ "$CODE" = "507" ]; then ok ">4 GiB rejected 507 -> account is FREE (4 GiB cap)"; TIER="free";
  else no ">4 GiB rejected with unexpected code $CODE"; fi
fi

if [ "$TIER" = "premium" ]; then
  ID=$(begin 40gib 42949672960)
  if [ -n "$ID" ]; then ok "40 GiB accepted (128 GiB headroom)"; cancel "$ID";
  else no "40 GiB rejected but account read premium"; fi
  CODE=$(reject_code 129gib 138514903347)
  if [ "$CODE" = "507" ]; then ok "129 GiB rejected 507 (128 GiB ceiling)"; else no "129 GiB answered $CODE (want 507)"; fi
else
  CODE=$(reject_code 40gib 42949672960)
  if [ "$CODE" = "507" ]; then ok "40 GiB rejected 507 (free tier expectation)"; else no "40 GiB answered $CODE on free tier (want 507)"; fi
fi

echo "PLAN LIMIT PROBES: $PASS passed, $FAIL failed (tier: ${TIER:-unknown})"
