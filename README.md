# TabTop

An XFCE desktop with Chromium that you use from a web browser. noVNC shows the
desktop, and you log in with a TOTP code from an authenticator app (optionally
preceded by a password). The desktop's sound plays in the browser. The same
site also offers a terminal, and a files page for the desktop user's
`~/Downloads`, where files and folders can be downloaded (folders as
zips), uploaded (with a button or by dropping them on the page), renamed
and deleted. Logins and everything after them
travel through an [encrypted tunnel](#encryption) between the page and the
gateway, so a proxy that decrypts HTTPS on the way can't read them.

The desktop has one panel at the top: show desktop, launchers for
Chromium (in incognito mode) and a terminal, the window list, the
workspace, the tray and a clock in the time zone set by `TZ`. A home
directory kept from an older image keeps its own panel, so it doesn't
get the terminal launcher; delete
`~/.config/xfce4/xfconf/xfce-perchannel-xml/xfce4-panel.xml` and restart
to get the new one.

Everything is served on one port by `tabtopd` (in `tabtopd/`):

| Path | What it serves |
|---|---|
| `/` | The noVNC client, which connects to the desktop |
| `/downloads/` | The files page for `~/Downloads`: download (folders as zips), upload, rename and delete files and folders |
| `/tty/` | A terminal (ghostty-web and tmux) |
| `/tunnel` | The [encrypted connection](#encryption) that carries the logins, the desktop, the terminal, files and sound for all of the above |
| `/healthz` | `ok` while the desktop is up and logins can work, for health checks |
| `/doctor` | A troubleshooting report, only with `WEB_DOCTOR_ENDPOINT=1` |

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
  -e VNC_USER=alice -e VNC_TOTP_SECRET="$(head -c 20 /dev/urandom | base32)" \
  ghcr.io/hw/tabtop:latest
docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' tabtop | grep VNC_TOTP_SECRET
```

Add that secret to an authenticator app as a time-based (TOTP) entry: 
SHA-1, 30 seconds and 6 digits, which are most apps' defaults. Without
`VNC_TOTP_SECRET`, the container uses a **well-known, public default secret** 
(see [Default TOTP secret](#default-totp-secret)), which is only safe on a 
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
VNC_USER=user
VNC_TOTP_SECRET=<a fixed random string>
```

Set `VNC_TOTP_SECRET`. The container starts without it, but then uses the
public [default secret](#default-totp-secret), with a warning, and anyone who
finds the site can log in. Keep the value unchanged across redeployments.

Any random string works, so the platform's own generator can create it. Use
at least 32 random characters.

- **Valid Base32** (only `A`–`Z` and `2`–`7`): it's the TOTP secret. Add it to
  the authenticator app as it is.
- **Anything else** (such as `0`, `1`, `8`, `9`, `-` or `_`, which
  general-purpose generators produce): a TOTP secret is derived from it, and
  the container prints that derived secret to the log at every start, with a
  QR code. Add the derived one to the authenticator app; see
  [Secrets that aren't Base32](#secrets-that-arent-base32).

The platform should route its HTTPS address to container port `6080` and
forward WebSocket connections. A volume mounted at `/home/<VNC_USER>` is
optional and only retains browser data, downloads and desktop preferences.

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `VNC_USER` | `user` | The desktop's Unix account, and the account name in the authenticator app. Logins don't ask for it. |
| `VNC_PASSWORD` | *(empty)* | Login password. When set, every login needs this password immediately followed by the current TOTP code. Empty: use `~/.config/tabtop/password` if present, otherwise TOTP-only. |
| `VNC_TOTP_SECRET` | `JBSWY3DPEHPK3PXP` (public; see [Default TOTP secret](#default-totp-secret)) | TOTP secret: Base32 is used as it is; any other string has a secret derived from it, printed at startup. Always set it for a site others can reach: the default is a well-known example secret, used with a warning in the log. When it's unset, a secret saved in the home directory takes precedence over the default. |
| `VNC_TOTP_DIGITS` | `6` | Code length: `6`, `7` or `8`. |
| `VNC_GEOMETRY` | `1600x900` | Desktop size before the first browser connects. |
| `VNC_DEPTH` | `24` | Colour depth in bits. |
| `VNC_RESIZE` | `remote` | Default way noVNC fits the desktop to the browser window: `remote`, `scale` or `off`. |
| `WEB_PORT` | `6080` | Port the gateway listens on inside the container. |
| `WEB_BASE_PATH` | `/` | URL path the site is served under, e.g. `/tabtop/` behind a reverse proxy. |
| `WEB_TRUSTED_PROXIES` | *(empty)* | Comma-separated IPs or CIDR ranges of reverse proxies whose `X-Forwarded-For` header is believed; `cloudflare` stands for [Cloudflare's](#behind-cloudflare) addresses. |
| `WEB_TRUST_NPROXIES` | `0` | How many proxies in front of the container to trust whatever their address, counting the one that connects, `0` to `10`; in addition to `WEB_TRUSTED_PROXIES`. See [`WEB_TRUST_NPROXIES`](#web_trust_nproxies). |
| `WEB_AUDIO` | `1` | `1` streams the desktop's sound to the browser. `0` turns it off. |
| `WEB_AUDIO_BITRATE` | `64` | Sound quality in kbit/s, `32` to `256`. |
| `WEB_SESSION_MAX` | `12h` | How long a login lasts at most, in hours and minutes, such as `12h` or `90m`. See [Sessions](#sessions). |
| `WEB_SESSION_IDLE` | `1h` | How long a login lasts with nothing open (no desktop, terminal or download), such as `1h` or `30m`. `0` for no limit. |
| `WEB_TTY` | `1` | `1` serves a terminal at `/tty/`. `0` turns it off. |
| `WEB_DOCTOR_ENDPOINT` | `0` | `1` serves a troubleshooting report at `/doctor`, without a login. See [Health checks](#health-checks). |
| `CHROMIUM_NO_SANDBOX` | `1` | `1` runs Chromium with `--no-sandbox`. `0` keeps the sandbox on. |
| `TZ` | `UTC` | Time zone, as a name such as `Europe/Berlin` or `Asia/Singapore`: for the desktop's clock, the terminal, everything else in the container, and the times on the files page. |

The container won't start if `VNC_TOTP_DIGITS`, `VNC_RESIZE`,
`WEB_BASE_PATH`, `WEB_TRUSTED_PROXIES`, `WEB_TRUST_NPROXIES`,
`WEB_SESSION_MAX`, `WEB_SESSION_IDLE`, `WEB_AUDIO`, `WEB_AUDIO_BITRATE`,
`WEB_TTY`, `WEB_DOCTOR_ENDPOINT`, `TZ` or `VNC_PASSWORD` has
an invalid value, or if a saved `~/.config/tabtop/totp-secret` isn't valid
Base32. The error is printed to the log. `WEB_E2E` no longer exists, since
the tunnel is always on: `WEB_E2E=1` is accepted, and any other value stops
the container.

### `VNC_USER`

The desktop and the terminal run as this Unix account, and it names the
entry in the authenticator app. Logins don't ask for it: one TOTP code (with
an optional password in front) logs in to the desktop, the terminal and the
files page together. The account's own Unix password stays locked.

### `VNC_PASSWORD`

When a password is configured, the desktop, files page and terminal all
require **password immediately followed by the current TOTP code** in the
password field — for example password `s3cret` and code `842391` →
`s3cret842391`. There is no separator. The last `VNC_TOTP_DIGITS` characters
are the code; everything before them is the password.

The password is chosen in this order:

1. `VNC_PASSWORD`, if the variable is set. It isn't saved to the home
   directory or printed to the log. An empty value means TOTP-only for this
   run.
2. The password saved at `~/.config/tabtop/password`.
3. No password: TOTP-only (backward compatible).

A password must not contain whitespace (pam_oath's users file is
whitespace-separated). Unlike the TOTP secret, a password is never
auto-generated: set the variable or create the file yourself. An
env-supplied password is not written to disk; to reuse one without re-passing
the environment variable, put it in `~/.config/tabtop/password` and preserve
the home directory.

A password passed in this variable can be read by anyone who can run
`docker inspect` on the container. The password is also stored in plaintext
as the pam_oath PIN in `~/.config/tabtop/users.oath` (required by
pam_oath), so anyone logged in to the desktop can read it.

### `VNC_TOTP_SECRET`

The TOTP secret is chosen in this order:

1. `VNC_TOTP_SECRET`, if it's set and not empty. It isn't saved to the home
   directory or printed to the log, since you already have it (unless it's
   the default secret below, which is always logged with a warning). If it
   isn't valid Base32, a secret is derived from it and logged; see
   [Secrets that aren't Base32](#secrets-that-arent-base32).
2. A secret saved at `~/.config/tabtop/totp-secret`. TabTop no longer
   creates this file, but one written by an earlier version, or by you, is
   still used.
3. The [default secret](#default-totp-secret), `JBSWY3DPEHPK3PXP`, with a
   warning. It isn't saved, so a container created later with
   `VNC_TOTP_SECRET` uses that instead.

Spaces, `=` padding and lowercase are accepted, so you can paste a secret the
way an authenticator app or password manager shows it.

To change the secret, remove the container and create it again with the new
`VNC_TOTP_SECRET` (`docker restart` keeps the old value, since a container's
environment is fixed when it's created). The variable takes precedence over a
saved `~/.config/tabtop/totp-secret`, so that file only matters while the
variable is unset; delete it if you no longer want it used.

#### Secrets that aren't Base32

For platforms whose random generators can't produce Base32,
`VNC_TOTP_SECRET` can be any string of any length, used exactly as given
(including spaces). Use at least 32 random characters. Only a value that
isn't valid Base32 is treated this way; valid Base32 is always the secret
itself.

The TOTP key is derived from the value: the first 20 bytes of its SHA-256
hash, the standard key size (liboath refuses keys longer than 32 bytes, so
the value itself can't be the key). An authenticator app needs that key in
Base32, which is not the value you set. Every start prints it to
`docker logs`, with an `otpauth://` URI and a QR code to scan:

```text
VNC_TOTP_SECRET isn't valid Base32, so a TOTP secret is derived from
it. Add this derived secret to an authenticator app (6 digits, 30s):
  Secret: Y3OGUNOOZBIBXHYTVTLALZVXUMGVQGBT
```

You can also work it out yourself with `oathtool`:
`oathtool --totp -v "$(printf %s "$VNC_TOTP_SECRET" | sha256sum | cut -c1-40)" | grep Base32`.

Because it's printed, anyone who can read the container's log can generate
codes, just as anyone who can read the variable can. Keep the log as private
as the platform's secret configuration.

#### Default TOTP secret

When no secret is set or saved, TabTop uses `JBSWY3DPEHPK3PXP`. It's the
Base32 encoding of `Hello!` followed by the bytes `DE AD BE EF`, and it's the
example secret in documentation and tutorials everywhere. That's why it's
the default: the container starts with no configuration at all, and the
secret is easy to find for a quick local try-out.

> **Warning:** because the default is public, **anyone who can reach the site
> can generate valid codes** (for example with
> `oathtool --totp -b JBSWY3DPEHPK3PXP`) and get the desktop, the terminal
> and the files in `~/Downloads`. Only rely on it on a machine nobody else
> can reach, and set your own `VNC_TOTP_SECRET` everywhere else. Setting
> `VNC_PASSWORD` as well means a login also needs that password, but the
> secret is still public.

Every start with the default prints a warning and the default's QR code to
`docker logs`.

A secret passed in this variable can be read by anyone who can run
`docker inspect` on the container. Anyone logged in to the desktop or the
terminal can also read it: the key is stored in `~/.config/tabtop/users.oath`
(for pam_oath), however it was provided.

### `VNC_TOTP_DIGITS`

Codes change every 30 seconds. To allow for clock differences, the previous
and next code are accepted too. Each code works only once, across the
desktop, `/downloads/` and `/tty/` together and across restarts: after logging
in to one, wait for the next code to log in to another. Once a code is used,
earlier ones are refused too.

If you change the digit count, change it in your authenticator app's entry
too, or add the entry again. Some apps only support 6 digits, so use `6`
unless your app supports more.

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
- **Same host, same origin:** browsers don't separate sites by path. Any page
  on the same host can script this one and read its login session, and
  noVNC's settings and the audio preference are shared with other copies of
  TabTop on that host. Only put it
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

The gateway limits failed logins per visitor IP: 5 failures in 5 minutes locks that IP out for the rest
of the window. Behind a reverse proxy, every visitor seems to come from the
proxy's IP, so one person's failed logins would lock everyone out. Set this
variable to the proxy's address, and the gateway uses `X-Forwarded-For` to
find each visitor's IP.

```sh
-e WEB_TRUSTED_PROXIES=10.0.0.5
-e WEB_TRUSTED_PROXIES=10.0.0.5,172.16.0.0/12
-e WEB_TRUSTED_PROXIES=cloudflare
```

- **Untrusted senders:** the header is ignored for everyone else, so visitors
  can't send a fake one.
- **Reading the header:** it's read from right to left. Entries added by
  trusted proxies are skipped, and the first other address is the visitor.
  Anything further left is ignored, since the visitor could have written it.
- **Docker networks:** a proxy container's IP can change when it's
  recreated, so give it a fixed IP and trust only that. Don't trust the
  whole network range: it includes the network's gateway, which is where
  visitors through a published port (`-p`) appear to come from. The proxy
  writes that address into `X-Forwarded-For`, so trusting it lets every
  visitor choose their own IP. `/doctor` (see [Health checks](#health-checks))
  shows which addresses were trusted for a request.

The proxy has to:

- Pass the `Host` header through unchanged. Otherwise the gateway refuses
  the tunnel's WebSocket as cross-origin.
- Forward WebSocket upgrades.
- Allow long idle times, or idle desktop sessions get cut off. The
  gateway pings every WebSocket every 30 seconds, which is enough for idle
  limits of a minute or more, such as nginx's default 60 s
  `proxy_read_timeout`.
- Send `X-Forwarded-Proto`, so `/doctor` can tell whether visitors arrive
  over HTTPS. Like `X-Forwarded-For`, it's only believed from a trusted
  proxy (by this variable or
  [`WEB_TRUST_NPROXIES`](#web_trust_nproxies)).
- Leave responses unchanged. The gateway sends `Cache-Control:
  no-transform` with every page and script. Turn off any proxy or CDN
  feature that rewrites scripts for this site, such as Cloudflare's Rocket
  Loader: a changed script can break the tunnel.

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

### Behind Cloudflare

Cloudflare's edge connects from many addresses, which change between
requests, so trusting the one you see in `/doctor` isn't enough.
`cloudflare` in `WEB_TRUSTED_PROXIES` stands for all of Cloudflare's
[published ranges](https://www.cloudflare.com/ips/) as of October 2026
(update the image if they change):

```sh
-e WEB_TRUSTED_PROXIES=cloudflare               # Cloudflare connects to the container
-e WEB_TRUSTED_PROXIES=cloudflare,172.18.0.5    # and another proxy of yours, too
-e WEB_TRUSTED_PROXIES=172.18.0.5               # a Cloudflare Tunnel's cloudflared
```

- **Straight from Cloudflare:** the edge adds the visitor's IP to
  `X-Forwarded-For`, which is believed only when the connection comes from
  one of Cloudflare's addresses. The entry Cloudflare added is taken as the
  visitor even when it's a Cloudflare address too (a request from someone's
  Cloudflare Worker), so entries the visitor wrote further left are never
  read. Anyone who reaches the container directly isn't trusted, so they
  can't pick their own IP either. That's safer than `WEB_TRUST_NPROXIES=1`,
  which would believe them.
- **Cloudflare Tunnel:** cloudflared connects to the container, not the
  edge, so trust cloudflared's address instead, and give it a fixed one on a
  Docker network. `/doctor` notices this case from Cloudflare's `Cf-Ray`
  header.
- **Idle connections:** Cloudflare closes WebSockets that are idle for
  about 100 seconds. The gateway pings every 30 seconds so that an idle
  desktop or terminal stays open.
- **Scripts:** turn off Rocket Loader and other features that rewrite
  scripts (see above).

### `WEB_TRUST_NPROXIES`

Some proxies don't have an address you can list, such as a hosting
platform's load balancer, whose IPs change. `WEB_TRUST_NPROXIES` trusts the
nearest proxies by how many there are instead: set it to the number of
proxies every visitor passes through on the way to the container, counting
the one that connects to it.

```sh
-e WEB_TRUST_NPROXIES=1    # a load balancer
-e WEB_TRUST_NPROXIES=2    # a CDN in front of a load balancer
```

- **How it reads the header:** with `1`, the connecting address is trusted
  and the visitor is the rightmost `X-Forwarded-For` entry. With `2`, that
  entry is trusted too (the CDN, as the load balancer saw it), and the
  visitor is the one before it. Entries further left are ignored, as always.
- **Together with `WEB_TRUSTED_PROXIES`:** a hop is trusted if it's within
  the count or its address is listed. Listed proxies beyond the count are
  still skipped, wherever they appear.
- **Exactly the right number:** one too many, and the gateway takes an
  address the visitor wrote themselves, so they can pick their own IP and
  dodge the login limit. One too few, and every visitor appears to come from
  your outermost proxy, so one person's failed logins lock everyone out.
- **Only behind the proxy:** if visitors can also reach the container
  directly, a count of 1 or more trusts them as a proxy too. Use it only when
  the proxy is the only way in.

`/doctor` (see [Health checks](#health-checks)) shows each hop, and whether
it was trusted by address or by count.

### `WEB_AUDIO`

With `1`, the container runs PipeWire and the browser gets a speaker button;
see [Audio](#audio). With `0`, PipeWire isn't started, the button doesn't
appear, and the gateway refuses sound requests.

### `WEB_AUDIO_BITRATE`

How many kbit/s the sound uses per listener. It's sent at this rate all the
time, even during silence, so the traffic doesn't show when there's sound.

- `32`–`48`: fine for speech and notification sounds. Music loses detail.
- `64` (default): a reasonable middle ground for most desktop use.
- `96`–`128`: for music and video soundtracks.

The encoder works in short frames and its lowest-delay mode, which cost some
quality at low rates compared with Opus at its usual settings.

### `WEB_TTY`

With `1`, `/tty/` is a terminal; see [Terminal](#terminal). With `0`, it
returns 404.

### `CHROMIUM_NO_SANDBOX`

Chromium's internal process sandbox is disabled by default for compatibility
with restricted container runtimes. Keep the default on managed hosting. Set
this to `0` only in an environment where Chromium starts successfully with
its sandbox enabled.

## Encryption

Everything private goes through an encrypted tunnel between the page's
JavaScript and the gateway: the login, the desktop (screen, keyboard and
clipboard), terminal sessions, file listings, downloads and uploads, and
sound. It's meant for the case where HTTPS alone isn't enough: a proxy that
decrypts HTTPS on the way, such as a corporate TLS-inspection proxy, a CDN
like Cloudflare, or a platform's load balancer that logs traffic. Such a
proxy would otherwise see TOTP codes and passwords, the screen and
keystrokes, terminal sessions, files and anything it could replay.

- **One login:** the desktop, terminal and files page share one login form,
  shown by whichever you open first, and one [session](#sessions). Logging
  out, or the session ending, closes the desktop, the terminal and any
  download at once.
- **The login never crosses the wire:** the password and TOTP code are used
  in [CPace](https://datatracker.ietf.org/doc/draft-irtf-cfrg-cpace/), a
  password-authenticated key exchange on X25519. Both sides prove they know
  the same code without sending it, so a recording of the login doesn't help
  anyone guess it later, even with TOTP-only logins. The gateway tries the
  codes for the previous, current and next 30 seconds. Codes are
  single-use, and failed logins count against the
  [login limit](#web_trusted_proxies).
- **Sessions:** a successful login gives the page a random session secret,
  kept in the browser's local storage. Every later connection combines a
  fresh X25519 exchange with that secret, so only that browser can open
  connections for the session. The fresh keys mean a secret that leaks later
  doesn't decrypt connections recorded earlier. There are no cookies, and
  nothing on the wire can be replayed.
- **Encryption:** every message is encrypted with ChaCha20-Poly1305. A
  message that's changed, dropped, reordered or replayed ends the
  connection. Browsers don't have ChaCha20-Poly1305 built in, so the page
  uses [@noble/ciphers](https://github.com/paulmillr/noble-ciphers), an
  audited JavaScript library, served from the image (`/opt/noble`). In
  Chromium it decrypts well over 100 MB/s, far more than the desktop needs.
  The handshakes' X25519, SHA-2 and HKDF come from the browser's own
  WebCrypto where it offers them, which is over HTTPS or on `localhost` in
  Chrome 133, Firefox 130, Safari 17 or later. Elsewhere the page loads
  [@noble/curves](https://github.com/paulmillr/noble-curves) and
  [@noble/hashes](https://github.com/paulmillr/noble-hashes) for them
  instead, which adds a few milliseconds to each login and connection.
  Browsers keep the noble files and the terminal's ghostty-web cached,
  under a path that changes when the image's copies do. The gateway sends
  them gzipped, since `no-transform` (below) stops proxies from
  compressing them.
- **Unchanged in transit:** every page and script carries `Cache-Control:
  no-transform`, which tells proxies and CDNs not to rewrite it. Turn off
  any feature that rewrites scripts for this site, such as Cloudflare's
  Rocket Loader.
- **Requirements:** any current browser with JavaScript. Over plain HTTP
  (other than to `localhost`) everything works except sound and copying
  from the terminal to your clipboard, and large downloads are held in
  memory before they're saved; see [Downloads](#downloads),
  [Terminal](#terminal) and [Audio](#audio).

This protects against a proxy that **reads** traffic. A proxy that
**changes** traffic but leaves the page's scripts alone gets one guess at the
code per login attempt, which the login limit counts. One that replaces the
scripts can do anything, such as send your keystrokes elsewhere: the
JavaScript comes through the same proxy. What a proxy can still see is which
pages and scripts you load, when you connect, and how much data flows,
including the timing of terminal keystrokes.

The desktop's own Chromium isn't affected: it browses from the container,
not through your browser.

### Sessions

How long a login lasts, and how to notice and end one you didn't make:

- **Limits:** a login lasts 12 hours at most (`WEB_SESSION_MAX`), and ends
  after an hour with nothing open (`WEB_SESSION_IDLE`). Anything still open
  then closes at once. The idle limit only ends sessions nobody is using:
  one that someone keeps a desktop or terminal open on lasts until the
  maximum. A login can have 64 connections open at once (a desktop tab
  uses two, a terminal or a download one); more are refused until some
  close. At most 16 connections from one address, and 256 in all, can be
  waiting to log in or prove their session; more are refused. A
  connection whose browser stops taking data for a minute is closed.
- **After each login,** the page shows the previous login's time and IP
  address, and any failed attempts since. It stays on screen until
  dismissed when there were failed attempts or the previous login came from
  another address.
- **The files page** lists the live sessions: when each logged in, the
  address it logged in from, any other address it has been used from
  (marked in red), and how many connections it has open, not counting the
  page's own request. A page closed or left closes its connections. Below
  are the last 20 logins, failed ones included. **Log out everywhere** ends
  every session, this one too, and closes everything they have open: an
  open desktop shows Disconnected, and asks for a login when it reconnects.
- **The gateway's log** (`docker logs`) records each login and each time a
  session is used from an address it didn't log in from.

A proxy that rewrites the page sits on your network path, so a session it
reuses most likely comes from your address and isn't marked: only
connections you didn't open give it away. All of this is drawn by the page,
which such a proxy could change too. Check from a network you trust, or
read `docker logs`. If you suspect a session was taken, log out everywhere
from a trusted network and change `VNC_PASSWORD`: a changed page could have
read the password, but never the TOTP secret. Sessions and the login
history are kept in memory only, so restarting the container logs everyone
out and starts the history empty.

## Downloads

Files that Chromium saves on the desktop go to `~/Downloads`. They can be
downloaded at `http://<host>:6080/downloads/`:

- **Login:** the page asks for the same credentials as the desktop (TOTP
  code, or password + code when `VNC_PASSWORD` is set), unless you're
  already logged in to the desktop or the [terminal](#terminal) in this
  browser. One login covers all three (see [Sessions](#sessions)), and
  logging out of any of them logs out of all.
- **In the page only:** the page lists, fetches, uploads, renames and
  deletes files through the [encrypted tunnel](#encryption), so it needs
  JavaScript, and files have no plain URLs to give to `curl` or `wget`.
- **Finding your way:** the heading shows the folder's path, each folder
  in it a link back up. Click **Name**, **Size** or **Modified** to sort
  by it, and again to turn the order round; folders stay first, and the
  order is remembered in this browser. Times are shown as "Today 9:34",
  "Yesterday", a weekday or a date, in your browser's language and the
  container's time zone (`TZ`, UTC by default); hovering over one, or over
  a size, shows it exactly. Each row's
  **⋯** menu downloads, renames or deletes it.
- **Transfers:** downloads, uploads, zips and other changes show in a
  panel in the bottom corner, each with a progress bar while it goes and
  a **Cancel** button where it can be stopped, and a bar for how many are
  done. **Clear** removes the finished ones; **▾** folds the panel away.
- **Saving:** over HTTPS or on `localhost`, a file streams into an ordinary
  browser download as it's decrypted, through a service worker the page
  registers, so it needs no more memory than a few chunks: the gateway only
  sends a few MiB ahead of what the download has taken. The browser writes
  it to a temporary file (`.crdownload`, `.part`) and renames it once it's
  complete; one that's cut off is marked failed, and no partial file is
  kept under the real name. Keep the files page open until it's done, since
  that page does the decrypting. Pausing a download for more than 30 s
  fails it. Over plain HTTP, browsers don't allow service workers, so the
  whole file is fetched first and then saved: Chrome keeps it in temporary
  files as it arrives, but other browsers may need as much free memory as
  the file is big.
- **Zips:** **Download as .zip** in a folder's menu downloads it with
  everything in it as one zip. Tick several files and folders with the
  checkboxes and **Download as .zip** downloads them together, named after
  the folder they're in. The gateway makes the zip as it sends it, so it
  needs no room on disk, but its size isn't known in advance: the download
  shows how much has arrived, not a percentage. Files already compressed
  (images, video, audio, archives) are stored as they are, and the rest
  compressed quickly. Symlinks to files are followed, those to folders
  aren't, and uploads still in progress are left out; the page says if
  anything couldn't be read. A zip that's cut off is marked failed, like a
  file. At most a few thousand items can be ticked for one zip (the request
  is limited to 1 MiB); a folder's own zip has no such limit.
- **Uploads:** pick files with **Upload files…**, or drop them on the
  page, to upload them into the folder it shows. An upload never replaces
  a file: one whose name is taken is saved as `name (1).ext`,
  `name (2).ext` and so on, with `name` cut short if the name would get
  too long. Each file is written to a hidden temporary file
  (`.tabtop-upload-….part`) first, and only appears once it's complete
  and saved to disk. If the disk reports an error saving its folder
  too, the page says so next to the file; on a file system that can't
  save a folder on request at all, the file's own save is as far as it
  goes, without a warning. One that's cut off is deleted, and any left by a
  crash or a forced stop are deleted when the container next starts (it
  spends at most 10 seconds looking, before serving anything), so don't
  share `~/Downloads` between two running containers. Each upload has a
  **Cancel** button while it's waiting or going; a cancelled one is
  deleted. Interrupted downloads and uploads start again from the
  beginning.
- **Folder uploads:** drop a folder on the page, or pick one with
  **Upload a folder…** (in browsers that have it), to upload it with
  everything in it. It never merges into a folder already there: one whose
  name is taken is uploaded as `name (1)` and so on. Its files are uploaded
  one at a time like any other, and the page shows how many made it and
  lists any that failed. Empty folders inside a picked folder are left out,
  since browsers don't pass them on; dropped ones are kept. Cancelling a
  folder's upload stops it at once: the file being uploaded is deleted,
  and those uploaded before it are kept.
- **New folders and renaming:** **New folder…** makes a folder in the one
  shown (as `name (1)` if the name is taken), and **Rename…** in a row's
  menu renames it; for a file, only the part before the extension starts
  selected. A rename never replaces anything: if the new name is taken, it
  fails and says so. Renaming a symlink renames the link.
- **Deleting:** **Delete…** in a row's menu deletes it, after asking, and
  **Delete** in the bar above the list deletes everything ticked, after
  asking once. Deleting a folder deletes everything in it.
  Deleting is permanent: there's no trash. Deleting a symlink removes the
  link, not the file or folder it leads to, and a folder is deleted
  without following any symlinks in it. Files can't be changed from the
  web, only replaced by deleting and uploading again.
- **Attachments only:** files are always sent as downloads, never shown as
  pages, so an HTML file in `~/Downloads` can't run on the site.
- **Symlinks:** symlinks leading outside `~/Downloads` are hidden and can't
  be downloaded, zipped, uploaded into, renamed or deleted.
- **Big folders:** a folder lists at most 10,000 entries. With more, the
  page says so and shows 10,000 of them, in no particular order.

Restarting the container logs everyone out, and clears the failed-login
counts.

## Terminal

`http://<host>:6080/tty/` is a shell as `VNC_USER` in the browser. It uses
the same login and session as the desktop and the [files page](#downloads),
and doesn't need the desktop to be open. The page draws it with
[ghostty-web](https://github.com/coder/ghostty-web), Ghostty's terminal
emulator compiled to WebAssembly.

- **tmux:** the shell runs inside a tmux session called `web`. Closing the
  tab leaves it running, and the next tab picks it up where it was. Every tab
  shows the same session. Typing `exit` in the last window ends it, and the
  next tab starts a fresh one.
- **Mouse:** the wheel scrolls tmux's history. Dragging selects text in tmux;
  hold Shift to select with the page instead. ghostty-web doesn't send the
  mouse to programs itself, so the page does (clicks, drags and the wheel,
  in the encodings tmux asks for).
- **Clipboard:** text copied in tmux, or sent with an OSC 52 escape
  sequence (as `~/.local/bin/ssh-yank.sh` does), goes to your browser's
  clipboard, up to 1 MB at a time. ghostty-web doesn't handle OSC 52, so the
  page picks it out of the output itself. Browsers only allow this over HTTPS
  or on `localhost`.
  Programs can't read your clipboard: requests for its contents get nothing
  back.
- **Font:** the terminal uses DejaVu Sans Mono if your computer has it,
  otherwise your browser's monospace font. A small Powerline symbols font is
  served with the page for the arrows in tmux's status line.
- **Desktop programs:** `DISPLAY` points at the desktop, so a graphical
  program started from the terminal opens there.
- **Limits:** up to 5 terminals at once per login. A paste is at most
  1 MiB. Logging out, or the
  [session](#sessions) ending, closes open terminals at once. The tmux
  session keeps running.
- **Settings:** `/etc/tmux.conf` turns on the mouse and 24-bit colour. A
  `~/.tmux.conf` in the home directory is read after it. A new home starts
  with the one in `skel/`, along with the theme files it loads from
  `~/.config/tmux/` and `~/.local/bin/ssh-yank.sh`. Edit or delete them in
  the home directory; an existing home never gets them.

## Audio

While connected to the desktop, noVNC's control bar has a speaker button.
Click it to start or stop the sound. The browser remembers the choice and
turns sound back on after a reconnect.

- **How it works:** applications play into a PipeWire sink with no sound
  card behind it. While someone is listening, the gateway records that sink,
  encodes it as Opus in 10 ms frames, and sends it to the browser. Nothing is
  recorded while nobody listens.
- **Delay:** the browser decodes each frame itself (with WebCodecs) and
  keeps only a small buffer: about 0.1 s behind on a local network, more
  over the internet.
- **HTTPS only:** browsers only offer WebCodecs over HTTPS or on
  `localhost`, so over plain HTTP the button says "Audio needs HTTPS"
  instead.
- **Login:** sound comes through the [encrypted tunnel](#encryption), only
  for a session that has the desktop open from the same IP address, and
  stops a few seconds after the desktop connection closes. There's no
  separate login.
- **Bandwidth:** 64 kbit/s per listener by default, even during silence;
  see [`WEB_AUDIO_BITRATE`](#web_audio_bitrate).
- **Output only:** the desktop has no microphone.

At startup, PipeWire logs a few errors and notices about realtime scheduling,
D-Bus, Bluetooth and cameras, which a container doesn't have. They're
harmless.

## Security notes

- **HTTPS:** put the site behind HTTPS whenever it's reachable beyond a
  trusted network, and set `WEB_TRUSTED_PROXIES`. The
  [encrypted tunnel](#encryption) keeps logins and content from anyone who
  only reads traffic, including a proxy that decrypts HTTPS, but whoever
  can change traffic can replace the page's scripts and take everything.
  HTTPS stops that for everyone on the way except the proxies that decrypt
  it.
- **Login limit:** failed logins are limited per visitor IP, as described
  under `WEB_TRUSTED_PROXIES`. The gateway also checks at most 4 logins at
  once, from all IPs together, and turns away any more with "The server is
  busy". A flood of logins from many IPs can therefore keep refusing logins for as long as
  it lasts, but locks nothing afterwards. Xvnc's own blacklist is turned off, because
  every connection reaches Xvnc from the gateway.
- **Desktop access:** anyone logged in to the desktop has full access as
  `VNC_USER`, including the TOTP secret and (when configured) the plaintext
  password PIN in `~/.config/tabtop/`.
- **Terminal:** the terminal is a full shell as `VNC_USER`, the same access
  the desktop already gives. Set `WEB_TTY=0` if you don't want it. Only
  pages from the site itself can open the tunnel; the gateway refuses
  WebSocket requests from other sites.
- **Files:** anyone logged in can delete files and folders in
  `~/Downloads`, with no way to undo it.

## Health checks

`/healthz` (under `WEB_BASE_PATH`, like every path) answers `200 ok` while
Xvnc is listening and the login file can be read, and `503` otherwise. It
needs no login and reveals nothing else, so load balancers and uptime
monitors can call it. The image's Docker `HEALTHCHECK` uses it, so
`docker ps` shows `unhealthy` when it fails, and the reason is in the log.
It doesn't connect to Xvnc, which would log every check.

`/doctor` is for troubleshooting and is off unless
`WEB_DOCTOR_ENDPOINT=1`. It returns a JSON report:

- **checks:** each part's state: Xvnc (connecting and reading its
  greeting), the login file, noVNC, `~/Downloads`, audio (the PipeWire sink),
  the terminal (tmux and ghostty-web) and the tunnel (whether the
  JavaScript libraries it needs are in place).
- **clock:** the server's time. Codes are only accepted within 30 seconds
  of it, so a wrong clock explains logins that always fail.
- **proxy:** how your request arrived, for setting up a reverse proxy. It
  shows the address the connection came from and whether it's trusted, the
  `Host`, `X-Forwarded-For` and `X-Forwarded-Proto` headers as received
  (even from an untrusted address, where they're otherwise ignored), the
  `WEB_TRUSTED_PROXIES` list and `WEB_TRUST_NPROXIES` count, each address
  checked to find the client IP (and whether it was trusted by address or by
  count), and whether the request came over HTTPS. A **diagnosis** explains
  the result in words and what to change, such as the `WEB_TRUSTED_PROXIES`
  value that would trust the connection's address.
- **state:** counts of web sessions, open terminals, locked-out IPs and
  audio listeners.

It needs no login, so it works when logins don't. It leaves out the
username, password and TOTP key, but it does show internal paths, addresses
and activity, so turn it off again when you're done.

## Build arguments

| Argument | Default | Description |
|---|---|---|
| `NOVNC_VERSION` | `1.7.0` | noVNC release, downloaded from GitHub. |
| `NOVNC_SHA256` | *(checksum of 1.7.0)* | SHA-256 of `https://github.com/novnc/noVNC/archive/refs/tags/v<version>.tar.gz`. A mismatch fails the build. |
| `GHOSTTY_WEB_VERSION` | `0.4.0` | ghostty-web release for the terminal, downloaded from npm (`ghostty-web`). |
| `GHOSTTY_WEB_SHA256` | *(checksum of 0.4.0)* | SHA-256 of `https://registry.npmjs.org/ghostty-web/-/ghostty-web-<version>.tgz`. |
| `POWERLINE_VERSION` | `2.8.4` | Powerline release that `PowerlineSymbols.otf` and its license are taken from. |
| `POWERLINE_FONT_SHA256` | *(checksum for 2.8.4)* | SHA-256 of `https://raw.githubusercontent.com/powerline/powerline/<version>/font/PowerlineSymbols.otf`. |
| `POWERLINE_LICENSE_SHA256` | *(checksum for 2.8.4)* | SHA-256 of the `LICENSE` file at the same version. |
| `NOBLE_CIPHERS_VERSION` | `2.4.0` | `@noble/ciphers` release from npm, whose ChaCha20-Poly1305 the page uses for the [tunnel](#encryption). |
| `NOBLE_CIPHERS_SHA256` | *(checksum of 2.4.0)* | SHA-256 of `https://registry.npmjs.org/@noble/ciphers/-/ciphers-<version>.tgz`. |
| `NOBLE_CURVES_VERSION` | `2.4.0` | `@noble/curves` release from npm, whose X25519 the page uses for the [tunnel](#encryption). |
| `NOBLE_CURVES_SHA256` | *(checksum of 2.4.0)* | SHA-256 of `https://registry.npmjs.org/@noble/curves/-/curves-<version>.tgz`. |
| `NOBLE_HASHES_VERSION` | `2.4.0` | `@noble/hashes` release from npm, whose SHA-2 and HKDF the page uses for the [tunnel](#encryption). Must be the version `@noble/curves` depends on. |
| `NOBLE_HASHES_SHA256` | *(checksum of 2.4.0)* | SHA-256 of `https://registry.npmjs.org/@noble/hashes/-/hashes-<version>.tgz`. |

The build adds two `<script>` tags to noVNC's `vnc.html`, for the audio
button and the encrypted tunnel, and changes one line of `app/ui.js` so the
tunnel can supply noVNC's connection. If a new noVNC release changes either
file so the edits can't be made, the build fails.

Change each version together with its checksum:

```sh
curl -sL https://github.com/novnc/noVNC/archive/refs/tags/v1.7.0.tar.gz | sha256sum
docker build --build-arg NOVNC_VERSION=1.7.0 --build-arg NOVNC_SHA256=<sum> -t tabtop .

curl -sL https://registry.npmjs.org/ghostty-web/-/ghostty-web-0.4.0.tgz | sha256sum
```

## Development

The Go version for the gateway is pinned in `mise.toml`. Keep it in sync with
the `golang` image in the Dockerfile's tabtopd build stage.

The gateway uses libopus (audio) and liboath (logins) through cgo, so
building it needs a C compiler and their headers
(`apt install gcc libopus-dev liboath-dev` on Debian).

mise installs that Go version, and the Node version the browser check
uses, and runs the tasks defined in `mise.toml`:

```sh
mise install     # once, or after the Go or Node version changes
mise run test
mise run vet
mise run build   # writes tabtopd/tabtopd
```

`TestTunnelInteropWithJS` runs the page's `tunnel.js` in Node against the
gateway, to check that the two sides of the encrypted tunnel agree. It needs
Node 22 or later and `TABTOP_NOBLE_DIR` set to a copy of the image's
`/opt/noble`, which the Dockerfile's `noble` stage builds; without them it's
skipped, as it is in CI:

```sh
docker build --target noble -t tabtop-noble .
mkdir -p /tmp/noble && docker run --rm tabtop-noble tar -c -C /noble . | tar -x -C /tmp/noble
TABTOP_NOBLE_DIR=/tmp/noble mise run test
```

`test/browser-check.sh <image>` checks an image end to end, the way a
person uses it: it starts a container and headless Chrome, logs in, opens
the desktop and its sound, lists, downloads, uploads and deletes files,
uploads a folder both picked and dropped and deletes one, downloads zips,
makes a folder, renames a file, deletes several at once, cancels an
upload, runs a command in the terminal, and logs out, then checks from
inside the container what the pages left in `~/Downloads`, and what the
zips hold. It prints `ok` or `not ok` for each step, and the container's
log if one fails. It needs Docker, Node, Python 3 and Chrome or Chromium
(set `CHROME` if it isn't found). `mise run browser-check` builds the image
and runs it.

### Continuous integration

`.github/workflows/build.yml` runs on pushes to `main`, on `v*` tags and on
pull requests. It checks formatting, runs `mise run vet` and `mise run test`,
then builds the image and runs `test/browser-check.sh` on it. If all of
that passes, it pushes the image to
`ghcr.io/<owner>/<repo>` with these tags:

| Event | Tags |
|---|---|
| Push to `main` | `main`, `latest`, `sha-<commit>` |
| Tag `v1.2.3` | `1.2.3`, `1.2`, `sha-<commit>` |
| Pull request | none: the image is built and checked but not pushed |

The first push creates the package as private. To let others pull it without
logging in, make it public in the package's settings on GitHub.
