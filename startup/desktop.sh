# Xvnc runs as the desktop user. The gateway checks the desktop login itself
# (in noVNC's RFB handshake, or in its encrypted tunnel), so Xvnc asks for
# none, and it listens only on a socket in the user's runtime directory that
# nobody else can open (Xvnc's default mode is 0600), not on TCP. Its
# blacklist is off: every connection arrives from the gateway, which limits
# failed logins per client IP instead. Only what's copied (CLIPBOARD) goes
# to the browser, not text that's merely selected (PRIMARY), since the
# desktop page puts it on the computer's own clipboard.
#
# With VNC_ADDR set, the gateway dials that RFB server instead, and none of
# this desktop (Xvnc, its sound or XFCE) is started. If that server asks
# for a password, the gateway gives it VNC_UPSTREAM_PASSWORD, or noVNC asks.
XVNC_PID=""
AUDIO_PIDS=()
AUDIO_SINK=""
MIC_SINK=""
MIC_CREATE=0
# Uses the provisioned user runtime and sets VNC_ADDR, XVNC_PID, AUDIO_PIDS,
# AUDIO_SINK and MIC_SINK in the supervising shell (never in a subshell).
start_desktop() {
    local VNC_GEOMETRY="$1" VNC_DEPTH="$2" WEB_AUDIO="$3" WEB_AUDIO_SERVER="$4" WEB_MIC="$5"
    VNC_SOCKET="$RUNTIME_DIR/vnc.sock"
    VNC_ADDR="unix:$VNC_SOCKET"
    as_user Xvnc ":${DISPLAY_NUM}" \
        -geometry "$VNC_GEOMETRY" \
        -depth "$VNC_DEPTH" \
        -rfbunixpath "$VNC_SOCKET" -rfbport -1 -SecurityTypes None \
        -AlwaysShared \
        -AcceptSetDesktopSize \
        -UseBlacklist=0 \
        -SendPrimary=0 \
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
    # the desktop so applications find it. Not with WEB_AUDIO_SERVER: the
    # host's server is used instead (see below).
    if [ "$WEB_AUDIO" = 1 ] && [ -z "$WEB_AUDIO_SERVER" ]; then
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
                            "sink_properties=\"device.description='TabTop Audio'\"" >/dev/null 2>&1); then
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
        # The browser's microphone: the gateway plays it into a second null
        # sink, whose monitor is offered as an ordinary microphone and made
        # the default, so applications record it without being told.
        # Applications still play into tabtop.
        if [ "$WEB_MIC" = 1 ]; then
            # The same devices, under the same names, as the gateway makes on
            # a host's sound server (micModules in tabtopd/mic.go).
            if (as_user pactl load-module module-null-sink sink_name=tabtop_mic \
                    "sink_properties=\"device.description='TabTop Mic (feed)'\"" >/dev/null) \
                && (as_user pactl load-module module-remap-source master=tabtop_mic.monitor \
                    source_name=tabtop_mic_in "source_properties=\"device.description='TabTop Mic'\"" >/dev/null) \
                && (as_user pactl set-default-source tabtop_mic_in) \
                && (as_user pactl set-default-sink tabtop); then
                MIC_SINK=tabtop_mic
            else
                echo "Warning: couldn't set up the browser microphone; it's off." >&2
            fi
        fi
    fi

    as_user dbus-launch --exit-with-session startxfce4 &
}

# Host audio is optional even when it cannot be reached at startup.
configure_host_audio() {
    local WEB_AUDIO="$1" WEB_AUDIO_SERVER="$2" WEB_AUDIO_SINK="$3" WEB_MIC="$4"
    # The host's sound, from the PulseAudio socket mounted at WEB_AUDIO_SERVER:
    # the gateway records WEB_AUDIO_SINK's monitor, by default whichever sink is
    # the host's default when a browser starts listening. A server that doesn't
    # answer yet isn't fatal: the gateway tries again when someone listens, and
    # the doctor report shows why it can't.
    if [ "$WEB_AUDIO" = 1 ] && [ -n "$WEB_AUDIO_SERVER" ]; then
        AUDIO_SINK="${WEB_AUDIO_SINK:-@DEFAULT_SINK@}"
        if ! (as_user pactl info >/dev/null 2>&1); then
            echo "Warning: the audio server at ${WEB_AUDIO_SERVER} doesn't answer ${VNC_USER} (uid $(id -u "$VNC_USER")); is it the host user's uid?" >&2
        elif ! (as_user pactl list short sinks 2>/dev/null) | cut -f2 | grep -qxF "$AUDIO_SINK" \
                && [ "$AUDIO_SINK" != @DEFAULT_SINK@ ]; then
            echo "Warning: the host's audio server has no sink named ${AUDIO_SINK}." >&2
        else
            echo "Streaming the host's sound from ${AUDIO_SINK} at ${WEB_AUDIO_SERVER}."
        fi
        # The browser's microphone, as "TabTop Mic" on the host's server: the
        # gateway makes it (not as the default) and removes it on stopping,
        # or makes it later if the server doesn't answer yet.
        if [ "$WEB_MIC" = 1 ]; then
            MIC_CREATE=1
        fi
    fi
}
