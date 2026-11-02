#!/bin/bash
# Checks the external-VNC startup path, account provisioning and restart.
# Usage: test/startup-check.sh <image>
set -euo pipefail
image=${1:?usage: $0 <image>}
name=tabtop-startup-check-$$
cleanup() {
    status=$?
    if ((status)); then docker logs "$name-gateway" 2>&1 | tail -25 || true; fi
    docker rm -f "$name-gateway" "$name-rfb" >/dev/null 2>&1 || true
    docker network rm "$name" >/dev/null 2>&1 || true
    exit "$status"
}
trap cleanup EXIT
docker network create "$name" >/dev/null
docker run -d --name "$name-rfb" --network "$name" --entrypoint Xvnc "$image" :2 -rfbport 5902 -SecurityTypes None -geometry 800x600 >/dev/null
docker run -d --name "$name-gateway" --network "$name" -e VNC_ADDR="$name-rfb:5902" -e WEB_AUDIO=0 -e VNC_USER=remoteuser -e VNC_TOTP_SECRET=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ "$image" >/dev/null
for ((i=0;i<30;i++)); do
    if docker exec "$name-gateway" /usr/local/bin/healthcheck >/dev/null 2>&1; then break; fi
    sleep 1
done
docker exec "$name-gateway" /usr/local/bin/healthcheck
docker exec "$name-gateway" bash -ec '
    if pgrep -x Xvnc >/dev/null; then exit 1; fi
    test "$(stat -c %U /home/remoteuser/.config/tabtop/users.oath)" = remoteuser
    test "$(stat -c %a /tmp/runtime-remoteuser)" = 700
'
docker exec -u remoteuser "$name-gateway" bash -ec '
    pid=$(pgrep -x tabtopd)
    environment=$(tr "\0" "\n" < /proc/$pid/environ)
    if [[ "$environment" == *VNC_TOTP_SECRET=* ]]; then exit 1; fi
'
echo 'ok - external VNC, custom account, credentials, runtime permissions and secret removal'
docker restart "$name-gateway" >/dev/null
for ((i=0;i<30;i++)); do
    if docker exec "$name-gateway" /usr/local/bin/healthcheck >/dev/null 2>&1; then break; fi
    sleep 1
done
docker exec "$name-gateway" /usr/local/bin/healthcheck
echo 'ok - restart with an existing account and home'
