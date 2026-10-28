# TabTop

An XFCE desktop with Chromium that you use from a web browser. noVNC shows the
desktop, and you log in with a TOTP code from an authenticator app (optionally
preceded by a password). The desktop's sound plays in the browser. The same
site also offers a terminal, and files in the desktop user's `~/Downloads` can
be downloaded from it.

Everything is served on one port by `tabtopd` (in `tabtopd/`):

| Path | What it serves |
|---|---|
| `/` | The noVNC client, which connects to the desktop |
| `/websockify` | The WebSocket that carries the desktop session |
| `/downloads/` | A file list of `~/Downloads`, with its own login |
| `/tty/` | A terminal (xterm.js and tmux), sharing the `/downloads/` login |
| `/audio/ws`, `/audio/stream.ogg` | The desktop's sound, for browsers logged in to the desktop |

## Quick start

```sh
docker build -t tabtop .
docker run -d --name tabtop -p 6080:6080 --shm-size=1g \
  -v tabtop-home:/home/alice -e VNC_USER=alice tabtop
docker logs tabtop    # scan the QR code with an authenticator app
```

GitHub Actions also publishes the image to `ghcr.io/hw/tabtop`. To use it
instead of building, replace the last `tabtop` in the `docker run` command
with `ghcr.io/hw/tabtop:latest`.

Open <http://localhost:6080/>, enter the username (`alice`) and the current
code from your authenticator app as the password. To require a password as
well, set `VNC_PASSWORD` (see below): then enter that password immediately
followed by the code, with no separator.

Mount the volume at `/home/<VNC_USER>`. It holds the TOTP secret, an optional
password file, the Chromium profile and the XFCE settings. Without a volume,
removing the container loses the secret, so you'd have to scan a new QR code.

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `VNC_USER` | `user` | Desktop username. You enter it at the login prompt. |
| `VNC_PASSWORD` | *(empty)* | Login password. When set, every login needs this password immediately followed by the current TOTP code. Empty: use `~/.config/tabtop/password` if present, otherwise TOTP-only. |
| `VNC_TOTP_SECRET` | *(empty)* | Base32 TOTP secret. Empty: use the secret saved in the home volume, or generate one and print its QR code to the log. |
| `VNC_TOTP_DIGITS` | `6` | Code length: `6`, `7` or `8`. |
| `VNC_GEOMETRY` | `1600x900` | Desktop size before the first browser connects. |
| `VNC_DEPTH` | `24` | Colour depth in bits. |
| `VNC_RESIZE` | `remote` | Default way noVNC fits the desktop to the browser window: `remote`, `scale` or `off`. |
| `WEB_PORT` | `6080` | Port the gateway listens on inside the container. |
| `WEB_BASE_PATH` | `/` | URL path the site is served under, e.g. `/tabtop/` behind a reverse proxy. |
| `WEB_TRUSTED_PROXIES` | *(empty)* | Comma-separated IPs or CIDR ranges of reverse proxies whose `X-Forwarded-For` header is believed. |
| `WEB_AUDIO` | `1` | `1` streams the desktop's sound to the browser. `0` turns it off. |
| `WEB_AUDIO_BITRATE` | `64` | Sound quality in kbit/s, `32` to `256`. |
| `WEB_TTY` | `1` | `1` serves a terminal at `/tty/`. `0` turns it off. |
| `CHROMIUM_NO_SANDBOX` | `1` | `1` runs Chromium with `--no-sandbox`. `0` keeps the sandbox on. |

The container won't start if `VNC_TOTP_DIGITS`, `VNC_RESIZE`,
`WEB_BASE_PATH`, `WEB_TRUSTED_PROXIES`, `WEB_AUDIO`, `WEB_AUDIO_BITRATE`,
`WEB_TTY`, `VNC_TOTP_SECRET` or `VNC_PASSWORD` has an invalid value. The
error is printed to the log.

### `VNC_USER`

The desktop runs as this Unix account, and it's the username for both the
desktop login and the files page. The account's own Unix password stays
locked: login uses pam_oath (TOTP, with an optional password PIN) instead.

### `VNC_PASSWORD`

