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
# The changes to noVNC: load the gateway's audio button, and let its
# novnc.js supply the connection (the encrypted tunnel) instead of noVNC's
# own WebSocket. novnc.js goes before noVNC's scripts,
# since module scripts run in order, so it's ready before noVNC connects.
# Fail the build if a new noVNC release no longer matches.
RUN sed -i 's|</head>|    <script type="module" src="tabtop/audio.js"></script>\n</head>|' /novnc/vnc.html \
 && sed -i '0,/<script type="module"/s|<script type="module"|<script type="module" src="tabtop/novnc.js"></script>\n    &|' /novnc/vnc.html \
 && sed -i 's|^\( *\)url\.href,$|\1window.tabtopChannel ? window.tabtopChannel() : url.href,|' /novnc/app/ui.js \
 && grep -q 'src="tabtop/audio.js"' /novnc/vnc.html \
 && grep -q 'src="tabtop/novnc.js"' /novnc/vnc.html \
 && grep -q 'window.tabtopChannel() : url.href,' /novnc/app/ui.js

# ghostty-web for the browser terminal at /tty/, from npm: Ghostty's
# terminal emulator compiled to WebAssembly, which its one module carries
# inline. Bump the version together with its checksum (of the .tgz the URL
# points at). The stub module it imports (only used outside browsers) must
# keep its name; the build fails if a release changes it.
FROM debian:trixie-slim AS terminal
ARG GHOSTTY_WEB_VERSION=0.4.0
ARG GHOSTTY_WEB_SHA256=90bf473b6c7f43ab5e52ee98d8295e04fb1c6b07b928e9795489df1e8cb8802e
ADD --checksum=sha256:${GHOSTTY_WEB_SHA256} \
    https://registry.npmjs.org/ghostty-web/-/ghostty-web-${GHOSTTY_WEB_VERSION}.tgz /ghostty-web.tgz
# Powerline's symbol font (2 KB, U+E0A0-E0A2 and U+E0B0-E0B3) draws the
# arrows in tmux status lines; the browser's own monospace font does the rest.
ARG POWERLINE_VERSION=2.8.4
ARG POWERLINE_FONT_SHA256=4a2496a009b1649878ce067a7ec2aed9f79656c90136971e1dba00766515f7a1
ARG POWERLINE_LICENSE_SHA256=46d5355e4734468135d8e4a30d0916292cc4df2b3ec30aa68c866f82497933be
ADD --checksum=sha256:${POWERLINE_FONT_SHA256} \
    https://raw.githubusercontent.com/powerline/powerline/${POWERLINE_VERSION}/font/PowerlineSymbols.otf /terminal/PowerlineSymbols.otf
ADD --checksum=sha256:${POWERLINE_LICENSE_SHA256} \
    https://raw.githubusercontent.com/powerline/powerline/${POWERLINE_VERSION}/LICENSE /terminal/LICENSE.powerline
RUN mkdir /src \
 && tar -xzf /ghostty-web.tgz -C /src --no-same-owner \
 && cp /src/package/dist/ghostty-web.js /src/package/dist/__vite-browser-external-2447137e.js /terminal/ \
 && grep -q '__vite-browser-external-2447137e.js' /terminal/ghostty-web.js \
 && cp /src/package/LICENSE /terminal/LICENSE.ghostty-web \
 && chmod -R u=rwX,go=rX /terminal

# The noble libraries, for the cryptography the encrypted tunnel does in the
# browser: ChaCha20-Poly1305 from @noble/ciphers, which browsers don't have,
# and X25519 from @noble/curves and SHA-2 and HKDF from @noble/hashes, for
# pages without WebCrypto (such as plain-HTTP ones). From npm; bump each version together with its
# checksum (of the .tgz the URL points at), and @noble/curves together with
# the @noble/hashes version it depends on. Only the files tunnel.js needs are
# kept (tabtopd's nobleFiles lists the same ones), and @noble/curves' imports
# of @noble/hashes are made relative, since browsers can't resolve package
# names.
FROM debian:trixie-slim AS noble
ARG NOBLE_CIPHERS_VERSION=2.4.0
ARG NOBLE_CIPHERS_SHA256=4a398bcc280c8742d474f9162f6d3c153e52ab1078e8ab592b4720410fb3c3e9
ARG NOBLE_CURVES_VERSION=2.4.0
ARG NOBLE_CURVES_SHA256=55279c71b0201d6c0e58d0206d15825359e02a3932f326ba7b7909ac2d334aa9
ARG NOBLE_HASHES_VERSION=2.4.0
ARG NOBLE_HASHES_SHA256=e1946149b780017b2564fcc092cb01c04e1d7f20627d0296c17da8868f4436dc
ADD --checksum=sha256:${NOBLE_CIPHERS_SHA256} \
    https://registry.npmjs.org/@noble/ciphers/-/ciphers-${NOBLE_CIPHERS_VERSION}.tgz /ciphers.tgz
