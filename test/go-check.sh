#!/bin/bash
# Checks the remote browser (/go) end to end: tabtopd built from this tree,
# with a Moli engine; a test site in a Docker container, at a private
# address that isn't this machine's (one the engine may reach with
# -go-private, as it would a NAS); and headless Chrome on the /go page (see
# go-check.mjs). Needs Go, Docker, Node 22 or later, Chrome or Chromium
# (CHROME names it if it isn't found), a Moli binary (MOLI), and a TabTop
# image to take the noble library from (TABTOP_IMAGE, default
# tabtop-lite:latest).
#
# Usage: MOLI=/path/to/moli test/go-check.sh
#
# With GO_IMAGE set to a TabTop image instead, it checks that image as it
# ships: its own tabtopd, Moli and bubblewrap, in a container run with the
# seccomp profile /go needs (docs/environment.md, WEB_GO); first, that with
# Docker's default settings it starts and says /go is unavailable.
# GO_UNSANDBOXED=1 checks it with Docker's default settings and
# WEB_GO_UNSANDBOXED=1 (with GO_IMAGE only). GO_ENGINE selects the configured
# engine binary (it must be present in the image). WEB_BASE_PATH=/tabtop/ serves
# it all under that path (-base-path, or the image's WEB_BASE_PATH), as
# behind a proxy.
set -euo pipefail

go_image=${GO_IMAGE:-}
base_path=${WEB_BASE_PATH:-/}
[[ "$base_path" == /* ]] || base_path="/$base_path"
[[ "$base_path" == */ ]] || base_path="$base_path/"
[[ "${GO_UNSANDBOXED:-}" != 1 || -n "$go_image" ]] || { echo "GO_UNSANDBOXED=1 needs GO_IMAGE" >&2; exit 2; }
[[ -n "$go_image" ]] || moli=${MOLI:?set MOLI to a Moli binary, or GO_IMAGE to a TabTop image}
image=${TABTOP_IMAGE:-${go_image:-tabtop-lite:latest}}
here=$(cd "$(dirname "$0")" && pwd)
chrome=${CHROME:-$(command -v google-chrome || command -v chromium || command -v chromium-browser || true)}
[[ -n "$chrome" ]] || { echo "Chrome isn't installed; set CHROME to it" >&2; exit 1; }
work=$(mktemp -d)
site=tabtop-go-site-$$
ads=tabtop-go-ads-$$
box=tabtop-go-box-$$
tabtopd_pid= chrome_pid= watched_pid=

cleanup() {
    status=$?
    if ((status != 0)) && [[ -f "$work/tabtopd.log" ]]; then
        echo "--- tabtopd log"
        tail -n 60 "$work/tabtopd.log"
    fi
    [[ -n "$tabtopd_pid" ]] && kill "$tabtopd_pid" 2>/dev/null || true
    [[ -n "$chrome_pid" ]] && kill "$chrome_pid" 2>/dev/null || true
    if ((status != 0)) && [[ -n "$go_image" ]]; then
        echo "--- container log"
        docker logs "$box" 2>&1 | tail -n 60
    fi
    docker rm -f "$site" "$ads" "$box" >/dev/null 2>&1 || true
    wait 2>/dev/null || true
    rm -rf "$work"
    exit "$status"
}
trap cleanup EXIT

free_port() { python3 -I -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])'; }

if [[ -z "$go_image" ]]; then
    echo "building tabtopd"
    (cd "$here/../tabtopd" && go build -o "$work/tabtopd" .)
fi
cid=$(docker create "$image")
docker cp -q "$cid:/opt/noble" "$work/noble"
docker rm "$cid" >/dev/null
# The login's secret is "12345678901234567890" (see go-check.mjs).
printf 'HOTP/T30/6\tuser\t-\t%s\n' "$(printf 12345678901234567890 | od -An -tx1 | tr -d ' \n')" > "$work/users.oath"
mkdir -p "$work/downloads" "$work/site"

node "$here/go-check.mjs" site "$work/site"
docker run -d --name "$site" -v "$work/site:/srv:ro" node:24-slim node /srv/serve.js >/dev/null
site_ip=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$site")
for _ in $(seq 50); do curl -fs "http://$site_ip/index.html" >/dev/null && break; sleep 0.1; done
# The same site at another address: another site's, for a page's ads.
docker run -d --name "$ads" -v "$work/site:/srv:ro" node:24-slim node /srv/serve.js >/dev/null
ads_ip=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$ads")
for _ in $(seq 50); do curl -fs -m 1 "http://$ads_ip/index.html" >/dev/null && break; sleep 0.1; done

