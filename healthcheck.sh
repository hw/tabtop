#!/bin/bash
# Docker's HEALTHCHECK: asks tabtopd's healthz endpoint, under WEB_BASE_PATH,
# whether Xvnc is up and logins can work.
set -eu
base="/${WEB_BASE_PATH:-/}/"
while [[ "$base" == *//* ]]; do base="${base//\/\///}"; done
exec 3<>"/dev/tcp/127.0.0.1/${WEB_PORT:-6080}"
printf 'GET %shealthz HTTP/1.0\r\nHost: localhost\r\n\r\n' "$base" >&3
read -r -t 5 status <&3
[[ "$status" == "HTTP/1."?" 200 "* ]]
