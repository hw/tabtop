# Web-accessible XFCE desktop with Chromium.
#
# TigerVNC (Xvnc) provides the X display, listening on localhost only.
# tabtopd (Go, in tabtopd/) is the one public web endpoint: it serves
# the noVNC client, bridges its WebSocket to Xvnc, and serves the user's
# ~/Downloads at /downloads/ behind its own TOTP login. It also streams the
# desktop's sound, which Chromium plays into a PipeWire null sink.
#
# Build: docker build -t tabtop .
# Local: docker run -d -p 6080:6080 \
#          -e VNC_USER=alice tabtop
# Enrol: docker logs <container>   (scan the QR code with an authenticator app)
# Open:  http://localhost:6080/   (log in with the current TOTP code)
# Files: http://localhost:6080/downloads/   (download files from ~/Downloads)
# Shell: http://localhost:6080/tty/   (terminal in the browser; same login)
#
# On managed platforms, set VNC_TOTP_SECRET to a fixed random 32-character
# Base32 value (A-Z and 2-7) and keep it unchanged across redeployments.
#
# No persistent volume is required. Optionally mount /home/$VNC_USER to keep
# browser data, downloads and desktop settings across container replacement.

# noVNC comes from its GitHub release rather than Debian's package, to get
# the upstream version. Bump NOVNC_VERSION and NOVNC_SHA256 together; the
# checksum is of https://github.com/novnc/noVNC/archive/refs/tags/v<ver>.tar.gz.
FROM debian:trixie-slim AS novnc
ARG NOVNC_VERSION=1.7.0
ARG NOVNC_SHA256=b1003a11b6e6e8d8f7f5e5586daae7f8ca651d8aee0aa155ff9ac841c48f52c6
ADD --checksum=sha256:${NOVNC_SHA256} \
    https://github.com/novnc/noVNC/archive/refs/tags/v${NOVNC_VERSION}.tar.gz /novnc.tar.gz
# Keep only what the web client loads (no tests, docs or build tooling).
RUN mkdir /novnc \
 && tar -xzf /novnc.tar.gz -C /novnc --strip-components=1 --no-same-owner \
        "noVNC-${NOVNC_VERSION}/app" \
        "noVNC-${NOVNC_VERSION}/core" \
        "noVNC-${NOVNC_VERSION}/vendor" \
        "noVNC-${NOVNC_VERSION}/vnc.html" \
        "noVNC-${NOVNC_VERSION}/vnc_lite.html" \
        "noVNC-${NOVNC_VERSION}/defaults.json" \
        "noVNC-${NOVNC_VERSION}/mandatory.json" \
        "noVNC-${NOVNC_VERSION}/package.json" \
        "noVNC-${NOVNC_VERSION}/LICENSE.txt" \
 && chmod -R u=rwX,go=rX /novnc
# The one change to noVNC: load the gateway's audio button. Fail the build if
# a new noVNC release no longer matches.
RUN sed -i 's|</head>|    <script type="module" src="tabtop/audio.js"></script>\n</head>|' /novnc/vnc.html \
 && grep -q 'src="tabtop/audio.js"' /novnc/vnc.html

# xterm.js for the browser terminal at /tty/, from npm. Bump each version
# together with its checksum (of the .tgz the URL points at).
FROM debian:trixie-slim AS xterm
ARG XTERM_VERSION=6.0.0
ARG XTERM_SHA256=908e66e04af6c8dc6b00dd3b54de088e2e81e5ed866284fd6c2fb3c2d1c7a3f6
ARG XTERM_FIT_VERSION=0.11.0
ARG XTERM_FIT_SHA256=26003b4517a132b64e4ff228fd88a5fda3fff5e606c76093f6dcff772e9ecec0
ARG XTERM_CLIPBOARD_VERSION=0.2.0
ARG XTERM_CLIPBOARD_SHA256=3c0556aa54c766fb415354ee179d16f44211708a133ba78c7234c1b7d606de7f
ADD --checksum=sha256:${XTERM_SHA256} \
    https://registry.npmjs.org/@xterm/xterm/-/xterm-${XTERM_VERSION}.tgz /xterm.tgz
