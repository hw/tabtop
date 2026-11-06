# Sourced by entrypoint.sh as root, before provisioning or process startup.
# Input: container environment. Output: validated and normalized settings.
VNC_USER="${VNC_USER:-user}"
VNC_GEOMETRY="${VNC_GEOMETRY:-1600x900}"
VNC_DEPTH="${VNC_DEPTH:-24}"
VNC_RESIZE="${VNC_RESIZE:-remote}"
VNC_ADDR="${VNC_ADDR:-}"
VNC_X509="${VNC_X509:-0}"
VNC_UPSTREAM_USERNAME="${VNC_UPSTREAM_USERNAME:-}"
VNC_CA_FILE="${VNC_CA_FILE:-}"
VNC_SERVER_NAME="${VNC_SERVER_NAME:-}"
WEB_PORT="${WEB_PORT:-6080}"
WEB_VNC="${WEB_VNC:-1}"
WEB_FS="${WEB_FS:-1}"
WEB_BASE_PATH="${WEB_BASE_PATH:-/}"
WEB_TRUSTED_PROXIES="${WEB_TRUSTED_PROXIES:-}"
WEB_TRUST_NPROXIES="${WEB_TRUST_NPROXIES:-0}"
WEB_AUDIO="${WEB_AUDIO:-1}"
WEB_MIC="${WEB_MIC:-1}"
WEB_SHARE="${WEB_SHARE:-1}"
WEB_FETCH="${WEB_FETCH:-1}"
WEB_FETCH_PRIVATE="${WEB_FETCH_PRIVATE:-0}"
WEB_AUDIO_BITRATE="${WEB_AUDIO_BITRATE:-64}"
WEB_AUDIO_SERVER="${WEB_AUDIO_SERVER:-}"
WEB_AUDIO_SINK="${WEB_AUDIO_SINK:-}"
WEB_TTY="${WEB_TTY:-1}"
WEB_TTY_COMMAND="${WEB_TTY_COMMAND:-}"
WEB_DOCTOR_ENDPOINT="${WEB_DOCTOR_ENDPOINT:-0}"
WEB_SESSION_MAX="${WEB_SESSION_MAX:-12h}"
WEB_SESSION_IDLE="${WEB_SESSION_IDLE:-1h}"
WEB_E2E="${WEB_E2E:-}"
DISPLAY_NUM=1

for VAR in WEB_VNC WEB_TTY WEB_FS; do
    case "${!VAR}" in
        0|1) ;;
        *) echo "${VAR} must be 0 or 1 (got '${!VAR}')." >&2; exit 1 ;;
    esac
done
if [ "$WEB_VNC$WEB_TTY$WEB_FS" = 000 ]; then
    echo "Enable at least one of WEB_VNC, WEB_TTY or WEB_FS." >&2
    exit 1
fi
if [ "$WEB_VNC" = 0 ]; then
    WEB_AUDIO=0
    WEB_MIC=0
fi

# VNC_USER: a plain user name. One of the image's own accounts (root, or a
# system account such as daemon, whose home is /usr/sbin) is refused: the
# desktop, terminal and gateway would run as it, and its home's files would
# be handed to it. One the container made itself on an earlier start, from
# uid 1000, is used again.
if ! [[ "$VNC_USER" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]]; then
    echo "VNC_USER must be a user name: lowercase letters, digits, _ and -, starting with a letter or _ (got '${VNC_USER}')." >&2
    exit 1
fi
if VNC_USER_UID="$(id -u "$VNC_USER" 2>/dev/null)" && { [ "$VNC_USER_UID" -lt 1000 ] || [ "$VNC_USER_UID" -ge 60000 ]; }; then
    echo "VNC_USER=${VNC_USER} is one of the image's own accounts (uid ${VNC_USER_UID}); choose another name." >&2
    exit 1
fi

VNC_TOTP_DIGITS="${VNC_TOTP_DIGITS:-6}"
case "$VNC_TOTP_DIGITS" in
    6|7|8) ;;
    *) echo "VNC_TOTP_DIGITS must be 6, 7 or 8 (got '${VNC_TOTP_DIGITS}')." >&2; exit 1 ;;
esac
case "$VNC_RESIZE" in
    off|scale|remote) ;;
    *) echo "VNC_RESIZE must be off, scale or remote (got '${VNC_RESIZE}')." >&2; exit 1 ;;
esac
# The container's own desktop: its size, as WIDTHxHEIGHT, and the colour
# depths Xvnc can run with.
if ! [[ "$VNC_GEOMETRY" =~ ^[1-9][0-9]{1,4}x[1-9][0-9]{1,4}$ ]]; then
    echo "VNC_GEOMETRY must be WIDTHxHEIGHT, such as 1600x900 (got '${VNC_GEOMETRY}')." >&2
    exit 1
fi
case "$VNC_DEPTH" in
    16|24|32) ;;
    *) echo "VNC_DEPTH must be 16, 24 or 32 (got '${VNC_DEPTH}')." >&2; exit 1 ;;
