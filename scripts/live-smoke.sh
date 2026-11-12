#!/usr/bin/env bash
# Full live WebDAV smoke against the deployed worker.
# STANDING RULE: run this after every `git push` (and after every deploy)
# and do not consider the change done until it passes.
#   BASE=https://davbox.tes1ing.workers.dev/dav USER_CRED=test:test ./scripts/live-smoke.sh
set -u
B="${BASE:-https://davbox.tes1ing.workers.dev/dav}"
A="${USER_CRED:-test:test}"
PASS=0; FAIL=0
ok() { if [ "$2" = "$3" ]; then PASS=$((PASS+1)); printf "  ok  %-58s %s\n" "$1" "$2"; else FAIL=$((FAIL+1)); printf "  XX  %-58s %s (want %s)\n" "$1" "$2" "$3"; fi; }
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
COL="/live-smoke-$$"
LOCK='<D:lockinfo xmlns:D="DAV:"><D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype><D:owner><D:href>smoke</D:href></D:owner></D:lockinfo>'
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
printf '%s' "$LOCK" > "$TMP/lock.xml"

echo "== protocol / auth =="
OPTS=$(curl -s -D - -o /dev/null -X OPTIONS -u "$A" "$B/")
ok "OPTIONS status" "$(echo "$OPTS" | head -1 | tr -d '\r' | awk '{print $2}')" 204
ok "OPTIONS DAV header" "$(echo "$OPTS" | grep -ci '^DAV: 1, 2')" 1
ok "unauthenticated -> 401" "$(code -X PROPFIND -H 'Depth: 0' "$B/")" 401
ok "PROPFIND / -> 207" "$(code -X PROPFIND -H 'Depth: 0' -u "$A" "$B/")" 207
ok "GET nonexistent -> 404" "$(code -u "$A" "$B/nope-404.txt")" 404

echo "== read/write roundtrip =="
ok "MKCOL" "$(code -X MKCOL -u "$A" "$B$COL")" 201
printf 'smoke payload - the quick brown fox\n' > "$TMP/p.txt"
ok "PUT file" "$(code -X PUT -u "$A" --data-binary @"$TMP/p.txt" "$B$COL/f.txt")" 201
curl -s -u "$A" "$B$COL/f.txt" -o "$TMP/g.txt"
ok "GET content byte-exact" "$(cmp -s "$TMP/p.txt" "$TMP/g.txt" && echo same || echo diff)" same
ok "Range GET bytes=2-9 -> 206" "$(code -u "$A" -H 'Range: bytes=2-9' "$B$COL/f.txt")" 206

echo "== HEAD fast path =="
ok "HEAD -> 200" "$(code -I -u "$A" "$B$COL/f.txt")" 200
ok "HEAD content-length" "$(curl -s -I -u "$A" "$B$COL/f.txt" | tr -d '\r ' | grep -i '^content-length:' | cut -d: -f2)" "$(wc -c < "$TMP/p.txt" | tr -d ' ')"
ok "HEAD Range bytes=2-9 -> 206" "$(code -I -u "$A" -H 'Range: bytes=2-9' "$B$COL/f.txt")" 206
ok "HEAD Range content-range" "$(curl -s -I -u "$A" -H 'Range: bytes=2-9' "$B$COL/f.txt" | tr -d '\r ' | grep -i '^content-range:' | cut -d: -f2- | tr -d ' ')" "bytes2-9/$(wc -c < "$TMP/p.txt")"
ok "HEAD unsatisfiable -> 416" "$(code -I -u "$A" -H 'Range: bytes=9999-' "$B$COL/f.txt")" 416
ETAG=$(curl -s -I -u "$A" "$B$COL/f.txt" | tr -d '\r ' | grep -i '^etag:' | cut -d: -f2-)
ok "HEAD label f.txt readable" "$([ -n "$ETAG" ] && echo yes || echo no)" yes
ok "HEAD If-None-Match -> 304" "$(code -I -u "$A" -H "If-None-Match: $ETAG" "$B$COL/f.txt")" 304

echo "== listing cache freshness =="
code -X PROPFIND -H 'Depth: 1' -u "$A" "$B$COL" >/dev/null
ok "PUT after cached listing -> 201" "$(code -X PUT -u "$A" --data fresh "$B$COL/after-cache.txt")" 201
ok "listing sees fresh write" "$(curl -s -u "$A" -X PROPFIND -H 'Depth: 1' "$B$COL" | grep -c 'after-cache.txt')" 1

echo "== dead props =="
PP='<D:propertyupdate xmlns:D="DAV:"><D:set><D:prop><X:s xmlns:X="urn:smoke">v</X:s></D:prop></D:set></D:propertyupdate>'
ok "PROPPATCH set -> 207" "$(code -X PROPPATCH -u "$A" -H 'Content-Type: application/xml' --data "$PP" "$B$COL/f.txt")" 207
ok "PROPFIND reads prop back" "$(curl -s -u "$A" -X PROPFIND -H 'Depth: 0' -H 'Content-Type: application/xml' --data '<D:propfind xmlns:D="DAV:"><D:prop><X:s xmlns:X="urn:smoke"/></D:prop></D:propfind>' "$B$COL/f.txt" | grep -c '>v<')" 1