When a password is configured, the desktop, files page and terminal all
require **password immediately followed by the current TOTP code** in the
password field — for example password `s3cret` and code `842391` →
`s3cret842391`. There is no separator. The last `VNC_TOTP_DIGITS` characters
are the code; everything before them is the password.

The password is chosen in this order:

1. `VNC_PASSWORD`, if the variable is set. It isn't saved to the volume or
   printed to the log. An empty value means TOTP-only for this run.
2. The password saved in the home volume at `~/.config/tabtop/password`.
3. No password: TOTP-only (backward compatible).

A password must not contain whitespace (pam_oath's users file is
whitespace-separated). Unlike the TOTP secret, a password is never
auto-generated: set the variable or create the file yourself. An
env-supplied password is not written to the volume; to persist one without
re-passing the env, put it in `~/.config/tabtop/password`.

A password passed in this variable can be read by anyone who can run
`docker inspect` on the container. The password is also stored in plaintext
as the pam_oath PIN in `~/.config/tabtop/users.oath` (required by
pam_oath), so anyone logged in to the desktop can read it.

### `VNC_TOTP_SECRET`

The TOTP secret is chosen in this order:

1. `VNC_TOTP_SECRET`, if it's set. It isn't saved to the volume or printed to
   the log, since you already have it.
2. The secret saved in the home volume at `~/.config/tabtop/totp-secret`.
3. A newly generated secret. It's saved to that file, and its QR code, secret
   and `otpauth://` URI are printed to `docker logs` once.

Spaces, `=` padding and lowercase are accepted, so you can paste a secret the
way an authenticator app or password manager shows it.

To get a new secret, delete `~/.config/tabtop/totp-secret` in the volume
and restart the container.

A secret passed in this variable can be read by anyone who can run
`docker inspect` on the container. Anyone logged in to the desktop can also
read the saved file in the home folder.

### `VNC_TOTP_DIGITS`

Codes change every 30 seconds. To allow for clock differences, the previous
and next code are accepted too. Each code works only once, across the
desktop, `/downloads/` and `/tty/` together and across restarts: after logging
in to one, wait for the next code to log in to another. Once a code is used,
earlier ones are refused too.

If you change the digit count, remove the entry from your authenticator app
and add it again. Some apps ignore the digit count in the QR code and always
show 6 digits, so use `6` unless your app supports more.

### `VNC_GEOMETRY` and `VNC_RESIZE`

`VNC_RESIZE` decides what happens to the desktop size once a browser
connects:

- `remote`: the desktop is resized to the browser window. `VNC_GEOMETRY`
  only matters until then.
- `scale`: the desktop stays at `VNC_GEOMETRY`, and the browser scales the
  image to fit the window.
- `off`: the desktop stays at `VNC_GEOMETRY`, and the browser adds scrollbars
  if the window is smaller.

`VNC_RESIZE` is only a default. Viewers can change it in noVNC's settings
panel, and their browser remembers their choice, so a later change to
`VNC_RESIZE` doesn't affect them. To pick up the new default, they can choose
a mode in the panel or clear the site's data.

### `WEB_PORT`

The port inside the container. If you change it, publish the new port with
`-p`. The healthcheck follows the variable.

### `WEB_BASE_PATH`

Serves the site under a subdirectory, so a reverse proxy can put it at
`https://example.com/tabtop/` next to other sites. The paths in the table at
the top move under it: `/tabtop/downloads/`, `/tabtop/tty/` and so on.

```sh
-e WEB_BASE_PATH=/tabtop/
```

- **Format:** slashes at the ends are added if missing, so `tabtop`,
  `/tabtop` and `/tabtop/` are the same. Each part may only contain letters,
  digits, `-`, `.`, `_` and `~`, and can't be `.` or `..`.
- **Other paths:** `/tabtop` redirects to `/tabtop/`, and anything outside
  `/tabtop/` is not found. That includes `/`, so open
  `http://localhost:6080/tabtop/` when connecting to the container directly.
- **Cookies:** the login cookies are limited to the base path, so other sites
  under the same host don't receive them.
- **Same host, same origin:** browsers don't separate sites by path. Any page
  on the same host can script this one, and noVNC's settings and the audio
  preference are shared with other copies of TabTop on that host. Only put it
  next to sites you trust.

