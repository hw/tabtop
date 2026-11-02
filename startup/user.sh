# User execution helpers use the provisioned USER_HOME, RUNTIME_DIR and
# USER_AUDIO_ENV, and the validated VNC_USER, DISPLAY_NUM, LANG and TZ.
run_as_user() { runuser -u "$VNC_USER" -- "$@"; }
write_as_user() { run_as_user sh -c 'umask 077; cat > "$1"' sh "$1"; }

# exec so that, when backgrounded, $! is runuser itself (which forwards
# SIGTERM to its child) rather than a bash subshell that would orphan it.
# It starts in the home directory, so what the desktop launches (the
# panel's terminal, for one) does too, rather than in /.
as_user() {
    exec runuser -u "$VNC_USER" -- env -i -C "$USER_HOME" \
        HOME="$USER_HOME" USER="$VNC_USER" LOGNAME="$VNC_USER" SHELL=/bin/bash \
        PATH=/usr/local/bin:/usr/bin:/bin LANG="$LANG" DISPLAY=":${DISPLAY_NUM}" \
        XDG_RUNTIME_DIR="$RUNTIME_DIR" TZ="$TZ" "${USER_AUDIO_ENV[@]}" \
        "$@"
}


# Inputs: validated account, display number and host audio socket. Outputs:
# USER_HOME, credential file paths, RUNTIME_DIR and USER_AUDIO_ENV. Secrets
# are removed from the shell environment before any services are launched.
provision_user() {
    local VNC_USER="$1" DISPLAY_NUM="$2" WEB_AUDIO_SERVER="$3"
    # Create the desktop user. Its Unix password stays locked: the gateway checks
    # logins against a pam_oath users file (TOTP, optionally with a password PIN)
    # instead.
    if ! id "$VNC_USER" >/dev/null 2>&1; then
        useradd --create-home --shell /bin/bash "$VNC_USER"
    fi

    USER_HOME="$(getent passwd "$VNC_USER" | cut -d: -f6)"

    # A volume meant for the home, mounted under /home/ at another name than
    # VNC_USER's, isn't used: the account gets a new, empty home beside it.
    # Mount points are the fifth field of mountinfo, with spaces as \040.
    while read -r _ _ _ _ MOUNT_POINT _; do
        MOUNT_POINT="${MOUNT_POINT//\\040/ }"
        case "$MOUNT_POINT" in
            "$USER_HOME" | "$USER_HOME"/*) ;;
            /home/*)
                MOUNT_NAME="${MOUNT_POINT#/home/}"
                echo "Warning: $MOUNT_POINT is mounted, but the home folder is $USER_HOME (VNC_USER=$VNC_USER)," >&2
                echo "so it isn't used. Set VNC_USER=${MOUNT_NAME%%/*}, or mount it under $USER_HOME instead." >&2
                ;;
        esac
    done < /proc/self/mountinfo

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

    # The gateway checks every login against pam_oath's users file: a TOTP code,
    # or password+TOTP when a password is configured (the pam_oath PIN). It runs
    # as the desktop user and rewrites the file (to reject reused codes), so the
    # files live in a directory that user owns. The user can replace anything in it,
    # with symlinks too, so every file operation there runs as that user: root
    # reading through a symlink would copy files the user can't read into
    # users.oath, which they can.
    TOTP_DIR="$USER_HOME/.config/tabtop"
    PASSWORD_FILE="$TOTP_DIR/password"
    TOTP_USERS_FILE="$TOTP_DIR/users.oath"


    run_as_user mkdir -p "$TOTP_DIR"
    if [ -L "$TOTP_DIR" ] || [ "$(stat -c %u "$TOTP_DIR")" != "$(id -u "$VNC_USER")" ]; then
        echo "$TOTP_DIR must be a directory owned by $VNC_USER, not a symlink." >&2
        exit 1
    fi
    run_as_user chmod 700 "$TOTP_DIR"
    # The secret: VNC_TOTP_SECRET, else the well-known example secret below. VNC_TOTP_SECRET can be any
    # string, for random generators that can't produce Base32: valid Base32 is
    # used as it is; anything else has the key derived from it, the first 20
    # bytes of its SHA-256 (a fixed size, as liboath refuses keys over 32
    # bytes), and the derived Base32 secret is printed at startup for the
    # authenticator app. The default is public (it's in documentation and
    # tutorials everywhere), so anyone can generate codes for it; it lets the
    # container start without configuration, and every start warns about it. It
    # isn't saved, so a container created later with a secret replaces it.
    DEFAULT_TOTP_SECRET=JBSWY3DPEHPK3PXP
    USING_DEFAULT_SECRET=0
    DERIVED_SECRET=0
    # base32_hex prints the hex key for a Base32 secret, or fails if it isn't
    # valid Base32. Spaces, '=' padding and lowercase are accepted, as apps
    # display secrets that way. Secrets go to oathtool and qrencode on stdin
    # ("-"), never as arguments, which any process could read in /proc.
    base32_hex() {
        local hex
        hex="$(printf '%s' "$1" | tr -d ' =\n' | tr 'a-z' 'A-Z' | oathtool --totp -v -b - 2>/dev/null \
            | sed -n 's/^Hex secret: //p')" && [ -n "$hex" ] && printf '%s' "$hex"
    }
    if [ -n "${VNC_TOTP_SECRET:-}" ]; then
        if ! TOTP_HEX="$(base32_hex "$VNC_TOTP_SECRET")"; then
            TOTP_HEX="$(printf '%s' "$VNC_TOTP_SECRET" | sha256sum | cut -c1-40)"
            DERIVED_SECRET=1
        fi
    else
        TOTP_HEX="$(base32_hex "$DEFAULT_TOTP_SECRET")"
    fi
    # The Base32 form, for authenticator apps and the default check.
    VNC_TOTP_SECRET="$(printf '%s' "$TOTP_HEX" | oathtool --totp -v - | sed -n 's/^Base32 secret: //p')"
    if [ "$VNC_TOTP_SECRET" = "$DEFAULT_TOTP_SECRET" ]; then
        USING_DEFAULT_SECRET=1
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

    # The password the gateway gives the VNC server at VNC_ADDR, if it asks for
    # one: the server's own, never the login's (VNC Authentication sends a
    # DES-based response that can be cracked offline). It's kept in a file only
    # the user can read, which the gateway reads, rather than on its command
    # line or in its environment, where other processes would see it, and
    # removed when VNC_UPSTREAM_PASSWORD is unset, so noVNC asks instead.
    VNC_UPSTREAM_FILE="$TOTP_DIR/vnc-upstream-password"
    if [ -n "${VNC_UPSTREAM_PASSWORD:-}" ]; then
        if [[ "$VNC_UPSTREAM_PASSWORD" == *[[:cntrl:]]* ]]; then
            echo "VNC_UPSTREAM_PASSWORD must be on one line, without control characters." >&2
            exit 1
        fi
        printf '%s' "$VNC_UPSTREAM_PASSWORD" | write_as_user "$VNC_UPSTREAM_FILE"
    else
        run_as_user rm -f "$VNC_UPSTREAM_FILE"
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

    if [ "$USING_DEFAULT_SECRET" = 1 ]; then
        TOTP_URI="otpauth://totp/TabTop:${VNC_USER}?secret=${VNC_TOTP_SECRET}&issuer=TabTop&digits=${VNC_TOTP_DIGITS}&period=30"
        cat >&2 <<EOF
************************************************************************
WARNING: using the well-known default TOTP secret ${DEFAULT_TOTP_SECRET}.
It is public, so ANYONE who can reach this site can generate login codes
and get the desktop and a shell as '${VNC_USER}'. Set VNC_TOTP_SECRET to
a random secret, e.g. from: head -c 20 /dev/urandom | base32
************************************************************************
EOF
        echo "Default secret for '${VNC_USER}' (${VNC_TOTP_DIGITS} digits, 30s):"
        echo "  URI: ${TOTP_URI}"
        printf '%s' "$TOTP_URI" | qrencode -t ANSIUTF8
    fi
    if [ "$DERIVED_SECRET" = 1 ]; then
        # The derived secret isn't VNC_TOTP_SECRET itself, so it's shown for
        # adding to an authenticator app.
        TOTP_URI="otpauth://totp/TabTop:${VNC_USER}?secret=${VNC_TOTP_SECRET}&issuer=TabTop&digits=${VNC_TOTP_DIGITS}&period=30"
        echo "VNC_TOTP_SECRET isn't valid Base32, so a TOTP secret is derived from"
        echo "it. Add this derived secret to an authenticator app (${VNC_TOTP_DIGITS} digits, 30s):"
        echo "  Secret: ${VNC_TOTP_SECRET}"
        echo "  URI:    ${TOTP_URI}"
        printf '%s' "$TOTP_URI" | qrencode -t ANSIUTF8
    fi
    unset VNC_TOTP_SECRET VNC_PASSWORD VNC_UPSTREAM_PASSWORD TOTP_HEX TOTP_ENTRY TOTP_URI OATH_PIN

    if [ ! -d /etc/chromium.d ]; then
        :  # no Chromium in this image
    elif [ "${CHROMIUM_NO_SANDBOX:-1}" = 1 ]; then
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

    # With WEB_AUDIO_SERVER, everything run as the user, the gateway and the
    # terminal's programs alike, plays to and records from the host's sound
    # server. PULSE_COOKIE, for a PulseAudio server that asks for its cookie,
    # is passed on as it is.
    USER_AUDIO_ENV=()
    if [ -n "$WEB_AUDIO_SERVER" ]; then
        USER_AUDIO_ENV+=(PULSE_SERVER="unix:${WEB_AUDIO_SERVER}")
        if [ -n "${PULSE_COOKIE:-}" ]; then
            USER_AUDIO_ENV+=(PULSE_COOKIE="$PULSE_COOKIE")
        fi
    fi
}

# Kept after service startup to preserve the original provisioning order.
configure_viewer() {
    local VNC_RESIZE="$1"
    # noVNC's defaults.json replaces its built-in setting defaults. A value the
    # viewer picks in the settings panel is saved in their browser and wins over
    # it, so VNC_RESIZE only applies to browsers that haven't chosen one. The
    # desktop reconnects by itself, every 2 seconds, when its connection is
    # lost (the files page and terminal do too: see reconnect.js).
    printf '{"resize": "%s", "reconnect": true, "reconnect_delay": 2000}\n' "$VNC_RESIZE" > /opt/novnc/defaults.json
    printf '%s\n' '<!doctype html><meta http-equiv="refresh" content="0; url=vnc.html?autoconnect=1">' \
        > /opt/novnc/index.html
}