esac
if ! [[ "$WEB_PORT" =~ ^[1-9][0-9]{0,4}$ ]] || [ "$WEB_PORT" -gt 65535 ]; then
    echo "WEB_PORT must be a port number, 1 to 65535 (got '${WEB_PORT}')." >&2
    exit 1
fi
# An RFB server elsewhere, as host:port, [IPv6]:port or unix:/path,
# instead of the container's own desktop; checked as the gateway will.
if [ "$WEB_VNC" = 1 ] && [ -n "$VNC_ADDR" ] && ! VNC_ADDR_ERROR=$(/usr/local/bin/tabtopd -check-vnc-addr "$VNC_ADDR" 2>&1); then
    echo "VNC_ADDR isn't usable: ${VNC_ADDR_ERROR#tabtopd: }" >&2
    exit 1
fi
# An image built without its own desktop (DESKTOP=none) has no Xvnc.
if [ "$WEB_VNC" = 1 ] && [ -z "$VNC_ADDR" ] && ! command -v Xvnc >/dev/null; then
    echo "This image has no desktop of its own (built with DESKTOP=none): set VNC_ADDR to an RFB server's address." >&2
    exit 1
fi
# VNC_X509=1: the connection to the VNC server at VNC_ADDR must be VeNCrypt
# with a verified certificate, logging in with VNC_UPSTREAM_PASSWORD, and
# VNC_UPSTREAM_USERNAME for X509Plain (see docs/lite.md). What it needs is
# checked here, rather than when someone connects.
case "$VNC_X509" in
    0|1) ;;
    *) echo "VNC_X509 must be 0 or 1 (got '${VNC_X509}')." >&2; exit 1 ;;
esac
for VAR in VNC_UPSTREAM_USERNAME VNC_CA_FILE VNC_SERVER_NAME; do
    if [[ "${!VAR}" == *[[:cntrl:][:space:]]* ]]; then
        echo "${VAR} must not contain spaces or control characters." >&2
        exit 1
    fi
done
if [ "$WEB_VNC" = 0 ]; then
    : # Upstream TLS settings aren't used while the desktop is off.
elif [ "$VNC_X509" = 1 ]; then
    if [ -z "$VNC_ADDR" ]; then
        echo "VNC_X509=1 is for a VNC server elsewhere: set VNC_ADDR to its address." >&2
        exit 1
    fi
    if [ -z "${VNC_UPSTREAM_PASSWORD:-}" ]; then
        echo "VNC_X509=1 needs VNC_UPSTREAM_PASSWORD, the VNC server's password (its Unix account's, with VNC_UPSTREAM_USERNAME)." >&2
        exit 1
    fi
    if [[ "$VNC_ADDR" == unix:* ]] && [ -z "$VNC_SERVER_NAME" ]; then
        echo "With VNC_X509=1 and a Unix socket as VNC_ADDR, set VNC_SERVER_NAME to the name in the VNC server's certificate." >&2
        exit 1
    fi
    if [ -n "$VNC_CA_FILE" ] && [ ! -f "$VNC_CA_FILE" ]; then
        echo "VNC_CA_FILE=${VNC_CA_FILE} isn't a file: mount the VNC server's certificate there." >&2
        exit 1
    fi
elif [ -n "$VNC_UPSTREAM_USERNAME" ] || [ -n "$VNC_CA_FILE" ] || [ -n "$VNC_SERVER_NAME" ]; then
    echo "VNC_UPSTREAM_USERNAME, VNC_CA_FILE and VNC_SERVER_NAME only apply with VNC_X509=1." >&2
    exit 1
fi
case "$WEB_AUDIO" in
    0|1) ;;
    *) echo "WEB_AUDIO must be 0 or 1 (got '${WEB_AUDIO}')." >&2; exit 1 ;;
esac
case "$WEB_MIC" in
    0|1) ;;
    *) echo "WEB_MIC must be 0 or 1 (got '${WEB_MIC}')." >&2; exit 1 ;;
esac
case "$WEB_SHARE" in
    0|1) ;;
    *) echo "WEB_SHARE must be 0 or 1 (got '${WEB_SHARE}')." >&2; exit 1 ;;
esac
case "$WEB_FETCH" in
    0|1) ;;
    *) echo "WEB_FETCH must be 0 or 1 (got '${WEB_FETCH}')." >&2; exit 1 ;;
esac
case "$WEB_FETCH_PRIVATE" in
    0|1) ;;
    *) echo "WEB_FETCH_PRIVATE must be 0 or 1 (got '${WEB_FETCH_PRIVATE}')." >&2; exit 1 ;;
esac
if ! [[ "$WEB_AUDIO_BITRATE" =~ ^[0-9]{1,3}$ ]] || [ "$WEB_AUDIO_BITRATE" -lt 32 ] \
        || [ "$WEB_AUDIO_BITRATE" -gt 256 ]; then
    echo "WEB_AUDIO_BITRATE must be 32 to 256 kbit/s (got '${WEB_AUDIO_BITRATE}')." >&2
    exit 1
