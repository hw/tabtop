#!/bin/bash
# Runs browser-check.mjs against a TabTop image: starts a container from it
# and headless Chrome, checks the site through its pages, then checks what
# the pages left in ~/Downloads, and what the zips it downloaded hold.
# Prints the container's log if anything fails. Needs Docker, Node 22 or
# later, Python 3, and Chrome or Chromium (CHROME names it if it isn't
# found).
#
# Usage: test/browser-check.sh <image>
set -euo pipefail

image=${1:?usage: $0 <image>}
here=$(cd "$(dirname "$0")" && pwd)
chrome=${CHROME:-$(command -v google-chrome || command -v chromium || command -v chromium-browser || true)}
[[ -n "$chrome" ]] || { echo "Chrome isn't installed; set CHROME to it" >&2; exit 1; }
work=$(mktemp -d)
name=tabtop-check-$$
chrome_pid=

cleanup() {
    status=$?
    if ((status != 0)); then
        echo "--- container log"
        docker logs "$name" 2>&1 | tail -n 60 || true
    fi
    [[ -n "$chrome_pid" ]] && kill "$chrome_pid" 2>/dev/null
    docker rm -f "$name" >/dev/null 2>&1 || true
    rm -rf "$work"
    exit "$status"
}
trap cleanup EXIT

# The secret is the Base32 of "12345678901234567890", which
# browser-check.mjs makes its codes from.
docker run -d --name "$name" -p 127.0.0.1::6080 -e VNC_USER=user \
    -e VNC_TOTP_SECRET=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ "$image" >/dev/null
site="http://$(docker port "$name" 6080/tcp | head -n 1)/"
for ((i = 0; ; i++)); do
    docker exec "$name" /usr/local/bin/healthcheck 2>/dev/null && break
    ((i < 120)) || { echo "the container didn't become healthy" >&2; exit 1; }
    sleep 1
done
echo "site: $site"

in_container() { docker exec -u user "$name" sh -c "$1"; }
in_container 'echo hello from the desktop > ~/Downloads/hello.txt'
# A second of a 440 Hz tone, to preview.
python3 -c 'import math, struct, sys, wave
w = wave.open(sys.argv[1], "wb")
w.setnchannels(1); w.setsampwidth(2); w.setframerate(8000)
w.writeframes(b"".join(struct.pack("<h", int(8000 * math.sin(i * 2 * math.pi * 440 / 8000))) for i in range(8000)))' "$work/tone.wav"
in_container 'mkdir ~/Downloads/media'
docker cp -q "$work/tone.wav" "$name:/home/user/Downloads/media/tone.wav"
docker exec "$name" chown user /home/user/Downloads/media/tone.wav
head -c 300000 /dev/urandom >"$work/up.bin"
truncate -s 1G "$work/big.bin"
mkdir -p "$work/up-folder/sub/deeper" "$work/up-folder/empty" "$work/downloads" "$work/chrome"
for f in a.txt sub/b.txt sub/deeper/c.txt; do echo "$f" >"$work/up-folder/$f"; done
echo dropped >"$work/drop me.txt"

# --no-sandbox: CI runners don't allow Chrome's sandbox, and the browser
# only visits this container.
"$chrome" --headless=new --no-sandbox --no-first-run --remote-debugging-port=0 \
    --user-data-dir="$work/chrome" --autoplay-policy=no-user-gesture-required \
    about:blank >"$work/chrome.log" 2>&1 &
chrome_pid=$!
for ((i = 0; ; i++)); do
    [[ -s "$work/chrome/DevToolsActivePort" ]] && break
    ((i < 100)) || { cat "$work/chrome.log"; echo "Chrome didn't start" >&2; exit 1; }
    sleep 0.2
done
port=$(head -n 1 "$work/chrome/DevToolsActivePort")

timeout 420 node "$here/browser-check.mjs" "$port" "$site" "$work/downloads" "$work"

# What the pages did, as the container sees it.
holds() {
    local got
    got=$(in_container "cat ~/Downloads/\"$1\"" 2>&1) || true
    [[ "$got" == "$2" ]] || { echo "not ok - ~/Downloads/$1 holds \"$got\", not \"$2\""; exit 1; }
}
holds tty-check.txt tty-42
holds b.txt sub/b.txt
holds keys.txt keys-ok
holds notice.txt saved
holds dropped-copy.txt dropped
holds renewed.txt renewed
for d in up-folder "up-folder (2)"; do
    for f in a.txt sub/b.txt sub/deeper/c.txt; do holds "$d/$f" "$f"; done
done
# A dropped folder keeps its empty folders; browsers leave them out of a
# picked one.
in_container 'test -d ~/Downloads/"up-folder (2)/empty"' || { echo "not ok - the dropped folder's empty folder is missing"; exit 1; }
for p in up.bin "up-folder (1)" hello.txt renamed.txt made-here big.bin; do
    in_container "test ! -e ~/Downloads/\"$p\"" || { echo "not ok - $p wasn't deleted"; exit 1; }
done
echo "ok - ~/Downloads holds what the pages left there"
leftover=$(in_container 'find ~/Downloads -name ".tabtop-upload-*"')
[[ -z "$leftover" ]] || { echo "not ok - the cancelled upload left $leftover"; exit 1; }

# The zips, as downloaded.
zipped() {
    python3 -c 'import sys, zipfile; print(" ".join(sorted(zipfile.ZipFile(sys.argv[1]).namelist())))' "$work/downloads/$1"
}
folder='up-folder/ up-folder/a.txt up-folder/sub/ up-folder/sub/b.txt up-folder/sub/deeper/ up-folder/sub/deeper/c.txt'
for z in "up-folder.zip:$folder" "Downloads.zip:hello.txt $folder"; do
    got=$(zipped "${z%%:*}")
    [[ "$got" == "${z#*:}" ]] || { echo "not ok - ${z%%:*} holds $got"; exit 1; }
done
echo "ok - the zips hold what they should"
