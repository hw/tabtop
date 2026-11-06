#!/bin/bash
# Check independently disabled services in a built image.
# Usage: bash test/features-check.sh <image>
set -euo pipefail
image=${1:?usage: $0 <image>}
name=tabtop-features-check-$$
cleanup() {
    status=$?
    if ((status)); then docker logs "$name" 2>&1 | tail -40 || true; fi
    docker rm -f "$name" >/dev/null 2>&1 || true
    exit "$status"
}
trap cleanup EXIT

for settings in '0 0 1' '0 1 0' '1 0 0'; do
    read -r vnc tty files <<< "$settings"
    docker run -d --name "$name" -p 127.0.0.1::6080 \
        -e WEB_VNC="$vnc" -e WEB_TTY="$tty" -e WEB_FS="$files" \
        -e WEB_AUDIO="$((1 - vnc))" \
        -e VNC_TOTP_SECRET=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ "$image" >/dev/null
    for ((i=0;i<30;i++)); do
        if docker exec "$name" /usr/local/bin/healthcheck >/dev/null 2>&1; then break; fi
        sleep 1
    done
    docker exec "$name" /usr/local/bin/healthcheck
    site="http://$(docker port "$name" 6080/tcp | head -n 1)"
    python3 - "$site" "$vnc" "$tty" "$files" <<'PY'
import json, re, sys, urllib.error, urllib.request
site = sys.argv[1]
enabled = dict(zip(('desktop', 'terminal', 'files'), map(lambda x: x == '1', sys.argv[2:])))
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args): return None
client = urllib.request.build_opener(NoRedirect)
def get(path):
    try: return client.open(site + path, timeout=5)
    except urllib.error.HTTPError as e: return e
for path, feature in [('/vnc.html', 'desktop'), ('/tty/', 'terminal'), ('/fs/', 'files')]:
    r = get(path)
    assert r.code == (200 if enabled[feature] else 404), (path, r.code, enabled)
source = get('/tabtop/nav.js').read().decode()
actual = json.loads(re.search(r'const enabledPages = (.*);', source)[1])
assert actual == enabled, actual
if not enabled['files']:
    assert get('/fs/AAAAAAAAAAAAAAAAAAAAAA/file.txt').code == 404
if not enabled['desktop']:
    r = get('/')
    assert r.code == 303 and r.headers['Location'] == ('/tty/' if enabled['terminal'] else '/fs/')
PY
    docker exec "$name" bash -ec '
        if pgrep -x Xvnc >/dev/null; then test "$1" = 1; else test "$1" = 0; fi
        if [ "$1" = 0 ]; then
            ! pgrep -x pipewire >/dev/null
            ! pgrep -x wireplumber >/dev/null
            ! pgrep -x pipewire-pulse >/dev/null
            ! pgrep -x xfce4-session >/dev/null
        fi
    ' bash "$vnc"
    echo "ok - WEB_VNC=$vnc WEB_TTY=$tty WEB_FS=$files: startup, routes, navigation, shares and health"
    docker rm -f "$name" >/dev/null
done

for feature in WEB_VNC WEB_TTY WEB_FS; do
    if output=$(docker run --rm -e "$feature=2" "$image" 2>&1); then
        echo "$feature accepted an invalid value" >&2; exit 1
    fi
    [[ "$output" == *"$feature must be 0 or 1"* ]]
done
if output=$(docker run --rm -e WEB_VNC=0 -e WEB_TTY=0 -e WEB_FS=0 "$image" 2>&1); then
    echo 'All services disabled was accepted' >&2; exit 1
fi
[[ "$output" == *'Enable at least one'* ]]
echo 'ok - invalid switches and disabling all services are rejected'
