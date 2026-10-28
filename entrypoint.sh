#!/bin/bash
set -euo pipefail

VNC_USER="${VNC_USER:-user}"
VNC_GEOMETRY="${VNC_GEOMETRY:-1600x900}"
VNC_DEPTH="${VNC_DEPTH:-24}"
VNC_RESIZE="${VNC_RESIZE:-remote}"
WEB_PORT="${WEB_PORT:-6080}"
WEB_BASE_PATH="${WEB_BASE_PATH:-/}"
WEB_TRUSTED_PROXIES="${WEB_TRUSTED_PROXIES:-}"
WEB_AUDIO="${WEB_AUDIO:-1}"
WEB_AUDIO_BITRATE="${WEB_AUDIO_BITRATE:-64}"
WEB_TTY="${WEB_TTY:-1}"
WEB_DOCTOR_ENDPOINT="${WEB_DOCTOR_ENDPOINT:-0}"
DISPLAY_NUM=1
VNC_PORT=$((5900 + DISPLAY_NUM))

VNC_TOTP_DIGITS="${VNC_TOTP_DIGITS:-6}"
case "$VNC_TOTP_DIGITS" in
    6|7|8) ;;
    *) echo "VNC_TOTP_DIGITS must be 6, 7 or 8 (got '${VNC_TOTP_DIGITS}')." >&2; exit 1 ;;
esac
case "$VNC_RESIZE" in
    off|scale|remote) ;;
    *) echo "VNC_RESIZE must be off, scale or remote (got '${VNC_RESIZE}')." >&2; exit 1 ;;
esac
case "$WEB_AUDIO" in
    0|1) ;;
    *) echo "WEB_AUDIO must be 0 or 1 (got '${WEB_AUDIO}')." >&2; exit 1 ;;
esac
if ! [[ "$WEB_AUDIO_BITRATE" =~ ^[0-9]{1,3}$ ]] || [ "$WEB_AUDIO_BITRATE" -lt 32 ] \
        || [ "$WEB_AUDIO_BITRATE" -gt 256 ]; then
    echo "WEB_AUDIO_BITRATE must be 32 to 256 kbit/s (got '${WEB_AUDIO_BITRATE}')." >&2
    exit 1
fi
case "$WEB_TTY" in
    0|1) ;;
    *) echo "WEB_TTY must be 0 or 1 (got '${WEB_TTY}')." >&2; exit 1 ;;
esac
case "$WEB_DOCTOR_ENDPOINT" in
    0|1) ;;
    *) echo "WEB_DOCTOR_ENDPOINT must be 0 or 1 (got '${WEB_DOCTOR_ENDPOINT}')." >&2; exit 1 ;;
