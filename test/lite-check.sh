#!/bin/bash
# Checks an image built without its own desktop (DESKTOP=none, tabtop-lite):
# that it leaves the desktop out, refuses to start without VNC_ADDR, and,
# given an RFB server, serves it and the rest of the site. The RFB server
# is Xvnc from a full image, in a container of its own on a network with
# the gateway. Prints the gateway's log if anything fails. Needs Docker.
#
# Usage: test/lite-check.sh <lite image> <full image>
set -euo pipefail

lite=${1:?usage: $0 <lite image> <full image>}
full=${2:?usage: $0 <lite image> <full image>}
name=tabtop-lite-check-$$
net=$name

cleanup() {
    status=$?
    if ((status != 0)); then
        echo "--- gateway log"
        docker logs "$name" 2>&1 | tail -n 40 || true
    fi
    docker rm -f "$name" "$name-rfb" >/dev/null 2>&1 || true
    docker network rm "$net" >/dev/null 2>&1 || true
    exit "$status"
}
trap cleanup EXIT

missing=$(docker run --rm --entrypoint sh "$lite" -c \
    'for c in Xvnc startxfce4 chromium pipewire; do command -v "$c" >/dev/null && echo "$c"; done; true')
[[ -z "$missing" ]] || { echo "not ok - the image has ${missing//$'\n'/, }"; exit 1; }
echo "ok - no desktop in the image"

out=$(timeout 60 docker run --rm "$lite" 2>&1) && { echo "not ok - it started without VNC_ADDR"; exit 1; }
[[ "$out" == *"set VNC_ADDR"* ]] || { echo "not ok - without VNC_ADDR, it said: $out"; exit 1; }
echo "ok - refuses to start without VNC_ADDR"

docker network create "$net" >/dev/null
docker run -d --name "$name-rfb" --network "$net" --entrypoint Xvnc "$full" \
    :2 -rfbport 5902 -SecurityTypes None -geometry 800x600 >/dev/null
docker run -d --name "$name" --network "$net" -p 127.0.0.1::6080 \
    -e VNC_ADDR="$name-rfb:5902" -e WEB_DOCTOR_ENDPOINT=1 \
    -e VNC_TOTP_SECRET=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ "$lite" >/dev/null
site="http://$(docker port "$name" 6080/tcp | head -n 1)/"
for ((i = 0; ; i++)); do
    docker exec "$name" /usr/local/bin/healthcheck 2>/dev/null && break
    ((i < 60)) || { echo "not ok - the container didn't become healthy" >&2; exit 1; }
    sleep 1
done
echo "ok - healthy with the RFB server at $name-rfb:5902"

# Every part the doctor report checks works; it names the RFB server
# without connecting to it.
curl -fsS "${site}doctor" | python3 -c '
import json, sys
checks = json.load(sys.stdin)["checks"]
bad = {k: v["detail"] for k, v in checks.items() if not v["ok"]}
if bad:
    sys.exit(f"not ok - the doctor report has failures: {bad}")
vnc = checks["vnc"]["detail"]
if "at VNC_ADDR" not in vnc:
    sys.exit(f"not ok - the RFB server: {vnc}")
'
echo "ok - the doctor report has no failures"

for page in vnc.html tty/ fs/; do
    curl -fsS -o /dev/null "$site$page" || { echo "not ok - $page didn't load"; exit 1; }
done
echo "ok - the desktop, terminal and files pages load"
