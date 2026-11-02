#!/bin/bash
# Sets up a Debian host for tabtop-lite, as docs/lite.md describes: a
# TigerVNC desktop listening only on a Unix socket for the container to
# mount, the user's sound server, SSH and Docker. Then prints the docker run
# command to use. Run it as the user whose desktop it is (uid 1000, as the
# container's user), not as root: it uses sudo for what needs it. Running
# it again changes only what's different, and restarts the desktop only if
# its configuration changed.
#
# Usage: scripts/setup-lite-host.sh [options]
#        scripts/setup-lite-host.sh --add-ssh-key <container>
#
#   --display N         TigerVNC display number (default 1)
#   --geometry WxH      desktop size until a browser resizes it (default 1920x1080)
#   --session NAME      X session to run, from /usr/share/xsessions (default
#                       xfce, which installs XFCE)
#   --no-sound          leave the sound server alone
#   --no-ssh            don't install the SSH server
#   --no-docker         don't install Docker
#   --add-ssh-key C     once container C is running, give it an SSH key and let
#                       it log in to this user, for WEB_TTY_COMMAND
#
# The VNC password comes from TABTOP_VNC_PASSWORD, or is asked for. Give it
# to the container as VNC_UPSTREAM_PASSWORD, so the gateway logs in to the
# desktop for you. Make it its own, not TabTop's login password (the
# container's VNC_PASSWORD), which is never sent to the desktop.

# mkdir -p -m 700 makes only the last folder private, as meant: its parents
# (~/.config, ~/.local/state) keep the usual mode.
# shellcheck disable=SC2174
set -euo pipefail

display=1
geometry=1920x1080
session=xfce
sound=1
ssh=1
docker=1
add_key=

usage() { sed -n '/^# Usage:/,/^# container.s VNC_PASSWORD), which is never sent to the desktop\./s/^# \{0,1\}//p' "$0"; }
die() { echo "setup-lite-host: $*" >&2; exit 1; }
step() { printf '\n== %s\n' "$*"; }

while (($#)); do
    case "$1" in
        --display) display=${2:?}; shift ;;
        --geometry) geometry=${2:?}; shift ;;
        --session) session=${2:?}; shift ;;
        --no-sound) sound=0 ;;
        --no-ssh) ssh=0 ;;
        --no-docker) docker=0 ;;
        --add-ssh-key) add_key=${2:?}; shift ;;
        -h | --help) usage; exit 0 ;;
        *) usage >&2; exit 2 ;;
    esac
    shift
done

[[ "$display" =~ ^[0-9]{1,2}$ ]] || die "--display must be a number, such as 1"
[[ "$geometry" =~ ^[0-9]{3,5}x[0-9]{3,5}$ ]] || die "--geometry must be WIDTHxHEIGHT, such as 1920x1080"
[[ "$session" =~ ^[A-Za-z0-9._-]+$ ]] || die "--session must be a session name, such as xfce"
((EUID != 0)) || die "run it as the desktop's user, not root: it uses sudo where it needs to"

# --add-ssh-key: the container's user (VNC_USER) makes a key, if it hasn't
# one, and this user's authorized_keys takes it.
if [[ -n "$add_key" ]]; then
    container_user=$(docker exec "$add_key" printenv VNC_USER)
    docker exec -u "$container_user" "$add_key" sh -c \
        'test -f ~/.ssh/id_ed25519 || { mkdir -p -m 700 ~/.ssh && ssh-keygen -q -t ed25519 -N "" -f ~/.ssh/id_ed25519; }'
    key=$(docker exec -u "$container_user" "$add_key" sh -c 'cat ~/.ssh/id_ed25519.pub')
    mkdir -p -m 700 ~/.ssh
    touch ~/.ssh/authorized_keys
    chmod 600 ~/.ssh/authorized_keys
    if grep -qxF "$key" ~/.ssh/authorized_keys; then
        echo "$add_key's key is already in ~/.ssh/authorized_keys."
    else
        printf '%s\n' "$key" >> ~/.ssh/authorized_keys
        echo "Added $add_key's key to ~/.ssh/authorized_keys."
    fi
    exit 0