esac
# Same rule as tabtopd's: segments of unreserved URL characters, spelled out
# because ranges like a-z can match other letters, depending on the locale.
SEG='[abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._~-]+'
if ! [[ "$WEB_BASE_PATH" =~ ^/*(${SEG}(/${SEG})*)?/*$ ]] \
        || [[ "/$WEB_BASE_PATH/" =~ /\.{1,2}/ ]]; then
    echo "WEB_BASE_PATH must be a URL path like /tabtop/ (got '${WEB_BASE_PATH}')." >&2
    exit 1
fi

# Create the desktop user. Its Unix password stays locked: the VNC login is
# checked by pam_oath (TOTP, optionally with a password PIN) instead.
if ! id "$VNC_USER" >/dev/null 2>&1; then
    useradd --create-home --shell /bin/bash "$VNC_USER"
fi

USER_HOME="$(getent passwd "$VNC_USER" | cut -d: -f6)"

# An optionally mounted home may be root-owned and empty (useradd doesn't
# populate an existing directory), or may come from a different UID. Only then
# fix ownership and copy in the skeleton files, so a large home isn't re-chowned
# on every start. chown -R doesn't follow symlinks, and the copy runs as the
# user, so symlinks left in a reused home can't redirect root.
if [ "$(stat -c %u "$USER_HOME")" != "$(id -u "$VNC_USER")" ]; then
    chown -R "$VNC_USER:" "$USER_HOME"
    runuser -u "$VNC_USER" -- cp -r --update=none /etc/skel/. "$USER_HOME/"
fi

# Seed the default panel layout (the image's, without XFCE's bottom dock) so
# XFCE doesn't show the first-run dialog. A home that has one keeps it.
PANEL_CFG="$USER_HOME/.config/xfce4/xfconf/xfce-perchannel-xml/xfce4-panel.xml"
if [ ! -f "$PANEL_CFG" ] && [ -f /etc/xdg/xfce4/panel/default.xml ]; then
    runuser -u "$VNC_USER" -- mkdir -p "$(dirname "$PANEL_CFG")"
    runuser -u "$VNC_USER" -- cp /etc/xdg/xfce4/panel/default.xml "$PANEL_CFG"
fi

# TigerVNC's "Plain" security type checks the username/password against PAM;
# the "tabtop" PAM service accepts a TOTP code, or password+TOTP when a
# password is configured (pam_oath PIN). Xvnc runs as the desktop user and
# pam_oath rewrites its users file (to reject reused codes), so the files
# live in a directory that user owns. The user can replace anything in it,
# with symlinks too, so every file operation there runs as that user: root
# reading through a symlink would copy files the user can't read into
# users.oath, which they can.
TOTP_DIR="$USER_HOME/.config/tabtop"
TOTP_SECRET_FILE="$TOTP_DIR/totp-secret"
PASSWORD_FILE="$TOTP_DIR/password"
TOTP_USERS_FILE="$TOTP_DIR/users.oath"
run_as_user() { runuser -u "$VNC_USER" -- "$@"; }
write_as_user() { run_as_user sh -c 'umask 077; cat > "$1"' sh "$1"; }

run_as_user mkdir -p "$TOTP_DIR"
if [ -L "$TOTP_DIR" ] || [ "$(stat -c %u "$TOTP_DIR")" != "$(id -u "$VNC_USER")" ]; then
    echo "$TOTP_DIR must be a directory owned by $VNC_USER, not a symlink." >&2
    exit 1
fi
run_as_user chmod 700 "$TOTP_DIR"
NEW_SECRET=0
if [ -z "${VNC_TOTP_SECRET:-}" ] && run_as_user test -s "$TOTP_SECRET_FILE"; then
    VNC_TOTP_SECRET="$(run_as_user cat "$TOTP_SECRET_FILE")"
elif [ -z "${VNC_TOTP_SECRET:-}" ]; then
    VNC_TOTP_SECRET="$(head -c 20 /dev/urandom | base32 | tr -d '=')"
    printf '%s\n' "$VNC_TOTP_SECRET" | write_as_user "$TOTP_SECRET_FILE"
    NEW_SECRET=1
fi
# Accept secrets as apps display them: lowercase, grouped, or '='-padded.
VNC_TOTP_SECRET="$(printf '%s' "$VNC_TOTP_SECRET" | tr -d ' =\n' | tr 'a-z' 'A-Z')"
# Documentation and tutorials everywhere use this one ("Hello!" + 0xDEADBEEF),
# so anyone could generate codes for it.
if [ "$VNC_TOTP_SECRET" = JBSWY3DPEHPK3PXP ]; then
    echo "The TOTP secret (VNC_TOTP_SECRET, or $TOTP_SECRET_FILE when unset) is a" >&2
    echo "well-known example that anyone can generate codes for. Use a random one," >&2
    echo "e.g.: head -c 20 /dev/urandom | base32" >&2
    exit 1
fi

if ! TOTP_HEX="$(oathtool --totp -v -b "$VNC_TOTP_SECRET" | sed -n 's/^Hex secret: //p')" \
        || [ -z "$TOTP_HEX" ]; then
    echo "TOTP secret is not valid base32." >&2
    exit 1
fi

# Password is optional. When set, login is password immediately followed by
# the TOTP code (pam_oath PIN + OTP). Env wins; else the file; else TOTP-only.
# An env-supplied password is not saved (same as VNC_TOTP_SECRET).
if [ -z "${VNC_PASSWORD+x}" ] && run_as_user test -s "$PASSWORD_FILE"; then
    # Drop a single trailing newline that editors add; reject other newlines.
    VNC_PASSWORD="$(run_as_user cat "$PASSWORD_FILE")"
    VNC_PASSWORD="${VNC_PASSWORD%$'\n'}"
fi
VNC_PASSWORD="${VNC_PASSWORD:-}"
# pam_oath's users file is whitespace-separated, so the PIN cannot contain
# spaces, tabs or newlines.
case "$VNC_PASSWORD" in
    *[[:space:]]*)
        echo "VNC_PASSWORD must not contain whitespace." >&2
        exit 1
        ;;
esac
if [ -z "$VNC_PASSWORD" ]; then
    OATH_PIN='-'
else
    OATH_PIN="$VNC_PASSWORD"
fi

# pam_oath appends the last-used code's counter and time to this line; keep
# an existing file when the token is unchanged so a code used before a
# restart can't be replayed after it.
TOTP_ENTRY="$(printf 'HOTP/T30/%s\t%s\t%s\t%s' "$VNC_TOTP_DIGITS" "$VNC_USER" "$OATH_PIN" "$TOTP_HEX")"
# The entry goes to grep on stdin, keeping the password out of ps.
if ! printf '%s\n' "$TOTP_ENTRY" | run_as_user grep -qsFf - "$TOTP_USERS_FILE"; then
    printf '%s\n' "$TOTP_ENTRY" | write_as_user "$TOTP_USERS_FILE"
fi
run_as_user rm -f "$TOTP_USERS_FILE.lock"

# window=1 also accepts the previous and next 30s code, for clock skew.
cat > /etc/pam.d/tabtop <<EOF
auth    required pam_oath.so usersfile=${TOTP_USERS_FILE} digits=${VNC_TOTP_DIGITS} window=1
account required pam_permit.so
EOF

if [ "$NEW_SECRET" = 1 ]; then
    TOTP_URI="otpauth://totp/TabTop:${VNC_USER}?secret=${VNC_TOTP_SECRET}&issuer=TabTop&digits=${VNC_TOTP_DIGITS}&period=30"
    echo "Generated a TOTP secret for '${VNC_USER}'. Add it to an authenticator app:"
    echo "  Secret: ${VNC_TOTP_SECRET} (${VNC_TOTP_DIGITS} digits, 30s)"
    echo "  URI:    ${TOTP_URI}"
    qrencode -t ANSIUTF8 "$TOTP_URI"
    echo "It is saved in ${TOTP_SECRET_FILE}; delete that file to rotate it."
fi
unset VNC_TOTP_SECRET VNC_PASSWORD TOTP_HEX TOTP_ENTRY TOTP_URI OATH_PIN

if [ "${CHROMIUM_NO_SANDBOX:-1}" = 1 ]; then
    printf '%s\n' 'export CHROMIUM_FLAGS="$CHROMIUM_FLAGS --no-sandbox --test-type"' \
        > /etc/chromium.d/docker-flags
else
    rm -f /etc/chromium.d/docker-flags
fi

rm -f "/tmp/.X${DISPLAY_NUM}-lock" "/tmp/.X11-unix/X${DISPLAY_NUM}"
mkdir -p /tmp/.X11-unix && chmod 1777 /tmp/.X11-unix

# The user's runtime directory, for the PipeWire and PulseAudio sockets.
RUNTIME_DIR="/tmp/runtime-${VNC_USER}"
rm -rf "$RUNTIME_DIR"
install -d -m 700 -o "$VNC_USER" "$RUNTIME_DIR"

# exec so that, when backgrounded, $! is runuser itself (which forwards
# SIGTERM to its child) rather than a bash subshell that would orphan it.
as_user() {
    exec runuser -u "$VNC_USER" -- env -i \
        HOME="$USER_HOME" USER="$VNC_USER" LOGNAME="$VNC_USER" SHELL=/bin/bash \
        PATH=/usr/local/bin:/usr/bin:/bin LANG="$LANG" DISPLAY=":${DISPLAY_NUM}" \
        XDG_RUNTIME_DIR="$RUNTIME_DIR" \
        "$@"
}

# Xvnc runs as the desktop user and only listens on localhost. Its blacklist
# is off: every connection arrives from the gateway, so it would lock all
# users out together. The gateway limits failed logins per client IP instead.
as_user Xvnc ":${DISPLAY_NUM}" \
    -geometry "$VNC_GEOMETRY" \
    -depth "$VNC_DEPTH" \
    -localhost \
    -rfbport "$VNC_PORT" \
    -SecurityTypes Plain \
    -PlainUsers "$VNC_USER" \
    -PAMService tabtop \
    -AlwaysShared \
    -AcceptSetDesktopSize \
    -UseBlacklist=0 \
    &
XVNC_PID=$!

for _ in $(seq 50); do
    [ -S "/tmp/.X11-unix/X${DISPLAY_NUM}" ] && break
    sleep 0.1
done
if [ ! -S "/tmp/.X11-unix/X${DISPLAY_NUM}" ]; then
    echo "Xvnc did not create its display socket within 5s; exiting." >&2
    exit 1
fi

# Sound: Chromium plays into a null sink (no sound card needed), and the
# gateway records its monitor to stream it to the browser. Started before
# the desktop so applications find it.
AUDIO_PIDS=()
AUDIO_SINK=""
if [ "$WEB_AUDIO" = 1 ]; then
    as_user pipewire &
    AUDIO_PIDS+=($!)
    # WirePlumber and pipewire-pulse give up if PipeWire isn't listening yet.
    for _ in $(seq 50); do
        [ -S "$RUNTIME_DIR/pipewire-0" ] && break
        sleep 0.1
    done
    as_user wireplumber &
    AUDIO_PIDS+=($!)
    as_user pipewire-pulse &
    AUDIO_PIDS+=($!)
    # Retry until pipewire-pulse answers and WirePlumber has made the sink
    # the default.
    for _ in $(seq 50); do
        if (as_user pactl list short sinks 2>/dev/null) | grep -q $'\ttabtop\t' \
                || (as_user pactl load-module module-null-sink sink_name=tabtop \
                        sink_properties=device.description=Desktop >/dev/null 2>&1); then
            (as_user pactl set-default-sink tabtop 2>/dev/null) || true
            if [ "$(as_user pactl get-default-sink 2>/dev/null)" = tabtop ]; then
                AUDIO_SINK=tabtop
                break
            fi
        fi
        sleep 0.1
    done
    if [ -z "$AUDIO_SINK" ]; then
        echo "PipeWire did not come up within 5s; exiting." >&2
        exit 1
    fi
fi

as_user dbus-launch --exit-with-session startxfce4 &

# noVNC's defaults.json replaces its built-in setting defaults. A value the
# viewer picks in the settings panel is saved in their browser and wins over
# it, so VNC_RESIZE only applies to browsers that haven't chosen one.
printf '{"resize": "%s"}\n' "$VNC_RESIZE" > /opt/novnc/defaults.json
printf '%s\n' '<!doctype html><meta http-equiv="refresh" content="0; url=vnc.html?autoconnect=1">' \
    > /opt/novnc/index.html

# The gateway owns the web port: it serves the noVNC client, bridges its
# WebSocket to Xvnc, and serves ~/Downloads at /downloads/ and a terminal at
# /tty/ behind a login. It runs as the desktop user, to read the downloads and the pam_oath
# users file.
runuser -u "$VNC_USER" -- mkdir -p "$USER_HOME/Downloads"
XTERM_DIR=""
if [ "$WEB_TTY" = 1 ]; then
    XTERM_DIR=/opt/xterm
fi
DOCTOR=false
if [ "$WEB_DOCTOR_ENDPOINT" = 1 ]; then
    DOCTOR=true
fi
as_user /usr/local/bin/tabtopd \
    -listen ":${WEB_PORT}" \
    -base-path "$WEB_BASE_PATH" \
    -novnc-dir /opt/novnc \
    -vnc-addr "127.0.0.1:${VNC_PORT}" \
    -users-file "$TOTP_USERS_FILE" \
    -downloads-dir "$USER_HOME/Downloads" \
    -trusted-proxies "$WEB_TRUSTED_PROXIES" \
    -audio-sink "$AUDIO_SINK" \
    -audio-bitrate "$WEB_AUDIO_BITRATE" \
    -xterm-dir "$XTERM_DIR" \
    -doctor="$DOCTOR" \
    &
TABTOPD_PID=$!

shutdown() { kill "$TABTOPD_PID" "$XVNC_PID" "${AUDIO_PIDS[@]}" 2>/dev/null || true; }
trap shutdown TERM INT

# Exit (and let the container stop/restart) if Xvnc, the gateway or one of
# the audio services dies.
wait -n "$XVNC_PID" "$TABTOPD_PID" "${AUDIO_PIDS[@]}" || true
shutdown
wait
