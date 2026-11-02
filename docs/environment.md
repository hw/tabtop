# Environment variables

The [table in the README](../README.md#environment-variables) lists every
variable with its default. This page describes each in detail.

## `VNC_USER`

The desktop and the terminal run as this Unix account, and it names the
entry in the authenticator app. Logins don't ask for it: one TOTP code (with
an optional password in front) logs in to the desktop, the terminal and the
files page together. The account's own Unix password stays locked.

It must be a plain user name: lowercase letters, digits, `_` and `-`,
starting with a letter or `_`, up to 32 characters. The image's own
accounts, such as `root` or `daemon`, are refused, since the desktop and
terminal would run as them; the container won't start, and says why.

It's `user` unless set. The examples set it to your own name on the host,
with `-e VNC_USER="$USER"`, and mount the home volume at `/home/$USER` to
match. A volume mounted elsewhere under `/home/` isn't used: the account
gets a new, empty home, and the log warns at every start, naming the
`VNC_USER` that would use it.

## `VNC_PASSWORD`

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

## `VNC_TOTP_SECRET`

The TOTP secret is `VNC_TOTP_SECRET`, if it's set and not empty. It isn't
saved to the home directory or printed to the log, since you already have
it. If it isn't valid Base32, a secret is derived from it and logged; see
[Secrets that aren't Base32](#secrets-that-arent-base32).

Without it, TabTop uses the [default secret](#default-totp-secret),
`JBSWY3DPEHPK3PXP`, which is public, and logs it with a warning at every
start. It isn't saved, so a container created later with
`VNC_TOTP_SECRET` uses that instead.

Spaces, `=` padding and lowercase are accepted, so you can paste a secret the
way an authenticator app or password manager shows it.

To change the secret, remove the container and create it again with the new
`VNC_TOTP_SECRET` (`docker restart` keeps the old value, since a container's
environment is fixed when it's created).

### Secrets that aren't Base32

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

### Default TOTP secret

When `VNC_TOTP_SECRET` is unset, TabTop uses `JBSWY3DPEHPK3PXP`. It's the
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

## `VNC_TOTP_DIGITS`

Codes change every 30 seconds. To allow for clock differences, the previous
and next code are accepted too. Each code works only once, across the
desktop, `/downloads/` and `/tty/` together and across restarts: after logging
in to one, wait for the next code to log in to another. Once a code is used,
earlier ones are refused too.

If you change the digit count, change it in your authenticator app's entry
too, or add the entry again. Some apps only support 6 digits, so use `6`
unless your app supports more.

## `VNC_ADDR`

With `VNC_ADDR` set, the gateway dials that RFB server for the desktop
page, through the same login and encrypted tunnel, and the container's own
desktop isn't started: no Xvnc, XFCE or sound, so `VNC_GEOMETRY`,
`VNC_DEPTH` and `WEB_AUDIO` don't apply. The terminal and the files page
still work in the container. The connection from the gateway to that
server isn't encrypted by TabTop, so keep it on a private network, a
socket, or an SSH tunnel. If the server asks for a VNC password, the
gateway gives it [`VNC_UPSTREAM_PASSWORD`](#vnc_upstream_password); without
one, or if the server turns it down, noVNC asks for the server's own after
the TabTop login. `/healthz` doesn't connect to a server reached over TCP,
which could get the gateway blacklisted (see
[Health checks](health-checks.md)); the doctor report shows how the
gateway's last login to it went.

```sh
docker run -p 6080:6080 -e VNC_TOTP_SECRET=... -e VNC_ADDR=10.0.0.5:5900 tabtop
```

See [Running tabtop-lite with the host's desktop](lite.md) for showing the
host's own desktop, with its sound and an SSH terminal.

## `VNC_UPSTREAM_PASSWORD`

The password the gateway gives the VNC server at `VNC_ADDR`, if it asks for
one, so it asks for nothing more after the TabTop login. The gateway
answers the server's VNC Authentication with it, which uses only its first
8 characters, and tells noVNC no password is needed. A server that needs
none, as the container's own Xvnc, is let in without it. With
[`VNC_X509=1`](#vnc_x509), it's given only inside TLS, and with
[`VNC_UPSTREAM_USERNAME`](#vnc_upstream_username) it's that account's
password instead. It's kept in `~/.config/tabtop/vnc-upstream-password`,
readable only by `VNC_USER`, and removed when the variable is unset; it
isn't put on any command line or in any program's environment.

It's the VNC server's own password, never TabTop's: `VNC_PASSWORD` is never
sent anywhere. Plain VNC Authentication is weak: anyone who can watch the
connection to the server can capture enough to crack the password offline.
Keep that connection on a Unix socket, the same machine or a private
network, or encrypt it with `VNC_X509=1`, and don't use the password for
anything else.

Without `VNC_X509`, noVNC asks for the server's password itself, as
without this variable, when:

- the server turns it down: the log says so, and the gateway doesn't try
  it again for 30 seconds, then twice as long after each further
  rejection, up to 10 minutes, so it isn't sent on every reconnect;
  meanwhile noVNC asks;
- the server offers only other kinds of login, such as VeNCrypt (TLS),
RealVNC's RA2 or Apple's, which the gateway leaves to noVNC.

## `VNC_X509`

`1` makes the gateway encrypt the connection to the VNC server at
`VNC_ADDR` with TLS, through VeNCrypt, checking the server's certificate
before it logs in: X509Vnc, with `VNC_UPSTREAM_PASSWORD` as the VNC
password, or X509Plain, with [`VNC_UPSTREAM_USERNAME`](#vnc_upstream_username)
as well. The certificate must be signed by a CA the system trusts, or by
one in [`VNC_CA_FILE`](#vnc_ca_file), and carry the host name in
`VNC_ADDR`, or [`VNC_SERVER_NAME`](#vnc_server_name), in its
subjectAltName. `0` (default) leaves the connection as the server has it.

Nothing falls back to an unencrypted login: if the server doesn't offer
VeNCrypt and the chosen kind, its certificate doesn't check out, or it
turns the password down, the desktop doesn't connect, and the log says
why. After a failed login, the gateway doesn't try the
server again for 30 seconds, then twice as long after each further
failure, up to 10 minutes: noVNC reconnects every 2 seconds, and each try
would be another failed login there, which could get the gateway's
address blacklisted or, with X509Plain, the account locked. A login that
works resets it, and the doctor report shows while it's waiting. The
[doctor report](health-checks.md) shows how the last login went: the kind
and the verified certificate, or why it failed. A page closed part way
through connecting isn't a failed login. The server must have X509Vnc or
X509Plain turned on, with its
certificate and key; see
[Encrypting the connection](lite.md#encrypting-the-connection-x509vnc-and-x509plain)
for TigerVNC.

`VNC_X509=1` needs `VNC_ADDR` and `VNC_UPSTREAM_PASSWORD`, and, when
`VNC_ADDR` is a Unix socket, `VNC_SERVER_NAME`: the container won't start
without them, and says which is missing.

## `VNC_UPSTREAM_USERNAME`

With `VNC_X509=1`, a username, which selects X509Plain instead of X509Vnc:
the gateway sends it and `VNC_UPSTREAM_PASSWORD` in full, inside TLS, with
no 8-character limit. TigerVNC checks them with PAM, so they're a Unix
account's on the VNC server's machine, one listed in its `PlainUsers`. Only
X509Plain is tried then, never X509Vnc. Without `VNC_X509`, the container
won't start with it set.

## `VNC_CA_FILE`

With `VNC_X509=1`, the path in the container of a file of PEM certificates
to trust, instead of the system's: the VNC server's own, for a self-signed
one, or a private CA's. Only those are trusted then, so no public CA's
certificate for the same name would do. Mount it read-only, readable by
`VNC_USER`; the container won't start if it isn't. A certificate from a
public CA needs none.

## `VNC_SERVER_NAME`

With `VNC_X509=1`, the name the VNC server's certificate must carry, when
it isn't the host in `VNC_ADDR`: as when `VNC_ADDR` is an IP address and
the certificate names a DNS name, or when it's a Unix socket, which has no
host name (then it's required).

## `VNC_GEOMETRY` and `VNC_RESIZE`

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

## `VNC_DEPTH`

The colour depth of the container's own desktop, in bits: `16`, `24`
(default) or `32`, the depths Xvnc runs with.
Like `VNC_GEOMETRY`, it doesn't apply to a server named by `VNC_ADDR`.

## `WEB_PORT`

The port inside the container. If you change it, publish the new port with
`-p`. The healthcheck follows the variable.

## `WEB_BASE_PATH`

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

The proxy passes the path through unchanged, without stripping the base. Full
nginx examples (site at `/` and under `/tabtop/`) are in
[Reverse proxy](reverse-proxy.md).

## `WEB_TRUSTED_PROXIES`

The gateway limits failed logins per visitor IP: 5 failures in 5 minutes
locks that IP out for the rest of the window (an IPv6 address's whole /64;
see [Security notes](encryption.md#security-notes)). Behind a reverse proxy, every visitor seems to come from the
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
visitor choose their own IP. `/doctor` (see [Health checks](health-checks.md))
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
- Leave responses unchanged. The gateway sends `Cache-Control: no-transform` with every page and script. Turn off any proxy or CDN
feature that rewrites scripts for this site, such as Cloudflare's Rocket
Loader: a changed script can break the tunnel.

nginx examples for a site at the root and under `WEB_BASE_PATH` are in
[Reverse proxy](reverse-proxy.md).

## Behind Cloudflare

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

## `WEB_TRUST_NPROXIES`

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

`/doctor` (see [Health checks](health-checks.md)) shows each hop, and whether
it was trusted by address or by count.

## `WEB_AUDIO`

With `1`, the container runs PipeWire and the browser gets a speaker button;
see [Audio](full-image.md#audio). With `0`, PipeWire isn't started, the button doesn't
appear, and the gateway refuses sound requests.

## `WEB_AUDIO_BITRATE`

How many kbit/s the sound uses per listener. It's sent at this rate all the
time, even during silence, so the traffic doesn't show when there's sound.

- `32`–`48`: fine for speech and notification sounds. Music loses detail.
- `64` (default): a reasonable middle ground for most desktop use.
- `96`–`128`: for music and video soundtracks.

The encoder works in short frames and its lowest-delay mode, which cost some
quality at low rates compared with Opus at its usual settings.

## `WEB_AUDIO_SERVER` and `WEB_AUDIO_SINK`

`WEB_AUDIO_SERVER` is the path of a PulseAudio socket mounted from the
host (PipeWire's `pipewire-pulse` provides one), whose sound is streamed
instead of the container's own; the container's PipeWire isn't started
then. `WEB_AUDIO_SINK` names the host's sink to record, by default
`@DEFAULT_SINK@`, whichever is the host's default when a browser starts
listening. See [Host audio](lite.md#host-audio).

## `WEB_SESSION_MAX` and `WEB_SESSION_IDLE`

How long a login lasts: at most `WEB_SESSION_MAX` (default `12h`), and no
longer than `WEB_SESSION_IDLE` (default `1h`) with nothing open: no
desktop, terminal or download. Both take hours and minutes, such as `12h`,
`90m` or `1h30m`; `WEB_SESSION_IDLE=0` turns the idle limit off. See
[Sessions](encryption.md#sessions).

## `WEB_TTY`

With `1`, `/tty/` is a terminal; see [Terminal](terminal.md). With `0`, it
returns 404.

## `WEB_TTY_COMMAND`

A shell command each terminal tab runs instead of tmux, run with the
user's shell (`bash -c`), such as `ssh -t me@host.docker.internal` to make
the terminal a login on another machine. Each tab runs its own copy, and
there's no tmux history to search. See
[An SSH terminal](lite.md#an-ssh-terminal).

## `WEB_DOCTOR_ENDPOINT`

With `1`, `/doctor` serves a troubleshooting report without a login; see
[Health checks](health-checks.md). With `0` (default), it returns 404.
`/healthz` answers either way.

## `CHROMIUM_NO_SANDBOX`

Chromium's internal process sandbox is disabled by default for compatibility
with restricted container runtimes. Keep the default on managed hosting. Set
this to `0` only in an environment where Chromium starts successfully with
its sandbox enabled.

## `TZ`

The time zone, as a name such as `Europe/Berlin` or `Asia/Singapore`
(default `UTC`). It sets the desktop's clock, the terminal's and every
other program's time in the container, and the times shown on the files
page. The container won't start with a name it doesn't know.
