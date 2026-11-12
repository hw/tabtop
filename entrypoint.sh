#!/bin/bash
set -euo pipefail

# Helpers live beside this script in the image and in a source checkout.
STARTUP_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/startup" && pwd)"
source "$STARTUP_DIR/config.sh"
source "$STARTUP_DIR/user.sh"
source "$STARTUP_DIR/desktop.sh"

provision_user "$VNC_USER" "$DISPLAY_NUM" "$WEB_AUDIO_SERVER"

if [ "$WEB_VNC" = 0 ]; then
    echo "Desktop support is turned off (WEB_VNC=0)."
elif [ -n "$VNC_ADDR" ]; then
    echo "Using the RFB server at ${VNC_ADDR}; the container's own desktop isn't started."
else
    start_desktop "$VNC_GEOMETRY" "$VNC_DEPTH" "$WEB_AUDIO" "$WEB_AUDIO_SERVER" "$WEB_MIC"
fi

configure_host_audio "$WEB_AUDIO" "$WEB_AUDIO_SERVER" "$WEB_AUDIO_SINK" "$WEB_MIC"
if [ "$WEB_VNC" = 1 ]; then
    configure_viewer "$VNC_RESIZE"
fi

# The gateway owns the web port: it serves the noVNC client, the files page
# for ~/Downloads at /fs/ and a terminal at /tty/, and carries all of
# them, and the audio, through its encrypted tunnel, logging in with CPace
# and encrypting with ChaCha20-Poly1305 from the noble libraries (in
# /opt/noble). It runs as the desktop user, to read the downloads and the
# pam_oath users file.
if [ "$WEB_FS" = 1 ]; then
    runuser -u "$VNC_USER" -- mkdir -p "$USER_HOME/Downloads"
fi
TERM_DIR=""
if [ "$WEB_TTY" = 1 ]; then
    TERM_DIR=/opt/terminal
fi
DOCTOR=false
if [ "$WEB_DOCTOR_ENDPOINT" = 1 ]; then
    DOCTOR=true
fi
X509=false
if [ "$WEB_VNC" = 1 ] && [ "$VNC_X509" = 1 ]; then
    X509=true
    # The gateway reads it as the desktop user, for each connection.
    if [ -n "$VNC_CA_FILE" ] && ! run_as_user test -r "$VNC_CA_FILE"; then
        echo "VNC_CA_FILE=${VNC_CA_FILE} can't be read by ${VNC_USER}: make it readable to uid $(id -u "$VNC_USER")." >&2
        exit 1
    fi
fi
as_user /usr/local/bin/tabtopd \
    -disable-vnc="$((1 - WEB_VNC))" \
    -disable-fs="$((1 - WEB_FS))" \
    -listen ":${WEB_PORT}" \
    -base-path "$WEB_BASE_PATH" \
    -novnc-dir /opt/novnc \
    -vnc-addr "$VNC_ADDR" \
    -vnc-x509="$X509" \
    -vnc-username "$VNC_UPSTREAM_USERNAME" \
    -vnc-ca-file "$VNC_CA_FILE" \
    -vnc-server-name "$VNC_SERVER_NAME" \
    -noble-dir /opt/noble \
    -highlight-dir /opt/highlight \
    -preview-dir /opt/preview \
    -pdfjs-dir /opt/pdfjs \
    -kaitai-dir /opt/kaitai \
    -inpaint-dir /opt/inpaint \
    -background-dir /opt/background \
    -disasm-dir /opt/disasm \
    -users-file "$TOTP_USERS_FILE" \
    -vnc-password-file "$VNC_UPSTREAM_FILE" \
    -downloads-dir "$USER_HOME/Downloads" \
    -share="$WEB_SHARE" \
    -shares-file "$USER_HOME/.config/tabtop/shares.json" \
    -share-key-file "$USER_HOME/.config/tabtop/share-link.key" \
    -activity-file "$USER_HOME/.config/tabtop/activity.jsonl" \
    -fetch="$WEB_FETCH" \
    -fetch-private="$WEB_FETCH_PRIVATE" \
    -preview-fetch-private="$WEB_PREVIEW_FETCH_PRIVATE" \
    -trusted-proxies "$WEB_TRUSTED_PROXIES" \
    -trust-nproxies "$((10#$WEB_TRUST_NPROXIES))" \
    -session-max "$WEB_SESSION_MAX" \
    -session-idle "$WEB_SESSION_IDLE" \
    -audio-sink "$AUDIO_SINK" \
    -mic-sink "$MIC_SINK" \
    -mic-create="$MIC_CREATE" \
    -audio-bitrate "$WEB_AUDIO_BITRATE" \
    -term-dir "$TERM_DIR" \
    -tty-command "$WEB_TTY_COMMAND" \
    -doctor="$DOCTOR" \
    &
TABTOPD_PID=$!

shutdown() { kill "$TABTOPD_PID" $XVNC_PID "${AUDIO_PIDS[@]}" 2>/dev/null || true; }
trap shutdown TERM INT

# Exit (and let the container stop/restart) if Xvnc, the gateway or one of
# the audio services dies.
wait -n $XVNC_PID "$TABTOPD_PID" "${AUDIO_PIDS[@]}" || true
shutdown
wait
