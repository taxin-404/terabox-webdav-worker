#!/usr/bin/env bash
# Live WebDAV compliance test against a deployed terabox worker.
#
# Usage:
#   WEBDAV_USER=alice WEBDAV_PASS=secret \
#   WEBDAV_URL=https://terabox.example.workers.dev \
#   bash test/live/webdav-livetest.sh
#
# Read-only checks run first; write checks use a timestamped scratch folder
# (/wtest-<epoch>) that is deleted at the end. No credentials are stored here.
set -u

URL="${WEBDAV_URL:-https://terabox.taxin-404.workers.dev}"
USER="${WEBDAV_USER:?set WEBDAV_USER}"
PASS="${WEBDAV_PASS:?set WEBDAV_PASS}"
AUTH="$USER:$PASS"

# File known to exist in the test account (override for other accounts).
SAMPLE_FILE="${WEBDAV_SAMPLE_FILE:-/BackupFolder/screenshot-2026-07-21_12-58-20.png}"

PASS_N=0; FAIL_N=0
results=()

check() { # check <name> <expected> <actual>
  if [ "$2" = "$3" ]; then
    PASS_N=$((PASS_N+1)); results+=("PASS  $1  ($3)")
  else
    FAIL_N=$((FAIL_N+1)); results+=("FAIL  $1  expected=$2 actual=$3")
  fi
}

code() { curl -s -o /dev/null --max-time 60 -w '%{http_code}' "$@"; }
body() { curl -s --max-time 60 "$@"; }

echo "--- read-only tests ---"

check "no-auth PROPFIND 401" 401 "$(code -X PROPFIND "$URL/")"
check "wrong-pass 401" 401 "$(code -u "$AUTH:wrong" -X PROPFIND "$URL/")"
check "OPTIONS 204" 204 "$(code -u "$AUTH" -X OPTIONS "$URL/")"
check "PROPFIND d0 root 207" 207 "$(code -u "$AUTH" -X PROPFIND -H 'Depth: 0' "$URL/")"
check "PROPFIND d1 root 207" 207 "$(code -u "$AUTH" -X PROPFIND -H 'Depth: 1' "$URL/")"
check "PROPFIND missing 404" 404 "$(code -u "$AUTH" -X PROPFIND -H 'Depth: 0' "$URL/definitely-not-here-xyz/")"
check "bad-encoding 400" 400 "$(code -u "$AUTH" -X PROPFIND "$URL/%E0%A4%A")"
check "unknown method 405" 405 "$(code -u "$AUTH" -X FOO "$URL/")"

check "PROPFIND file d0 207" 207 "$(code -u "$AUTH" -X PROPFIND -H 'Depth: 0' "$URL$SAMPLE_FILE")"
check "GET file 200" 200 "$(code -u "$AUTH" "$URL$SAMPLE_FILE")"
ct=$(curl -s -o /dev/null --max-time 60 -u "$AUTH" -w '%{content_type}' "$URL$SAMPLE_FILE")
check "GET content-type image/png" "image/png" "$ct"

hrange=$(curl -s -i --max-time 60 -u "$AUTH" -H 'Range: bytes=0-99' "$URL$SAMPLE_FILE" | head -1)
case "$hrange" in *206*) check "GET Range 206" 206 206 ;; *) check "GET Range 206" 206 "$hrange" ;; esac

hout=$(curl -s -I --max-time 60 -u "$AUTH" "$URL$SAMPLE_FILE")
hcode=$(printf '%s' "$hout" | head -1 | awk '{print $2}')
check "HEAD 200" 200 "$hcode"
check "HEAD has content-length" yes "$(printf '%s' "$hout" | grep -qi content-length && echo yes || echo no)"

check "GET folder 405" 405 "$(code -u "$AUTH" "$URL/mern/")"
check "GET missing 404" 404 "$(code -u "$AUTH" "$URL/no-such-file-xyz.txt")"

echo "--- write tests (scratch folder) ---"
STAMP=$(date +%s)
T="/wtest-$STAMP"

check "MKCOL 201" 201 "$(code -u "$AUTH" -X MKCOL "$URL$T")"
check "MKCOL existing 405" 405 "$(code -u "$AUTH" -X MKCOL "$URL$T")"
check "MKCOL root 403" 403 "$(code -u "$AUTH" -X MKCOL "$URL/")"

check "PUT new 201" 201 "$(code -u "$AUTH" -X PUT -d 'hello live world' "$URL$T/a.txt")"
check "GET roundtrip" "hello live world" "$(body -u "$AUTH" "$URL$T/a.txt")"
check "PUT overwrite 204" 204 "$(code -u "$AUTH" -X PUT -d 'replaced!' "$URL$T/a.txt")"
check "PUT overwrite content" "replaced!" "$(body -u "$AUTH" "$URL$T/a.txt")"
check "PUT empty 201" 201 "$(code -u "$AUTH" -X PUT -d '' "$URL$T/empty.bin")"
check "PUT root 403" 403 "$(code -u "$AUTH" -X PUT -d 'x' "$URL/")"