echo "== locks =="
T=$(curl -s -D - -o /dev/null -X LOCK -u "$A" -H 'Content-Type: application/xml' --data-binary @"$TMP/lock.xml" "$B$COL/f.txt" | grep -i '^lock-token:' | tr -d '\r' | cut -d' ' -f2)
ok "LOCK -> token" "$([ -n "$T" ] && echo yes || echo no)" yes
ok "locked PUT w/o token -> 423" "$(code -X PUT -u "$A" --data x "$B$COL/f.txt")" 423
ok "locked PUT with token -> 204" "$(code -X PUT -u "$A" -H "If: ($T)" --data 'with-token' "$B$COL/f.txt")" 204
ok "body-less LOCK refresh -> 200" "$(code -X LOCK -u "$A" -H "If: ($T)" "$B$COL/f.txt")" 200
ok "UNLOCK -> 204" "$(code -X UNLOCK -u "$A" -H "Lock-Token: $T" "$B$COL/f.txt")" 204
ok "body-less LOCK dead token -> 412" "$(code -X LOCK -u "$A" -H "If: ($T)" "$B$COL/f.txt")" 412

echo "== If header semantics =="
ok "negated forged token PUT -> 201/204" "$(code -X PUT -u "$A" -H 'If: (not <opaquelocktoken:00000000-0000-0000-0000-000000000000:0>)' --data neg "$B$COL/not.txt")" 201
printf 'tag-src\n' > "$TMP/c.txt"
ok "PUT copy source" "$(code -X PUT -u "$A" --data-binary @"$TMP/c.txt" "$B$COL/c.txt")" 201
ok "PUT keep target" "$(code -X PUT -u "$A" --data keep "$B$COL/keep.txt")" 201
ok "PUT tagdest" "$(code -X PUT -u "$A" --data 'dest' "$B$COL/tagdest.txt")" 201
TD=$(curl -s -D - -o /dev/null -X LOCK -u "$A" -H 'Content-Type: application/xml' --data-binary @"$TMP/lock.xml" "$B$COL/tagdest.txt" | grep -i '^lock-token:' | tr -d '\r' | cut -d' ' -f2)
ok "COPY If:<dest>(Td) over locked dest -> 204" "$(code -X COPY -u "$A" -H "Destination: $B$COL/tagdest.txt" -H "If: <$B$COL/tagdest.txt> ($TD)" "$B$COL/c.txt")" 204
ok "DELETE foreign-tagged own token -> 412" "$(code -X DELETE -u "$A" -H "If: <$B$COL/nowhere.txt> ($TD)" "$B$COL/keep.txt")" 412
code -X UNLOCK -u "$A" -H "Lock-Token: $TD" "$B$COL/tagdest.txt" >/dev/null

echo "== copy / move =="
ok "COPY -> 201" "$(code -X COPY -u "$A" -H "Destination: $B$COL/copy.txt" "$B$COL/c.txt")" 201
ok "COPY content correct" "$(curl -s -u "$A" "$B$COL/copy.txt")" "tag-src"
ok "MOVE -> 201" "$(code -X MOVE -u "$A" -H "Destination: $B$COL/moved.txt" "$B$COL/copy.txt")" 201
ok "MOVE source gone -> 404" "$(code -u "$A" "$B$COL/copy.txt")" 404
ok "MOVE dest content correct" "$(curl -s -u "$A" "$B$COL/moved.txt")" "tag-src"

echo "== resumable upload =="
printf 'resumable-bytes-0123456789\n' > "$TMP/r.txt"
SZ=$(wc -c < "$TMP/r.txt")
BEG=$(curl -s -X POST -u "$A" -H 'Content-Type: application/json' -d "{\"path\":\"$COL/r.txt\",\"size\":$SZ}" "$B/.resumable")
UPID=$(printf '%s' "$BEG" | grep -o '"uploadId":"[^"]*"' | cut -d'"' -f4)
ok "begin -> uploadId" "$([ -n "$UPID" ] && echo yes || echo no)" yes
ok "chunk PUT -> 200" "$(code -X PUT -u "$A" --data-binary @"$TMP/r.txt" "$B/.resumable/$UPID/0")" 200
ok "finalize -> 201" "$(code -X POST -u "$A" "$B/.resumable/$UPID/finalize")" 201
cmp -s "$TMP/r.txt" <(curl -s -u "$A" "$B$COL/r.txt") && R=byte-exact || R=diff
ok "uploaded content byte-exact" "$R" byte-exact
ok "finalize replay -> 201" "$(code -X POST -u "$A" "$B/.resumable/$UPID/finalize")" 201

echo "== cleanup =="
ok "DELETE collection -> 204" "$(code -X DELETE -u "$A" "$B$COL")" 204

echo
echo "LIVE SMOKE: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