fi

command -v apt-get >/dev/null || die "this script is for Debian and its derivatives (apt)"
if [[ "$(id -u)" != 1000 ]]; then
    echo "Warning: your uid is $(id -u), not 1000. The container's user is uid 1000, and" >&2
    echo "the sockets it mounts only let their owner in, so it won't be able to use them." >&2
fi

# Packages -------------------------------------------------------------------

packages=(tigervnc-standalone-server tigervnc-tools dbus-x11)
[[ "$session" == xfce ]] && packages+=(xfce4)
((sound)) && packages+=(pipewire-pulse wireplumber)
((ssh)) && packages+=(openssh-server)
((docker)) && ! command -v docker >/dev/null && packages+=(docker.io)
step "Installing ${packages[*]}"
sudo apt-get update -qq
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq -o Dpkg::Use-Pty=0 --no-install-recommends \
    "${packages[@]}" >/dev/null

[[ -f "/usr/share/xsessions/$session.desktop" ]] ||
    die "there's no X session called $session in /usr/share/xsessions; install its desktop, or pick another with --session"

# TigerVNC -------------------------------------------------------------------

# TigerVNC 1.14 and later (Debian 13) keep their files in
# ~/.config/tigervnc, with config.pl; earlier ones (Debian 12) in ~/.vnc,
# with tigervnc.conf.
version=$(dpkg-query -W -f='${Version}' tigervnc-standalone-server)
if dpkg --compare-versions "$version" ge 1.14; then
    vnc_dir="${XDG_CONFIG_HOME:-$HOME/.config}/tigervnc"
    vnc_conf="$vnc_dir/config.pl"
else
    vnc_dir="$HOME/.vnc"
    vnc_conf="$vnc_dir/tigervnc.conf"
fi
socket_dir="$HOME/.local/state/tabtop"
service="tigervncserver@:$display"
changed=0

step "TigerVNC's password ($vnc_dir/passwd)"
if [[ -s "$vnc_dir/passwd" && -z "${TABTOP_VNC_PASSWORD:-}" ]]; then
    echo "Keeping the password already set. To change it, set TABTOP_VNC_PASSWORD, or run tigervncpasswd."