fi
# A PulseAudio (or pipewire-pulse) socket mounted from the host, whose sound
# is streamed instead of the container's own: "unix:" is optional. A missing
# host path is mounted as an empty directory, so check it's a socket.
WEB_AUDIO_SERVER="${WEB_AUDIO_SERVER#unix:}"
if [ -n "$WEB_AUDIO_SERVER" ] && [ "$WEB_AUDIO" = 1 ] && [ ! -S "$WEB_AUDIO_SERVER" ]; then
    echo "WEB_AUDIO_SERVER must be a mounted PulseAudio socket; ${WEB_AUDIO_SERVER} isn't a socket." >&2
    exit 1
fi
if [ -n "$WEB_AUDIO_SINK" ] && ! [[ "$WEB_AUDIO_SINK" =~ ^[A-Za-z0-9@_.:-]+$ ]]; then
    echo "WEB_AUDIO_SINK must be a sink name (got '${WEB_AUDIO_SINK}')." >&2
    exit 1
fi
case "$WEB_TTY" in
    0|1) ;;
    *) echo "WEB_TTY must be 0 or 1 (got '${WEB_TTY}')." >&2; exit 1 ;;
esac
# A shell command each terminal tab runs instead of tmux, such as ssh to
# another machine; on one line.
if [[ "$WEB_TTY_COMMAND" == *[[:cntrl:]]* ]]; then
    echo "WEB_TTY_COMMAND must be on one line, without control characters." >&2
    exit 1
fi
if ! [[ "$WEB_TRUST_NPROXIES" =~ ^[0-9]{1,2}$ ]] || [ "$WEB_TRUST_NPROXIES" -gt 10 ]; then
    echo "WEB_TRUST_NPROXIES must be 0 to 10 (got '${WEB_TRUST_NPROXIES}')." >&2
    exit 1
fi
# Hours and minutes, as tabtopd takes them: 12h, 90m, 1h30m.
DURATION='^([0-9]{1,4}h)?([0-9]{1,6}m)?$'
if ! [[ "$WEB_SESSION_MAX" =~ $DURATION ]] || ! [[ "$WEB_SESSION_MAX" =~ [1-9] ]]; then
    echo "WEB_SESSION_MAX must be hours and minutes, such as 12h or 90m (got '${WEB_SESSION_MAX}')." >&2
    exit 1
fi
if [ "$WEB_SESSION_IDLE" != 0 ] && { ! [[ "$WEB_SESSION_IDLE" =~ $DURATION ]] || ! [[ "$WEB_SESSION_IDLE" =~ [1-9] ]]; }; then
    echo "WEB_SESSION_IDLE must be hours and minutes, such as 1h or 30m, or 0 for no limit (got '${WEB_SESSION_IDLE}')." >&2
    exit 1
fi
case "$WEB_DOCTOR_ENDPOINT" in
    0|1) ;;
    *) echo "WEB_DOCTOR_ENDPOINT must be 0 or 1 (got '${WEB_DOCTOR_ENDPOINT}')." >&2; exit 1 ;;
esac
# TZ: a time zone name, such as Europe/Berlin, for the desktop's clock and
# everything else in the container, and the files page's times; UTC when
# it's unset or empty. It becomes /etc/localtime too, for processes that
# don't get TZ, such as docker exec.
TZ="${TZ:-UTC}"
TZ="${TZ#:}"  # ":Europe/Berlin" is the same zone
if ! [[ "$TZ" =~ ^[A-Za-z0-9_+-]+(/[A-Za-z0-9_+-]+)*$ ]] || [ ! -f "/usr/share/zoneinfo/$TZ" ]; then
    echo "TZ must be a time zone name, such as Europe/Berlin or Asia/Singapore (got '${TZ}')." >&2
    exit 1
fi
ln -sf "/usr/share/zoneinfo/$TZ" /etc/localtime
echo "$TZ" > /etc/timezone
export TZ
# WEB_E2E is gone: the encrypted tunnel is always on. 1 (what it always
# means now) is accepted; 0 asked for unencrypted pages, which no longer
# exist, so it stops the container rather than be silently ignored.
case "$WEB_E2E" in
    ''|1) ;;
    *) echo "WEB_E2E=${WEB_E2E} is no longer supported: everything always goes through the encrypted tunnel. Unset WEB_E2E." >&2; exit 1 ;;
esac
# Same rule as tabtopd's: segments of unreserved URL characters, spelled out
# because ranges like a-z can match other letters, depending on the locale.
SEG='[abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._~-]+'
if ! [[ "$WEB_BASE_PATH" =~ ^/*(${SEG}(/${SEG})*)?/*$ ]] \
        || [[ "/$WEB_BASE_PATH/" =~ /\.{1,2}/ ]]; then
    echo "WEB_BASE_PATH must be a URL path like /tabtop/ (got '${WEB_BASE_PATH}')." >&2
    exit 1
fi

