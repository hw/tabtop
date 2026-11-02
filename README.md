# TabTop

[![Build](https://github.com/hw/tabtop/actions/workflows/build.yml/badge.svg)](https://github.com/hw/tabtop/actions/workflows/build.yml)

An XFCE desktop with Chromium that you use from a web browser. noVNC shows the
desktop, and you log in with a TOTP code from an authenticator app (optionally
preceded by a password). The desktop's sound plays in the browser. The same
site also offers a terminal, and a files page for the desktop user's
`~/Downloads`, where files and folders can be downloaded (folders as
zips), previewed, uploaded (with a button, by dropping or pasting them on
the page, or by dropping them on the desktop), renamed, moved and deleted. When a file
is saved into `~/Downloads`, as when the desktop's Chromium finishes a
download, the desktop page offers to download it at once. Logins and everything after them
travel through an [encrypted tunnel](docs/encryption.md) between the page and the
gateway, so a proxy that decrypts HTTPS on the way can't read them.

The desktop, the terminal and the files page link to each other: noVNC's
control bar has buttons for the terminal and the files page, and the
other two pages a bar at the top with an icon for each page, drawn like
noVNC's own (hover over one for its name), the page you're on
highlighted. Each opens in its own tab, and a link
goes back to the tab already showing that page where the browser allows
(as for tabs opened from each other). Each also has a **Log out** icon, which
logs out of all three.

If the connection to the server is lost, as when the network drops or the
laptop sleeps, each page reconnects by itself. The desktop shows noVNC's
**Reconnecting...** and tries every 2 seconds (switch it off with
**Automatic reconnect** in noVNC's settings). The terminal and the files
page show a banner counting down to the next try, sooner at first and then
up to every 30 seconds, with **Try now**; they also try at once when the
browser comes back online or the tab is shown again. The terminal picks up
the same tmux session. Uploads and downloads that were cut off aren't
retried: start them again. When the server ends something on purpose,
nothing retries: a terminal whose shell exited waits for Enter, and an
ended session asks for a login.

Text copied on the desktop goes straight to your computer's clipboard, and
text copied on your computer goes to the desktop's when you switch back to
its tab, so **Ctrl+V** works both ways without noVNC's clipboard panel.
When the desktop copies something to your clipboard, the page says so for
a few seconds, with how it starts, so nothing lands there unnoticed.
Browsers only allow this over HTTPS or on `localhost`. Sending your
clipboard to the desktop needs the browser to let the page read it: Chrome
and Edge ask once, the first time you click on the desktop; Firefox and
Safari would ask every time, so there, use noVNC's clipboard panel for
that direction. Only what's copied is sent, not text that's merely
selected. To stop it, block clipboard access for the site in the
browser's site settings.

Everything is served on one port by `tabtopd` (in `tabtopd/`):

| Path | What it serves |
|---|---|
| `/` | The noVNC client, which connects to the desktop |
| `/downloads/` | The files page for `~/Downloads`: download (folders as zips), preview, upload, rename, move and delete files and folders |
| `/tty/` | A terminal (ghostty-web and tmux) |
| `/tunnel` | The [encrypted connection](docs/encryption.md) that carries the logins, the desktop, the terminal, files and sound for all of the above |
| `/healthz` | `ok` while the desktop is up and logins can work, for health checks |
| `/doctor` | A troubleshooting report, only with `WEB_DOCTOR_ENDPOINT=1` |

TabTop comes as two images: `tabtop`, with its own XFCE desktop (see
[Running TabTop with XFCE](docs/full-image.md)), and `tabtop-lite`, without
one, which shows a VNC server elsewhere, such as the host's own desktop
(see [Running tabtop-lite with the host's desktop](docs/lite.md)).

## Documentation

- [Running TabTop with XFCE](docs/full-image.md): the full image's desktop,
  clipboard and sound
- [Running tabtop-lite with the host's desktop](docs/lite.md): the host's
  VNC server, sound and an SSH terminal
- [Reverse proxy](docs/reverse-proxy.md): HTTPS in front of TabTop, with
  nginx examples at the root and under `WEB_BASE_PATH`
- [Environment variables](docs/environment.md): every setting in detail
- [Encryption and security](docs/encryption.md): the end-to-end encrypted
  tunnel, sessions and security notes
- [Downloads](docs/downloads.md): the files page
- [Terminal](docs/terminal.md): the browser terminal
- [Health checks](docs/health-checks.md): `/healthz` and the `/doctor`
  report
- [Building and development](docs/development.md): build arguments, tests
  and continuous integration
- [Credits](docs/credits.md): the projects TabTop is built on

## Local quick start

```sh
docker run -d --name tabtop -p 6080:6080 ghcr.io/hw/tabtop:latest
```
This runs the image GitHub Actions publishes to `ghcr.io/hw/tabtop`. To run
your own build instead, build it with `docker build -t tabtop .` and replace
`ghcr.io/hw/tabtop:latest` in the `docker run` command with `tabtop`.

Open <http://localhost:6080/> and enter the current code from your
authenticator app. To require a password as well, set `VNC_PASSWORD` (see below): then enter that password
immediately followed by the code, with no separator.

No persistent volume is required. To keep the same authenticator entry when
the container is replaced, keep passing the same `VNC_TOTP_SECRET`. You can
optionally mount storage at `/home/<VNC_USER>` to retain browser data, 
downloads and desktop settings as well.

## Secured local access 

Set the user and TOTP via environment variable:

```sh
docker run -d --name tabtop -p 6080:6080 \
  -e VNC_USER=$USER -e VNC_TOTP_SECRET="$(head -c 20 /dev/urandom | base32)" \
  ghcr.io/hw/tabtop:latest
docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' tabtop | grep VNC_TOTP_SECRET
```

Add that secret to an authenticator app as a time-based (TOTP) entry: 
SHA-1, 30 seconds and 6 digits, which are most apps' defaults. Without
`VNC_TOTP_SECRET`, the container uses a **well-known, public default secret** 
(see [Default TOTP secret](docs/environment.md#default-totp-secret)), which is only safe on a 
machine nobody else can reach.


## Managed deployment

TabTop is a standalone Linux/amd64 web application. It exposes one HTTP port,
`6080`, and runs with standard container settings. It needs no external
database, cache, service or persistent storage. The desktop, terminal,
downloads and audio all use the same HTTP endpoint, including their WebSocket
connections.

For managed platforms, configure these environment variables before the
first deployment:

```text
VNC_USER=<preferred user name>
VNC_TOTP_SECRET=<a fixed random string>
```

Set `VNC_TOTP_SECRET`. The container starts without it, but then uses the
public [default secret](docs/environment.md#default-totp-secret), with a warning, and anyone who
finds the site can log in. Keep the value unchanged across redeployments.

Any random string works, so the platform's own generator can create it. Use
at least 32 random characters.

- **Valid Base32** (only `A`–`Z` and `2`–`7`): it's the TOTP secret. Add it to
  the authenticator app as it is.
- **Anything else** (such as `0`, `1`, `8`, `9`, `-` or `_`, which
  general-purpose generators produce): a TOTP secret is derived from it, and
  the container prints that derived secret to the log at every start, with a
  QR code. Add the derived one to the authenticator app; see
  [Secrets that aren't Base32](docs/environment.md#secrets-that-arent-base32).

The platform should route its HTTPS address to container port `6080` and
forward WebSocket connections. For a reverse proxy you run yourself, see
[Reverse proxy](docs/reverse-proxy.md) (nginx at the site root or under
`WEB_BASE_PATH`). Set `WEB_TRUSTED_PROXIES` so failed-login limits use each
visitor's real address. A volume mounted at `/home/<VNC_USER>` is optional
and only retains browser data, downloads and desktop preferences.

## Environment variables

| Variable | Default | Description |
|---|---|---|
| [`VNC_USER`](docs/environment.md#vnc_user) | `user` | The desktop's Unix account, and the account name in the authenticator app. Logins don't ask for it. |
| [`VNC_PASSWORD`](docs/environment.md#vnc_password) | *(empty)* | Login password. When set, every login needs this password immediately followed by the current TOTP code. Empty: use `~/.config/tabtop/password` if present, otherwise TOTP-only. Never sent anywhere. |
| [`VNC_TOTP_SECRET`](docs/environment.md#vnc_totp_secret) | `JBSWY3DPEHPK3PXP` (public; see [Default TOTP secret](docs/environment.md#default-totp-secret)) | TOTP secret: Base32 is used as it is; any other string has a secret derived from it, printed at startup. Always set it for a site others can reach: the default is a well-known example secret, used with a warning in the log. |
| [`VNC_TOTP_DIGITS`](docs/environment.md#vnc_totp_digits) | `6` | Code length: `6`, `7` or `8`. |
| [`VNC_GEOMETRY`](docs/environment.md#vnc_geometry-and-vnc_resize) | `1600x900` | Desktop size before the first browser connects. |
| [`VNC_DEPTH`](docs/environment.md#vnc_depth) | `24` | Colour depth in bits: `16`, `24` or `32`. |
| [`VNC_RESIZE`](docs/environment.md#vnc_geometry-and-vnc_resize) | `remote` | Default way noVNC fits the desktop to the browser window: `remote`, `scale` or `off`. |
| [`VNC_UPSTREAM_PASSWORD`](docs/environment.md#vnc_upstream_password) | *(empty)* | With `VNC_ADDR`, the password to give that VNC server, so noVNC doesn't ask for it. The server's own, never TabTop's login password. |
| [`VNC_ADDR`](docs/environment.md#vnc_addr) | *(empty)* | An RFB (VNC) server to show instead of the container's own desktop, as `host:port`, `[IPv6]:port` or `unix:/path`. See [`VNC_ADDR`](docs/environment.md#vnc_addr). |
| [`VNC_X509`](docs/environment.md#vnc_x509) | `0` | `1` encrypts the connection to the VNC server at `VNC_ADDR` with TLS (VeNCrypt X509Vnc, or X509Plain with `VNC_UPSTREAM_USERNAME`), checking its certificate, with no unencrypted fallback. |
| [`VNC_UPSTREAM_USERNAME`](docs/environment.md#vnc_upstream_username) | *(empty)* | With `VNC_X509=1`, a username for the VNC server, which selects X509Plain: a Unix account on its machine, whose password is `VNC_UPSTREAM_PASSWORD`. |
| [`VNC_CA_FILE`](docs/environment.md#vnc_ca_file) | *(empty)* | With `VNC_X509=1`, the PEM certificates to trust instead of the system's, such as the VNC server's self-signed one, mounted into the container. |
| [`VNC_SERVER_NAME`](docs/environment.md#vnc_server_name) | *(the host in `VNC_ADDR`)* | With `VNC_X509=1`, the name the VNC server's certificate must carry; required for a Unix socket. |
| [`WEB_PORT`](docs/environment.md#web_port) | `6080` | Port the gateway listens on inside the container. |
| [`WEB_BASE_PATH`](docs/environment.md#web_base_path) | `/` | URL path the site is served under, e.g. `/tabtop/` behind a reverse proxy. |
| [`WEB_TRUSTED_PROXIES`](docs/environment.md#web_trusted_proxies) | *(empty)* | Comma-separated IPs or CIDR ranges of reverse proxies whose `X-Forwarded-For` header is believed; `cloudflare` stands for [Cloudflare's](docs/environment.md#behind-cloudflare) addresses. |
| [`WEB_TRUST_NPROXIES`](docs/environment.md#web_trust_nproxies) | `0` | How many proxies in front of the container to trust whatever their address, counting the one that connects, `0` to `10`; in addition to `WEB_TRUSTED_PROXIES`. See [`WEB_TRUST_NPROXIES`](docs/environment.md#web_trust_nproxies). |
| [`WEB_AUDIO`](docs/environment.md#web_audio) | `1` | `1` streams the desktop's sound to the browser. `0` turns it off. |
| [`WEB_AUDIO_BITRATE`](docs/environment.md#web_audio_bitrate) | `64` | Sound quality in kbit/s, `32` to `256`. |
| [`WEB_AUDIO_SERVER`](docs/environment.md#web_audio_server-and-web_audio_sink) | *(empty)* | A PulseAudio or PipeWire socket mounted from the host, such as `/run/host-pulse/native`, whose sound is streamed instead of the container's own. See [Host audio](docs/lite.md#host-audio). |
| [`WEB_AUDIO_SINK`](docs/environment.md#web_audio_server-and-web_audio_sink) | `@DEFAULT_SINK@` | With `WEB_AUDIO_SERVER`, the host's sink to stream; by default whichever is the host's default. |
| [`WEB_SESSION_MAX`](docs/environment.md#web_session_max-and-web_session_idle) | `12h` | How long a login lasts at most, in hours and minutes, such as `12h` or `90m`. See [Sessions](docs/encryption.md#sessions). |
| [`WEB_SESSION_IDLE`](docs/environment.md#web_session_max-and-web_session_idle) | `1h` | How long a login lasts with nothing open (no desktop, terminal or download), such as `1h` or `30m`. `0` for no limit. |
| [`WEB_TTY`](docs/environment.md#web_tty) | `1` | `1` serves a terminal at `/tty/`. `0` turns it off. |
| [`WEB_TTY_COMMAND`](docs/environment.md#web_tty_command) | *(empty)* | A command each terminal tab runs instead of tmux, such as `ssh -t me@host.docker.internal`. See [`WEB_TTY_COMMAND`](docs/environment.md#web_tty_command). |
| [`WEB_DOCTOR_ENDPOINT`](docs/environment.md#web_doctor_endpoint) | `0` | `1` serves a troubleshooting report at `/doctor`, without a login. See [Health checks](docs/health-checks.md). |
| [`CHROMIUM_NO_SANDBOX`](docs/environment.md#chromium_no_sandbox) | `1` | `1` runs Chromium with `--no-sandbox`. `0` keeps the sandbox on. |
| [`TZ`](docs/environment.md#tz) | `UTC` | Time zone, as a name such as `Europe/Berlin` or `Asia/Singapore`: for the desktop's clock, the terminal, everything else in the container, and the times on the files page. |

The container won't start if `VNC_TOTP_DIGITS`, `VNC_GEOMETRY`, `VNC_DEPTH`,
`VNC_RESIZE`, `VNC_ADDR`, `WEB_PORT`,
`VNC_X509` (or what it needs; see [`VNC_X509`](docs/environment.md#vnc_x509)),
`WEB_BASE_PATH`, `WEB_TRUSTED_PROXIES`, `WEB_TRUST_NPROXIES`,
`WEB_SESSION_MAX`, `WEB_SESSION_IDLE`, `WEB_AUDIO`, `WEB_AUDIO_BITRATE`,
`WEB_AUDIO_SERVER`, `WEB_AUDIO_SINK`,
`WEB_TTY`, `WEB_TTY_COMMAND`, `WEB_DOCTOR_ENDPOINT`, `TZ`, `VNC_PASSWORD` or
`VNC_UPSTREAM_PASSWORD` has
an invalid value. The error is printed to the log. `WEB_E2E` no longer exists, since
the tunnel is always on: `WEB_E2E=1` is accepted, and any other value stops
the container.

Each variable is described in detail in
[Environment variables](docs/environment.md).