ADD --checksum=sha256:${XTERM_FIT_SHA256} \
    https://registry.npmjs.org/@xterm/addon-fit/-/addon-fit-${XTERM_FIT_VERSION}.tgz /addon-fit.tgz
ADD --checksum=sha256:${XTERM_CLIPBOARD_SHA256} \
    https://registry.npmjs.org/@xterm/addon-clipboard/-/addon-clipboard-${XTERM_CLIPBOARD_VERSION}.tgz /addon-clipboard.tgz
# Powerline's symbol font (2 KB, U+E0A0-E0A2 and U+E0B0-E0B3) draws the
# arrows in tmux status lines; the browser's own monospace font does the rest.
ARG POWERLINE_VERSION=2.8.4
ARG POWERLINE_FONT_SHA256=4a2496a009b1649878ce067a7ec2aed9f79656c90136971e1dba00766515f7a1
ARG POWERLINE_LICENSE_SHA256=46d5355e4734468135d8e4a30d0916292cc4df2b3ec30aa68c866f82497933be
ADD --checksum=sha256:${POWERLINE_FONT_SHA256} \
    https://raw.githubusercontent.com/powerline/powerline/${POWERLINE_VERSION}/font/PowerlineSymbols.otf /xterm/PowerlineSymbols.otf
ADD --checksum=sha256:${POWERLINE_LICENSE_SHA256} \
    https://raw.githubusercontent.com/powerline/powerline/${POWERLINE_VERSION}/LICENSE /xterm/LICENSE.powerline
RUN mkdir /src \
 && tar -xzf /xterm.tgz -C /src --no-same-owner --transform 's|^package|xterm|' \
 && tar -xzf /addon-fit.tgz -C /src --no-same-owner --transform 's|^package|fit|' \
 && tar -xzf /addon-clipboard.tgz -C /src --no-same-owner --transform 's|^package|clipboard|' \
 && cp /src/xterm/lib/xterm.mjs /src/xterm/css/xterm.css /src/fit/lib/addon-fit.mjs \
       /src/clipboard/lib/addon-clipboard.mjs /xterm/ \
 && cp /src/xterm/LICENSE /xterm/LICENSE.xterm \
 && cp /src/fit/LICENSE /xterm/LICENSE.addon-fit \
 && cp /src/clipboard/LICENSE /xterm/LICENSE.addon-clipboard \
 && chmod -R u=rwX,go=rX /xterm

# The Go version matches mise.toml, which pins it for local development.
# tabtopd encodes audio with libopus and checks logins with liboath, through
# cgo, so it links the system's libraries and glibc; the final stage is the
# same Debian release, where libpam-oath brings liboath.
FROM golang:1.27.3-trixie AS tabtopd
RUN apt-get update \
 && apt-get install -y --no-install-recommends libopus-dev liboath-dev \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY tabtopd/go.mod tabtopd/go.sum ./