else
    password=${TABTOP_VNC_PASSWORD:-}
    if [[ -z "$password" ]]; then
        read -rsp "VNC password (the container's VNC_UPSTREAM_PASSWORD): " password; echo
        read -rsp "Again: " again; echo
        [[ "$password" == "$again" ]] || die "the passwords don't match"
    fi
    [[ -n "$password" ]] || die "the password is empty"
    [[ "$password" != *[[:cntrl:]]* ]] || die "the password can't contain control characters"
    ((${#password} <= 8)) || echo "Note: VNC uses only the first 8 characters of a password."
    mkdir -p -m 700 "$vnc_dir"
    printf '%s\n' "$password" | tigervncpasswd -f > "$vnc_dir/passwd.new"
    chmod 600 "$vnc_dir/passwd.new"
    mv "$vnc_dir/passwd.new" "$vnc_dir/passwd"
    unset password again
    changed=1
fi

step "TigerVNC's configuration ($vnc_conf)"
mkdir -p -m 700 "$socket_dir"
conf=$(cat <<EOF
# Written by tabtop's scripts/setup-lite-host.sh: the desktop listens only
# on a Unix socket, which the tabtop-lite container mounts.
\$session = "$session";
\$SecurityTypes = "VncAuth";
\$geometry = "$geometry";
\$rfbunixpath = "\$ENV{HOME}/.local/state/tabtop/vnc.sock";
\$rfbport = -1;
EOF
)
if [[ -f "$vnc_conf" ]] && [[ "$(cat "$vnc_conf")" == "$conf" ]]; then
    echo "Already set."
else
    if [[ -f "$vnc_conf" ]]; then
        cp "$vnc_conf" "$vnc_conf.bak"
        echo "Saved the old one as $vnc_conf.bak."
    fi
    mkdir -p -m 700 "$vnc_dir"
    printf '%s\n' "$conf" > "$vnc_conf"
    echo "Written."
    changed=1
fi

step "Display :$display for $USER (/etc/tigervnc/vncserver.users)"
owner=$(sed -n "s/^:$display=//p" /etc/tigervnc/vncserver.users | tail -n 1)
if [[ "$owner" == "$USER" ]]; then
    echo "Already set."
elif [[ -n "$owner" ]]; then
    die "display :$display belongs to $owner; pick another with --display"
else
    echo ":$display=$USER" | sudo tee -a /etc/tigervnc/vncserver.users >/dev/null
    echo "Added."
fi

step "Starting $service now and at every boot"
sudo systemctl enable "$service"
if ! systemctl is-active --quiet "$service"; then
    sudo systemctl start "$service"
elif ((changed)); then
    echo "Restarting it for the new configuration, which ends the session running in it."
    sudo systemctl restart "$service"
else
    echo "Already running."
fi
for _ in $(seq 20); do
    [[ -S "$socket_dir/vnc.sock" ]] && break
    sleep 0.5
done
[[ -S "$socket_dir/vnc.sock" ]] ||
    die "$socket_dir/vnc.sock didn't appear; see: journalctl -u $service, and the logs in $vnc_dir"
echo "Listening on $socket_dir/vnc.sock."

# Sound ----------------------------------------------------------------------

pulse="/run/user/$(id -u)/pulse"
if ((sound)); then
    step "Sound: keeping $USER's services running without a login"
    sudo loginctl enable-linger "$USER"
    systemctl --user enable --now pipewire-pulse.socket 2>/dev/null || true
    for _ in $(seq 20); do
        [[ -S "$pulse/native" ]] && break
        sleep 0.5
    done
    if [[ -S "$pulse/native" ]]; then
        echo "The sound server's socket is $pulse/native."
    else
        echo "Warning: $pulse/native isn't there yet; it should be once you've logged in again." >&2
    fi
fi

# SSH ------------------------------------------------------------------------

if ((ssh)); then
    step "SSH"
    sudo systemctl enable --now ssh
    echo "Running. Once the container is up, let it log in with: $0 --add-ssh-key tabtop"
fi

# The container ----------------------------------------------------------------

step "Done. Start tabtop-lite with:"
cat <<EOF

docker run -d --name tabtop -p 6080:6080 --restart unless-stopped \\
  --add-host host.docker.internal:host-gateway \\
  -e VNC_TOTP_SECRET="\$(head -c 20 /dev/urandom | base32)" \\
  -e VNC_USER="$USER" \\
  -e VNC_PASSWORD='<a login password>' \\
  -e VNC_UPSTREAM_PASSWORD='<the VNC password>' \\
  -v $socket_dir:/run/host-vnc \\
  -e VNC_ADDR=unix:/run/host-vnc/vnc.sock \\
EOF
if ((sound)); then
    cat <<EOF
  -v $pulse:/run/host-pulse \\
  -e WEB_AUDIO_SERVER=/run/host-pulse/native \\
EOF
fi
if ((ssh)); then
    cat <<EOF
  -e WEB_TTY_COMMAND="ssh -t $USER@host.docker.internal" \\
EOF
fi
cat <<EOF
  -v tabtop-home:/home/$USER \\
  ghcr.io/hw/tabtop-lite:latest
docker logs tabtop    # the TOTP secret's QR code, for an authenticator app
EOF
((ssh)) && printf '%s --add-ssh-key tabtop\n' "$0"
cat <<EOF

Then log in at http://<this host>:6080/ with the login password followed by
the current code. See docs/lite.md.
EOF