port=$(free_port)
if [[ -n "$go_image" ]]; then
    docker run -d --name "$box" -e VNC_USER=tester -e WEB_VNC=0 -e WEB_GO=1 "$go_image" >/dev/null
    for _ in $(seq 100); do docker logs "$box" 2>&1 | grep -q "remote browser" && break; sleep 0.2; done
    line=$(docker logs "$box" 2>&1 | grep -m1 "remote browser" || true)
    [[ "$line" == *"remote browser unavailable: bubblewrap can't make its sandbox here"* ]] || {
        echo "FAIL with Docker's default settings, /go should be unavailable: ${line:-no word of it}"; exit 1; }
    sleep 1
    [[ "$(docker inspect -f '{{.State.Running}}' "$box")" == true ]] || { echo "FAIL it didn't keep running without /go"; exit 1; }
    echo "ok   with Docker's default settings it runs, /go unavailable (${line#*: })"
    docker rm -f "$box" >/dev/null

    # The same secret, in Base32.
    files=(); [[ "${GO_NO_FS:-}" == 1 ]] && files=(-e WEB_FS=0)
    security=(--security-opt seccomp="$here/../scripts/go-seccomp/tabtop-go.json" --security-opt apparmor=unconfined)
    [[ "${GO_UNSANDBOXED:-}" == 1 ]] && security=(-e WEB_GO_UNSANDBOXED=1)
    docker run -d --name "$box" -p "127.0.0.1:$port:6080" "${security[@]}" \
        -e VNC_USER=tester -e VNC_TOTP_SECRET=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ -e WEB_VNC=0 "${files[@]}" \
        -e WEB_GO=1 -e WEB_GO_PRIVATE=1 -e WEB_GO_FETCH_PRIVATE=1 -e WEB_BASE_PATH="$base_path" -e TABTOP_GO_DEBUG=1 -e WEB_GO_ENGINE="${GO_ENGINE:-moli}" "$go_image" >/dev/null
    for _ in $(seq 100); do curl -fs "http://127.0.0.1:$port${base_path}go/" >/dev/null && break; sleep 0.2; done
    docker logs "$box" 2>&1 | grep -m1 "remote browser" || true
    watched_pid=$(docker inspect -f '{{.State.Pid}}' "$box")  # the container's, for the memory sampling
else
    # GO_NO_FS=1 checks it with file support off (WEB_FS=0).
    files=(-downloads-dir "$work/downloads")
    [[ "${GO_NO_FS:-}" == 1 ]] && files=(-disable-fs)
    TABTOP_GO_DEBUG=1 "$work/tabtopd" -listen "127.0.0.1:$port" -users-file "$work/users.oath" -noble-dir "$work/noble" \
        -disable-vnc "${files[@]}" -fetch=true -fetch-private=true \
        -go -go-engine "$moli" -go-private -base-path "$base_path" > "$work/tabtopd.log" 2>&1 &
    tabtopd_pid=$! watched_pid=$!
    for _ in $(seq 100); do curl -fs "http://127.0.0.1:$port${base_path}go/" >/dev/null && break; sleep 0.1; done
    grep -m1 "remote browser" "$work/tabtopd.log" || true
fi

cport=$(free_port)
"$chrome" --headless=new --remote-debugging-port="$cport" --user-data-dir="$work/chrome" --no-first-run \
    --no-default-browser-check about:blank > "$work/chrome.log" 2>&1 &
chrome_pid=$!
for _ in $(seq 100); do curl -fs "http://127.0.0.1:$cport/json/version" >/dev/null && break; sleep 0.1; done

# The most memory tabtopd and the engines used, sampled through the check
# (GO_SOAK=N makes it a long session; see go-check.mjs).
# tree_rss PID prints the resident memory (KiB) of tabtopd, the first
# tabtopd at or under PID, and the largest engine (moli) under it.
tree_rss() {
    ps -e -o pid=,ppid=,rss=,comm= | awk -v root="$1" '
        { parent[$1] = $2; rss[$1] = $3; name[$1] = $4 }
        END {
            for (p in parent) { q = p; while (q != "" && q != root && q != 0 && q != 1) q = parent[q]; if (q == root) under[p] = 1 }
            under[root] = 1
            for (p in under) if (name[p] == "tabtopd" && (t == "" || p + 0 < t + 0)) t = p
            for (p in under) { q = p; while (q != "" && q != t && q != 0 && q != 1) q = parent[q]; if (q == t && name[p] == "moli" && rss[p] > e) e = rss[p] }
            print e + 0, rss[t] + 0
        }'
}
( peak_engine=0 peak_tabtopd=0
  while [[ -d /proc/$watched_pid ]]; do
      read -r e t < <(tree_rss "$watched_pid")
      ((${e:-0} > peak_engine)) && peak_engine=${e:-0}; ((${t:-0} > peak_tabtopd)) && peak_tabtopd=${t:-0}
      echo "$peak_engine $peak_tabtopd" > "$work/peak"; sleep 1
  done ) &
node "$here/go-check.mjs" check "http://127.0.0.1:$port$base_path" "$cport" "http://$site_ip/" "http://$ads_ip/"
read -r peak_engine peak_tabtopd < "$work/peak" || true
echo "ok   the most memory used: an engine $((${peak_engine:-0} / 1024)) MiB, tabtopd $((${peak_tabtopd:-0} / 1024)) MiB"
if [[ "${GO_NO_FS:-}" != 1 ]]; then
    [[ -n "$go_image" ]] && docker cp -q "$box:/home/tester/Downloads/doc.pdf" "$work/downloads/doc.pdf" 2>/dev/null
    cmp -s "$work/site/doc.pdf" "$work/downloads/doc.pdf" || { echo "FAIL the PDF wasn't saved into Downloads as it is"; exit 1; }
    echo "ok   the PDF is in Downloads, as the site serves it"
fi