RUN go mod download
COPY tabtopd/*.go tabtopd/*.js tabtopd/*.html ./
RUN go build -trimpath -ldflags='-s -w' -o /tabtopd .

FROM debian:trixie-slim

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
        tini \
        tigervnc-standalone-server \
        xfce4-session \
        xfwm4 \
        xfce4-panel \
        xfdesktop4 \
        xfce4-settings \
        xfconf \
        xfce4-terminal \
        dbus-x11 \
        chromium \
        fonts-dejavu-core \
        fonts-noto-color-emoji \
        ca-certificates \
        procps \
        libpam-oath \
        oathtool \
        qrencode \
        libopus0 \
        pipewire \
        pipewire-pulse \
        wireplumber \
        pulseaudio-utils \
        tmux \
 && rm -rf /var/lib/apt/lists/*

COPY --from=novnc /novnc /opt/novnc
COPY --from=xterm /xterm /opt/xterm
COPY --chmod=755 entrypoint.sh /usr/local/bin/entrypoint.sh
COPY --chmod=755 healthcheck.sh /usr/local/bin/healthcheck
COPY --from=tabtopd /tabtopd /usr/local/bin/tabtopd

# VNC_USER: username asked for by the noVNC login prompt; the password is a
# TOTP code. VNC_TOTP_SECRET (base32) sets the TOTP key; if unset, the key
# saved in the home directory is used, or a new one is generated and its
# enrolment QR code printed to the log. VNC_TOTP_DIGITS: code length, 6, 7
# or 8. VNC_TOTP_SECRET and VNC_PASSWORD are left out of ENV below: they're
# secrets, passed at run time only. A fixed VNC_TOTP_SECRET is required for a
# managed deployment without persistent storage.
# VNC_RESIZE: default for how noVNC fits the desktop to the browser window:
# remote (resize the desktop to match), scale (scale the image) or off
# (scroll). Viewers can change it in noVNC's settings; their choice sticks.
# WEB_BASE_PATH: URL path the site is served under, for a reverse proxy that
# puts it in a subdirectory, e.g. /tabtop/ (default /). The proxy passes the
# path through unchanged.
# WEB_TRUSTED_PROXIES: comma-separated IPs or CIDR ranges of reverse proxies
# in front of the container. Their X-Forwarded-For header is used to find the
# visitor's IP, which failed logins are limited by; nobody else's is believed.
# Their X-Forwarded-Proto: https marks the login and audio cookies Secure.
# Empty (default): no proxy is trusted. The proxy must also pass the Host
# header through unchanged, or noVNC's WebSocket is refused as cross-origin.
# WEB_TTY=1 (default) serves a terminal at /tty/, behind the same login as
# /downloads/; 0 turns it off.
# WEB_AUDIO=1 (default) streams the desktop's sound to the browser; 0 turns
# it off and doesn't start PipeWire. WEB_AUDIO_BITRATE: its Opus bitrate in
# kbit/s, 32 to 256 (default 64); sent at a constant rate even in silence.
# WEB_DOCTOR_ENDPOINT=1 serves a troubleshooting report at <base>doctor,
# without a login; 0 (default) turns it off. <base>healthz always answers
# health checks.
# CHROMIUM_NO_SANDBOX=1 (default) disables Chromium's internal process
# sandbox for compatibility with restricted container runtimes. Keep the
# default on managed hosting; use 0 only where Chromium starts successfully
# with its sandbox enabled.
ENV VNC_USER=user \
    VNC_TOTP_DIGITS=6 \
    VNC_GEOMETRY=1600x900 \
    VNC_DEPTH=24 \
    VNC_RESIZE=remote \
    WEB_PORT=6080 \
    WEB_BASE_PATH=/ \
    WEB_TRUSTED_PROXIES= \
    WEB_AUDIO=1 \
    WEB_AUDIO_BITRATE=64 \
    WEB_TTY=1 \
    WEB_DOCTOR_ENDPOINT=0 \
    CHROMIUM_NO_SANDBOX=1

# tmux settings for the browser terminal (users' ~/.tmux.conf still applies
# after this): the mouse wheel scrolls tmux's history, and colours are 24-bit.
RUN printf '%s\n' \
        'set -g mouse on' \
        'set -g default-terminal tmux-256color' \
        'set -as terminal-features ",xterm-256color:RGB"' \
        > /etc/tmux.conf

# Default dotfiles for new homes (skel/): a ~/.tmux.conf with its theme and
# copy helper. The entrypoint copies them only into a new or fresh home, so an
# existing home keeps its own. The modes are set here so they don't depend
# on the umask of the checkout.
COPY skel/ /etc/skel/
RUN chmod -R u=rwX,go=rX /etc/skel

# XFCE defaults for new homes: one top panel (show desktop, window list,
# workspace name, tray and clock; no bottom dock, applications menu or
# log-out menu) and a single workspace called Main.
COPY --chmod=644 config/xfce4-panel.xml /etc/xdg/xfce4/panel/default.xml
COPY --chmod=644 config/xfwm4.xml /etc/xdg/xfce4/xfconf/xfce-perchannel-xml/xfwm4.xml

EXPOSE 6080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
    CMD ["/usr/local/bin/healthcheck"]

# tini runs as PID 1 to reap the desktop session's orphaned processes and
# forward signals to the entrypoint.
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint.sh"]
