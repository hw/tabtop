# Helpers the check scripts share: sourced, as
#   source "$(dirname "$0")/lib.sh"

# free_port is a TCP port free on 127.0.0.1 now.
free_port() { python3 -I -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])'; }

# up URL WHAT SECONDS waits for URL to answer, or says WHAT didn't (and
# fails): not going on to fail later, at a connection refused.
up() {
    local until=$((SECONDS + $3))
    while ((SECONDS < until)); do curl -fs -m 2 "$1" >/dev/null && return; sleep 0.1; done
    echo "FAIL $2 didn't answer in $3 s"
    return 1
}

# wait_healthy CONTAINER SECONDS waits for the container's own health check
# (/usr/local/bin/healthcheck) to pass, or says it didn't, with the end of
# its log (and fails).
wait_healthy() {
    local until=$((SECONDS + $2))
    until docker exec "$1" /usr/local/bin/healthcheck >/dev/null 2>&1; do
        if ((SECONDS >= until)); then
            echo "not ok - $1 didn't become healthy in $2 s; its log ends:" >&2
            docker logs --tail 20 "$1" >&2 2>&1 || true
            return 1
        fi
        sleep 1
    done
}