# large PUT (>4 MiB free-plan chunk → exercises the chunked upload path)
TMPD=$(mktemp -d)
head -c 5242880 /dev/urandom > "$TMPD/big.bin"
want=$(md5sum "$TMPD/big.bin" | cut -d' ' -f1)
check "PUT 5MiB 201" 201 "$(code -u "$AUTH" -X PUT --upload-file "$TMPD/big.bin" "$URL$T/big.bin")"
curl -s --max-time 300 -u "$AUTH" "$URL$T/big.bin" -o "$TMPD/big.dl"
got=$(md5sum "$TMPD/big.dl" | cut -d' ' -f1)
check "5MiB md5 roundtrip" "$want" "$got"

check "MOVE new 201" 201 "$(code -u "$AUTH" -X MOVE -H "Destination: $URL$T/b.txt" "$URL$T/a.txt")"
check "MOVE source gone" 404 "$(code -u "$AUTH" -X PROPFIND -H 'Depth: 0' "$URL$T/a.txt")"
check "COPY new 201" 201 "$(code -u "$AUTH" -X COPY -H "Destination: $URL$T/c.txt" "$URL$T/b.txt")"
check "COPY keeps source" 200 "$(code -u "$AUTH" "$URL$T/b.txt")"
check "COPY OF 412" 412 "$(code -u "$AUTH" -X COPY -H "Destination: $URL$T/c.txt" -H 'Overwrite: F' "$URL$T/b.txt")"
check "COPY OT 204" 204 "$(code -u "$AUTH" -X COPY -H "Destination: $URL$T/c.txt" -H 'Overwrite: T' "$URL$T/b.txt")"
check "MOVE self 204" 204 "$(code -u "$AUTH" -X MOVE -H "Destination: $URL$T/c.txt" "$URL$T/c.txt")"
check "COPY self 403" 403 "$(code -u "$AUTH" -X COPY -H "Destination: $URL$T/c.txt" "$URL$T/c.txt")"
check "MOVE no-dest 400" 400 "$(code -u "$AUTH" -X MOVE "$URL$T/b.txt")"
check "MOVE missing 404" 404 "$(code -u "$AUTH" -X MOVE -H "Destination: $URL$T/z.txt" "$URL$T/nope.txt")"

# RFC 4918 §9.1: PUT does not auto-create parents — missing parent is 409.
check "PUT missing parent 409" 409 "$(code -u "$AUTH" -X PUT -d 'nested' "$URL$T/sub/deep/file.txt")"
check "MKCOL sub 201" 201 "$(code -u "$AUTH" -X MKCOL "$URL$T/sub")"
check "MKCOL deep 201" 201 "$(code -u "$AUTH" -X MKCOL "$URL$T/sub/deep")"
check "PUT nested after MKCOLs 201" 201 "$(code -u "$AUTH" -X PUT -d 'nested' "$URL$T/sub/deep/file.txt")"
check "nested PROPFIND 207" 207 "$(code -u "$AUTH" -X PROPFIND -H 'Depth: 0' "$URL$T/sub/deep/file.txt")"

check "MKCOL movedir 201" 201 "$(code -u "$AUTH" -X MKCOL "$URL$T/movedir")"
check "PUT in subdir 201" 201 "$(code -u "$AUTH" -X PUT -d 'in' "$URL$T/movedir/x.txt")"
check "MOVE dir 201" 201 "$(code -u "$AUTH" -X MOVE -H "Destination: $URL$T/movedir2" "$URL$T/movedir")"
check "moved child visible" 200 "$(code -u "$AUTH" "$URL$T/movedir2/x.txt")"

check "DELETE file 204" 204 "$(code -u "$AUTH" -X DELETE "$URL$T/b.txt")"
check "DELETE missing 404" 404 "$(code -u "$AUTH" -X DELETE "$URL$T/b.txt")"
check "DELETE root 403" 403 "$(code -u "$AUTH" -X DELETE "$URL/")"

echo "--- cleanup ---"
for p in c.txt empty.bin big.bin sub/deep/file.txt movedir2/x.txt; do
  curl -s -o /dev/null --max-time 60 -u "$AUTH" -X DELETE "$URL$T/$p"
done
curl -s -o /dev/null --max-time 60 -u "$AUTH" -X DELETE "$URL$T/sub/deep"
curl -s -o /dev/null --max-time 60 -u "$AUTH" -X DELETE "$URL$T/sub"
curl -s -o /dev/null --max-time 60 -u "$AUTH" -X DELETE "$URL$T/movedir2"
rmdir_code=$(code -u "$AUTH" -X DELETE "$URL$T")
check "cleanup DELETE dir 204" 204 "$rmdir_code"
check "scratch folder gone" 404 "$(code -u "$AUTH" -X PROPFIND -H 'Depth: 0' "$URL$T/")"

rm -rf "$TMPD"

echo ""
echo "=================== RESULTS ==================="
for r in "${results[@]}"; do echo "$r"; done
echo "==============================================="
echo "PASS: $PASS_N  FAIL: $FAIL_N"
[ "$FAIL_N" -eq 0 ]