The proxy passes the path through unchanged, without stripping the base. With
nginx, give `proxy_pass` no path after the address. `absolute_redirect off`
keeps nginx's own redirect from `/tabtop` to `/tabtop/` working when its port
differs from the one in the browser. The other settings are the same as in the
[`WEB_TRUSTED_PROXIES`](#web_trusted_proxies) example:

```nginx
location /tabtop/ {
    absolute_redirect off;
    proxy_pass http://tabtop:6080;
    proxy_http_version 1.1;
    proxy_set_header Host $http_host;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 1h;
}
```

### `WEB_TRUSTED_PROXIES`

The gateway limits failed logins per visitor IP, counting the desktop and the
files page together: 5 failures in 5 minutes locks that IP out for the rest
of the window. Behind a reverse proxy, every visitor seems to come from the
proxy's IP, so one person's failed logins would lock everyone out. Set this
variable to the proxy's address, and the gateway uses `X-Forwarded-For` to
find each visitor's IP.

```sh
-e WEB_TRUSTED_PROXIES=10.0.0.5
-e WEB_TRUSTED_PROXIES=10.0.0.5,172.16.0.0/12
```

- **Untrusted senders:** the header is ignored for everyone else, so visitors
  can't send a fake one.
- **Reading the header:** it's read from right to left. Entries added by
  trusted proxies are skipped, and the first other address is the visitor.
  Anything further left is ignored, since the visitor could have written it.
- **Docker networks:** a proxy container's IP can change when it's
  recreated. Trust the network's CIDR range, or give the proxy a fixed IP.

The proxy has to:

- Pass the `Host` header through unchanged. Otherwise the gateway refuses
  noVNC's WebSocket as cross-origin.
- Forward WebSocket upgrades.
- Allow long idle times, or idle desktop sessions get cut off.
- Send `X-Forwarded-Proto`. When it says `https`, the login and audio
  cookies are marked `Secure`, so the browser never sends them over plain
  HTTP. Like `X-Forwarded-For`, it's only believed from the addresses in
  this variable: without them, cookies aren't marked `Secure` even behind an
  HTTPS proxy.

For example, with nginx:

```nginx
map $http_upgrade $connection_upgrade { default upgrade; '' close; }

server {
    listen 80;
    location / {
        proxy_pass http://tabtop:6080;
        proxy_http_version 1.1;
        proxy_set_header Host $http_host;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 1h;
    }
}
```

### `WEB_AUDIO`

With `1`, the container runs PipeWire and the browser gets a speaker button;
see [Audio](#audio). With `0`, PipeWire isn't started, the button doesn't
appear, and the `/audio/` paths return 404.

### `WEB_AUDIO_BITRATE`

How many kbit/s the sound uses per listener. It's sent at this rate all the
time, even during silence. A steady rate keeps the plain-HTTP player from
stalling.

- `32`–`48`: fine for speech and notification sounds. Music loses detail.
- `64` (default): a reasonable middle ground for most desktop use.
- `96`–`128`: for music and video soundtracks.

The encoder works in short frames and its lowest-delay mode, which cost some
quality at low rates compared with Opus at its usual settings.

Over plain HTTP, a lower rate also makes the sound take longer to start,
because the browser waits for a certain amount of data first. In Chromium it
took about 3 s at 96, 4 s at 64 and 5 s at 32. Over HTTPS the start is
immediate at any rate.

### `WEB_TTY`

With `1`, `/tty/` is a terminal; see [Terminal](#terminal). With `0`, it
returns 404.

### `CHROMIUM_NO_SANDBOX`

Chromium's sandbox needs privileges that a default container doesn't have,
so it's off by default. Set this to `0` only if the container runs with a
seccomp profile that allows Chromium's user namespaces.

## Downloads

Files that Chromium saves on the desktop go to `~/Downloads`. They can be
downloaded at `http://<host>:6080/downloads/`:

- **Login:** the page asks for the same credentials as the desktop (TOTP
  code, or password + code when `VNC_PASSWORD` is set), then keeps you
  logged in for 12 hours. The login also covers the [terminal](#terminal),
  and logging out of either logs out of both. Logging in to the desktop
  doesn't log you in to the files page.
- **Download only:** files can't be uploaded, changed or deleted from the web.
  Interrupted downloads can be resumed.
- **Attachments only:** files are always sent as downloads, never shown as
  pages, so an HTML file in `~/Downloads` can't run on the site.
- **Symlinks:** symlinks leading outside `~/Downloads` are hidden and can't
  be downloaded.

Restarting the container logs everyone out of the files page and the
terminal, and clears the failed-login counts.

## Terminal

`http://<host>:6080/tty/` is a shell as `VNC_USER` in the browser. It uses
the same login and session as the [files page](#downloads), and doesn't need
the desktop.

- **tmux:** the shell runs inside a tmux session called `web`. Closing the
  tab leaves it running, and the next tab picks it up where it was. Every tab
  shows the same session. Typing `exit` in the last window ends it, and the
  next tab starts a fresh one.
- **Mouse:** the wheel scrolls tmux's history. Dragging selects text in tmux;
  hold Shift to select with the browser instead.
- **Clipboard:** text copied in tmux, or sent with an OSC 52 escape
  sequence (as `~/.local/bin/ssh-yank.sh` does), goes to your browser's
  clipboard. Browsers only allow this over HTTPS or on `localhost`.
  Programs can't read your clipboard: requests for its contents get nothing
  back.
- **Font:** the terminal uses DejaVu Sans Mono if your computer has it,
  otherwise your browser's monospace font. A small Powerline symbols font is
  served with the page for the arrows in tmux's status line.
- **Desktop programs:** `DISPLAY` points at the desktop, so a graphical
  program started from the terminal opens there.
- **Limits:** up to 5 terminals at once per login. Logging out, or the
  12-hour session ending, closes open terminals within a few seconds. The
  tmux session keeps running.
- **Settings:** `/etc/tmux.conf` turns on the mouse and 24-bit colour. A
  `~/.tmux.conf` in the home volume is read after it. A new volume starts
  with the one in `skel/`, along with the theme files it loads from
  `~/.config/tmux/` and `~/.local/bin/ssh-yank.sh`. Edit or delete them in
  the volume; an existing volume never gets them.

## Audio

While connected to the desktop, noVNC's control bar has a speaker button.
Click it to start or stop the sound. The browser remembers the choice and
turns sound back on after a reconnect.

- **How it works:** applications play into a PipeWire sink with no sound
  card behind it. While someone is listening, the gateway records that sink,
  encodes it as Opus in 10 ms frames, and sends it to the browser. Nothing is
  recorded while nobody listens.
- **Delay:** over HTTPS, or on `localhost`, the browser decodes each frame
  itself and keeps only a small buffer: about 0.1 s behind on a local
  network, more over the internet. Browsers only allow that decoder on secure
  pages, so over plain HTTP the button falls back to a normal audio stream,
  which the browser buffers. That lags by about 2 seconds in Chromium.
- **Login:** sound only goes to a browser that's logged in to the desktop,
  and stops a few seconds after its desktop connection closes. There's no
  separate login. Opening noVNC sets a random cookie, and the desktop login
  made with it unlocks the sound, for requests from the same IP address.
- **Bandwidth:** 64 kbit/s per listener by default, even during silence;
  see [`WEB_AUDIO_BITRATE`](#web_audio_bitrate).
- **Output only:** the desktop has no microphone.

At startup, PipeWire logs a few errors and notices about realtime scheduling,
D-Bus, Bluetooth and cameras, which a container doesn't have. They're
harmless.

## Security notes

- **Plain HTTP:** credentials, the files-page cookie, files and the desktop
  session all travel unencrypted. If the site is reachable beyond a trusted
  network, put a reverse proxy with TLS in front, and set
  `WEB_TRUSTED_PROXIES`.
- **Login limit:** failed logins are limited per visitor IP, as described
  under `WEB_TRUSTED_PROXIES`. Xvnc's own blacklist is turned off, because
  every connection reaches Xvnc from the gateway.
- **Desktop access:** anyone logged in to the desktop has full access as
  `VNC_USER`, including the TOTP secret and (when configured) the plaintext
  password PIN in `~/.config/tabtop/`.
- **Terminal:** the terminal is a full shell as `VNC_USER`, the same access
  the desktop already gives. A shell over plain HTTP is exposed to anyone on
  the network path, which is another reason for TLS. Set `WEB_TTY=0` if you
  don't want it. Only pages from the site itself can open a terminal; the
  gateway refuses WebSocket requests from other sites.
- **Audio:** sound only goes to a browser with a logged-in desktop
  connection, and only to that connection's IP address, as described under
  [Audio](#audio). Like everything else, it's unencrypted
  without a TLS proxy.

## Build arguments

| Argument | Default | Description |
|---|---|---|
| `NOVNC_VERSION` | `1.7.0` | noVNC release, downloaded from GitHub. |
| `NOVNC_SHA256` | *(checksum of 1.7.0)* | SHA-256 of `https://github.com/novnc/noVNC/archive/refs/tags/v<version>.tar.gz`. A mismatch fails the build. |
| `XTERM_VERSION` | `6.0.0` | xterm.js release, downloaded from npm (`@xterm/xterm`). |
| `XTERM_SHA256` | *(checksum of 6.0.0)* | SHA-256 of `https://registry.npmjs.org/@xterm/xterm/-/xterm-<version>.tgz`. |
| `XTERM_FIT_VERSION` | `0.11.0` | xterm.js fit add-on (`@xterm/addon-fit`), which sizes the terminal to the window. |
| `XTERM_FIT_SHA256` | *(checksum of 0.11.0)* | SHA-256 of `https://registry.npmjs.org/@xterm/addon-fit/-/addon-fit-<version>.tgz`. |
| `XTERM_CLIPBOARD_VERSION` | `0.2.0` | xterm.js clipboard add-on (`@xterm/addon-clipboard`), which handles OSC 52. |
| `XTERM_CLIPBOARD_SHA256` | *(checksum of 0.2.0)* | SHA-256 of `https://registry.npmjs.org/@xterm/addon-clipboard/-/addon-clipboard-<version>.tgz`. |
| `POWERLINE_VERSION` | `2.8.4` | Powerline release that `PowerlineSymbols.otf` and its license are taken from. |
| `POWERLINE_FONT_SHA256` | *(checksum for 2.8.4)* | SHA-256 of `https://raw.githubusercontent.com/powerline/powerline/<version>/font/PowerlineSymbols.otf`. |
| `POWERLINE_LICENSE_SHA256` | *(checksum for 2.8.4)* | SHA-256 of the `LICENSE` file at the same version. |

The build adds one line to noVNC's `vnc.html`: a `<script>` tag that loads
the audio button. If a new noVNC release changes `vnc.html` so the line can't
be added, the build fails.

Change each version together with its checksum:

```sh
curl -sL https://github.com/novnc/noVNC/archive/refs/tags/v1.7.0.tar.gz | sha256sum
docker build --build-arg NOVNC_VERSION=1.7.0 --build-arg NOVNC_SHA256=<sum> -t tabtop .

curl -sL https://registry.npmjs.org/@xterm/xterm/-/xterm-6.0.0.tgz | sha256sum
```

## Development

The Go version for the gateway is pinned in `mise.toml`. Keep it in sync with
the `golang` image in the Dockerfile's tabtopd build stage.

The gateway uses libopus (audio) and liboath (logins) through cgo, so
building it needs a C compiler and their headers
(`apt install gcc libopus-dev liboath-dev` on Debian).

mise installs that Go version and runs the tasks defined in `mise.toml`:

```sh
mise install     # once, or after the Go version changes
mise run test
mise run vet
mise run build   # writes tabtopd/tabtopd
```

Without the headers, run the tests in the build image instead:

```sh
docker run --rm -v "$PWD/tabtopd":/src -w /src golang:1.27.3-trixie \
  sh -c 'apt-get update -qq && apt-get install -y -qq libopus-dev liboath-dev >/dev/null && go test ./...'
```

### Continuous integration

`.github/workflows/build.yml` runs on pushes to `main`, on `v*` tags and on
pull requests. It checks formatting, runs `mise run vet` and `mise run test`,
then builds the image. If all of that passes, it pushes the image to
`ghcr.io/<owner>/<repo>` with these tags:

| Event | Tags |
|---|---|
| Push to `main` | `main`, `latest`, `sha-<commit>` |
| Tag `v1.2.3` | `1.2.3`, `1.2`, `sha-<commit>` |
| Pull request | none: the image is built but not pushed |

The first push creates the package as private. To let others pull it without
logging in, make it public in the package's settings on GitHub.