ADD --checksum=sha256:${NOBLE_CURVES_SHA256} \
    https://registry.npmjs.org/@noble/curves/-/curves-${NOBLE_CURVES_VERSION}.tgz /curves.tgz
ADD --checksum=sha256:${NOBLE_HASHES_SHA256} \
    https://registry.npmjs.org/@noble/hashes/-/hashes-${NOBLE_HASHES_VERSION}.tgz /hashes.tgz
RUN set -e; mkdir /noble; for p in ciphers curves hashes; do \
      mkdir -p /src/$p; tar -xzf /$p.tgz -C /src/$p --strip-components=1 --no-same-owner; \
      cp /src/$p/LICENSE /noble/LICENSE.noble-$p; \
    done \
 && cd /src \
 && cp --parents ciphers/chacha.js ciphers/_arx.js ciphers/_poly1305.js ciphers/utils.js \
      curves/ed25519.js curves/utils.js curves/abstract/curve.js curves/abstract/edwards.js \
      curves/abstract/fft.js curves/abstract/frost.js curves/abstract/hash-to-curve.js \
      curves/abstract/modular.js curves/abstract/montgomery.js curves/abstract/oprf.js \
      hashes/sha2.js hashes/_md.js hashes/_u64.js hashes/hkdf.js hashes/hmac.js hashes/utils.js /noble/ \
 && sed -i "s#from '@noble/hashes/#from '../hashes/#" /noble/curves/*.js \
 && sed -i "s#from '@noble/hashes/#from '../../hashes/#" /noble/curves/abstract/*.js \
 && ! grep -rnE "^[^*]*from ['\"]@noble/" /noble \
 && chmod -R u=rwX,go=rX /noble

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

# No wallpapers: they come with xfdesktop4-data, which xfdesktop4 needs, so
# dpkg is told not to install their files. The background is plain black.
RUN printf '%s\n' 'path-exclude=/usr/share/backgrounds/*' > /etc/dpkg/dpkg.cfg.d/no-wallpapers

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
        thunar \
        dbus-x11 \
        chromium \
        arc-theme \
        numix-icon-theme \
        librsvg2-common \
        fonts-dejavu-core \
        fonts-noto-color-emoji \
        ca-certificates \
        tzdata \
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
        openssh-client \
        mosh \
        less \
        curl \
        wget \
        gzip \
        zip \
        unzip \
        unrar-free \
        vim-tiny \
        && update-alternatives --install /usr/bin/vi vi /usr/bin/vim.tiny 60 \
        && update-alternatives --set vi /usr/bin/vim.tiny \
        && rm -rf /var/lib/apt/lists/*

COPY --from=novnc /novnc /opt/novnc
COPY --from=terminal /terminal /opt/terminal
COPY --from=noble /noble /opt/noble
COPY --chmod=755 entrypoint.sh /usr/local/bin/entrypoint.sh
COPY --chmod=755 healthcheck.sh /usr/local/bin/healthcheck
COPY --chmod=755 config/notify /usr/local/bin/notify
COPY --from=tabtopd /tabtopd /usr/local/bin/tabtopd

# VNC_USER: the desktop's Linux user, and the account name shown in the
# authenticator app. Logins take only a TOTP code (or password + code). VNC_TOTP_SECRET sets the TOTP key: Base32 is used as it is, and
# any other string has a key derived from it, printed at startup for the
# authenticator app. If it's unset, the key saved in the home directory is
# used, or else the PUBLIC example secret JBSWY3DPEHPK3PXP, with a warning on
# every start. VNC_TOTP_DIGITS: code length, 6, 7 or 8. VNC_TOTP_SECRET and
# VNC_PASSWORD are left out of ENV below: they're secrets, passed at run time
# only. Set a fixed, random VNC_TOTP_SECRET for any deployment others can
# reach.
# VNC_RESIZE: default for how noVNC fits the desktop to the browser window:
# remote (resize the desktop to match), scale (scale the image) or off
# (scroll). Viewers can change it in noVNC's settings; their choice sticks.
# VNC_ADDR: an RFB server to show instead of the container's own desktop,
# host:port or unix:/path; empty (default) starts Xvnc, XFCE and the sound
# here. The gateway's connection to it isn't encrypted: keep it private.
# WEB_BASE_PATH: URL path the site is served under, for a reverse proxy that
# puts it in a subdirectory, e.g. /tabtop/ (default /). The proxy passes the
# path through unchanged.
# WEB_TRUSTED_PROXIES: comma-separated IPs or CIDR ranges of reverse proxies
# in front of the container. Their X-Forwarded-For header is used to find the
# visitor's IP, which failed logins are limited by; nobody else's is believed.
# cloudflare stands for Cloudflare's published ranges, for a site behind
# Cloudflare that it connects to directly; with a Cloudflare Tunnel, trust
# cloudflared's address instead.
# Empty (default): no proxy is trusted. The proxy must also pass the Host
# header through unchanged, or the tunnel's WebSocket is refused as
# cross-origin.
# WEB_TRUST_NPROXIES: how many proxies in front of the container are trusted
# whatever their address (0 to 10), counting the one that connects, for
# proxies whose addresses change, such as a platform's load balancer. Trusted
# in addition to WEB_TRUSTED_PROXIES. Set it to exactly the number of proxies
# every visitor passes through; one too many lets visitors pick their own IP.
# 0 (default): trust by address only.
# WEB_SESSION_MAX: how long a login lasts at most, in hours and minutes,
# such as 12h (default) or 90m. Open tunnels close when it ends.
# WEB_SESSION_IDLE: how long a login lasts with no desktop, terminal or
# other tunnel open, such as 1h (default) or 30m; 0 for no limit.
# WEB_TTY=1 (default) serves a terminal at /tty/, behind the same login as
# the desktop and /downloads/; 0 turns it off.
# TTY_COMMAND: a shell command each terminal tab runs instead of tmux,
# e.g. ssh -t me@host.docker.internal; empty (default) for tmux.
# WEB_AUDIO=1 (default) streams the desktop's sound to the browser; 0 turns
# it off and doesn't start PipeWire. WEB_AUDIO_BITRATE: its Opus bitrate in
# kbit/s, 32 to 256 (default 64); sent at a constant rate even in silence.
# WEB_AUDIO_SERVER: a PulseAudio socket mounted from the host, streamed
# instead of the container's own sound (PipeWire isn't started then);
# WEB_AUDIO_SINK: its sink, by default the host's default (@DEFAULT_SINK@).
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
    WEB_TRUST_NPROXIES=0 \
    WEB_SESSION_MAX=12h \
    WEB_SESSION_IDLE=1h \
    WEB_AUDIO=1 \
    WEB_AUDIO_BITRATE=64 \
    WEB_TTY=1 \
    WEB_DOCTOR_ENDPOINT=0 \
    CHROMIUM_NO_SANDBOX=1

# tmux settings for the browser terminal (users' ~/.tmux.conf still applies
# after this): the mouse wheel scrolls tmux's history, colours are 24-bit,
# and programs can pass sequences through to the browser's terminal, as
# notify does for its notifications (tmux keeps those to itself otherwise).
RUN printf '%s\n' \
        'set -g mouse on' \
        'set -g allow-passthrough on' \
        'set -g default-terminal tmux-256color' \
        'set -as terminal-features ",xterm-256color:RGB"' \
        > /etc/tmux.conf

# Default dotfiles for new homes (skel/): a ~/.tmux.conf with its theme and
# copy helper. The entrypoint copies them only into a new or fresh home, so an
# existing home keeps its own. The modes are set here so they don't depend
# on the umask of the checkout.
COPY skel/ /etc/skel/
RUN chmod -R u=rwX,go=rX /etc/skel

# Shell prompt and terminal title without the hostname (a container ID):
# "alice:~$". Fail the build if Debian's prompts no longer match.
RUN sed -i 's/\\u@\\h/\\u/g' /etc/skel/.bashrc /etc/bash.bashrc \
 && ! grep -q '\\h' /etc/skel/.bashrc /etc/bash.bashrc \
 && grep -q 'PS1=.*\\u' /etc/skel/.bashrc

# XFCE defaults for new homes: one top panel (show desktop, Chromium
# incognito and terminal launchers, window list, workspace name, tray and clock; no bottom
# dock, applications menu or log-out menu), a single workspace called Main,
# the Arc-Dark theme for applications and window borders, Numix icons, and a
# plain black desktop without a Trash icon.
COPY --chmod=644 config/xfce4-panel.xml /etc/xdg/xfce4/panel/default.xml
COPY --chmod=644 config/xfwm4.xml config/xsettings.xml config/xfce4-desktop.xml \
    /etc/xdg/xfce4/xfconf/xfce-perchannel-xml/

# Default applications: Chromium in incognito mode for web links (XFCE's
# helper, the XDG MIME defaults and Debian's x-www-browser), xfce4-terminal
# for terminals and Thunar for folders.
COPY --chmod=755 config/chromium-incognito /usr/local/bin/
COPY --chmod=644 config/chromium-incognito.desktop /usr/share/applications/
COPY --chmod=644 config/xfce-helper-chromium-incognito.desktop \
    /usr/share/xfce4/helpers/chromium-incognito.desktop
COPY --chmod=644 config/helpers.rc /etc/xdg/xfce4/helpers.rc
COPY --chmod=644 config/mimeapps.list /etc/xdg/mimeapps.list
RUN update-alternatives --install /usr/bin/x-www-browser x-www-browser \
        /usr/local/bin/chromium-incognito 100

EXPOSE 6080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
    CMD ["/usr/local/bin/healthcheck"]

# tini runs as PID 1 to reap the desktop session's orphaned processes and
# forward signals to the entrypoint.
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint.sh"]
