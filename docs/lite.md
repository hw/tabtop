# Running tabtop-lite with the host's desktop

`tabtop-lite` is TabTop without a desktop of its own. It shows a VNC server
elsewhere, named by `VNC_ADDR`, through the same login, encrypted tunnel
and pages as the full image. Pointed at the host, it gives you a desktop on
the host in a browser, with the host's apps, files and sound, and a
terminal that's an SSH login on the host.

## On the host

`scripts/setup-lite-host.sh` does all of this, and prints the `docker run`
command to use; run it as the desktop's user (`--help` lists its options).
Once the container is running, `scripts/setup-lite-host.sh --add-ssh-key
tabtop` gives it an SSH key and lets it log in. The steps it takes follow.

These steps are for Debian (12 or 13); other distributions have the same
packages under similar names. Run them as the user whose desktop you want.
That user's uid (`id -u`) must be 1000, as the container's user's is,
since the container opens sockets that only that user can.

### A VNC server: TigerVNC

TigerVNC's standalone server (`Xvnc`) is an X server itself, so the host
needn't run one: it runs a desktop session of its own, as you, separate
from any screen. Install it and a desktop to run in it:

```sh
sudo apt install tigervnc-standalone-server tigervnc-tools xfce4 dbus-x11
```

Set its password, which the container gets as `VNC_UPSTREAM_PASSWORD`, so
the gateway logs in for you (see
[`VNC_UPSTREAM_PASSWORD`](environment.md#vnc_upstream_password)). Make it
its own password, not TabTop's login password, and answer `n` to a
view-only password. It's saved in `~/.config/tigervnc/passwd`
(`~/.vnc/passwd` on Debian 12):

```sh
tigervncpasswd
```

It listens on a Unix socket rather than a TCP port, in a folder of its
own that the container mounts. Make the folder:

```sh
mkdir -p -m 700 ~/.local/state/tabtop
```

Configure it in `~/.config/tigervnc/config.pl` (`~/.vnc/tigervnc.conf` on
Debian 12), in Perl syntax; the options are described in
`/etc/tigervnc/vncserver-config-defaults`:

```perl
$session = "xfce";          # a file in /usr/share/xsessions, without .desktop
$SecurityTypes = "VncAuth"; # the password, which the gateway can answer
$geometry = "1920x1080";    # until a browser resizes it
$rfbunixpath = "$ENV{HOME}/.local/state/tabtop/vnc.sock";
$rfbport = -1;              # no TCP port at all
```

Give your user display `:1`, and start it now and at every boot:

```sh
echo ":1=$USER" | sudo tee -a /etc/tigervnc/vncserver.users
sudo systemctl enable --now tigervncserver@:1
```

It listens on `~/.local/state/tabtop/vnc.sock`, which only your user can
open, and on no TCP port. It resizes to the browser window with
`VNC_RESIZE=remote`, as the full image does.
The session also opens a small "VNC config" window: that's TigerVNC's
settings helper, not TabTop's.

### Sound

Debian desktops run PipeWire with `pipewire-pulse`, which provides the
socket TabTop records from. On a host without them, as one with only
TigerVNC's desktop:

```sh
sudo apt install pipewire-pulse wireplumber
sudo loginctl enable-linger $USER
ls -l /run/user/$(id -u)/pulse/native    # the socket
```

`enable-linger` keeps your user's services, and with them the sound
server, running when you aren't logged in, as with TigerVNC's desktop.

### SSH

```sh
sudo apt install openssh-server
```

It's enabled once installed, and listens on every address, so the
container can reach it as `host.docker.internal`. The container's key is
added below, once it's running.

### Docker

```sh
sudo apt install docker.io
```

## Running it

```sh
docker run -d --name tabtop -p 6080:6080 --restart unless-stopped \
  --add-host host.docker.internal:host-gateway \
  -e VNC_TOTP_SECRET="$(head -c 20 /dev/urandom | base32)" \
  -e VNC_USER="$USER" \
  -e VNC_PASSWORD=<a login password> \
  -e VNC_UPSTREAM_PASSWORD=<the VNC server's password> \
  -v ~/.local/state/tabtop:/run/host-vnc \
  -e VNC_ADDR=unix:/run/host-vnc/vnc.sock \
  -v /run/user/$(id -u)/pulse:/run/host-pulse \
  -e WEB_AUDIO_SERVER=/run/host-pulse/native \
  -e WEB_TTY_COMMAND="ssh -t $USER@host.docker.internal" \
  -v tabtop-home:/home/$USER \
  ghcr.io/hw/tabtop-lite:latest
docker logs tabtop    # the TOTP secret's QR code, for an authenticator app
```

Log in with the login password followed by the code, at port 6080. `-p 6080:6080`
opens it on every address of the host: put it behind HTTPS, or use
`-p 127.0.0.1:6080:6080` behind a reverse proxy on the host, before others
can reach it. Each part is optional, and described below.

Then give the terminal an SSH key, and let the host accept it:

```sh
docker exec -u $USER tabtop sh -c 'mkdir -p -m 700 ~/.ssh && ssh-keygen -t ed25519 -N "" -f ~/.ssh/id_ed25519'
mkdir -p -m 700 ~/.ssh
docker exec -u $USER tabtop cat /home/$USER/.ssh/id_ed25519.pub >> ~/.ssh/authorized_keys
```

The first terminal tab asks whether to trust the host's key.

## The connection to the VNC server

The gateway reaches TigerVNC through its Unix socket, mounted into the
container, so the connection never touches a network, and only your user
(and root) can open it. `VNC_ADDR` names the socket's path inside the
container. Mount its folder rather than the socket itself: TigerVNC makes
a new socket each time it starts, which a mount of the old one wouldn't
see.

`127.0.0.1` wouldn't do as `VNC_ADDR`: inside the container, it's the
container itself, not the host. A server reached over TCP instead, as
`host.docker.internal:5901`, has to listen where the container can reach
it, such as the Docker bridge's address, and the connection isn't
encrypted by TabTop: keep it behind a firewall, with a password, or
encrypt it with TLS (see
[Encrypting the connection](#encrypting-the-connection-x509vnc-and-x509plain)).

With its password as `VNC_UPSTREAM_PASSWORD`, the gateway logs in to the
server for you, so there's no second prompt; see
[`VNC_UPSTREAM_PASSWORD`](environment.md#vnc_upstream_password). TabTop's
own login password is never sent to it. With
another password, or a server whose logins use other methods (as wayvnc's
do, on Wayland), noVNC asks for it after the TabTop login.

`VNC_GEOMETRY` and `VNC_DEPTH` don't apply: the server sets the screen's
size and depth. `VNC_RESIZE=remote` resizes it to the browser window only
where the server allows that, as TigerVNC does; otherwise choose `scale`.

## Encrypting the connection: X509Vnc and X509Plain

The Unix socket above never crosses a network, so it needs no encryption.
A VNC server reached over TCP, especially one on another machine, should
have its connection encrypted: plain VNC sends the screen, the keys typed
and a password response anyone watching can crack offline. With
`VNC_X509=1`, the gateway insists on TigerVNC's VeNCrypt with TLS, checks
the server's certificate, and only then logs in, in one of two ways:

- **X509Vnc** (`VNC_UPSTREAM_PASSWORD` alone): the VNC password, as above,
  inside TLS. VNC still uses only its first 8 characters.
- **X509Plain** (`VNC_UPSTREAM_USERNAME` and `VNC_UPSTREAM_PASSWORD`): a
  username and password, checked by the server's PAM, so they're a Unix
  account's on that machine, in full. No VNC password is needed.

Nothing falls back to an unencrypted login: if the server doesn't offer
the chosen kind, its certificate doesn't check out, or it turns the
password down, the desktop doesn't connect, and the gateway's log
(`docker logs tabtop`) says why. noVNC tries again every 2 seconds until
the settings are fixed.

### On the VNC server's machine

TigerVNC needs a certificate and its key. Make a self-signed one, naming
the server as the container will (here `vnc.example.lan`; any name will
do, as long as both sides use it). The name must be in the certificate's
subjectAltName, which the gateway requires, not only its common name, so
don't rely on the certificate TigerVNC would generate itself:

```sh
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 3650 \
  -subj "/CN=vnc.example.lan" -addext "subjectAltName=DNS:vnc.example.lan" \
  -keyout ~/.config/tigervnc/x509-key.pem -out ~/.config/tigervnc/x509-cert.pem
chmod 600 ~/.config/tigervnc/x509-key.pem
```

To connect by IP address instead, name it as one:
`-addext "subjectAltName=IP:192.0.2.10"`.

Then, in `~/.config/tigervnc/config.pl` (see
[A VNC server: TigerVNC](#a-vnc-server-tigervnc) above), replace the
`$SecurityTypes`, `$rfbunixpath` and `$rfbport` lines with:

```perl
$SecurityTypes = "X509Vnc";   # or "X509Plain"
$X509Cert = "$ENV{HOME}/.config/tigervnc/x509-cert.pem";
$X509Key = "$ENV{HOME}/.config/tigervnc/x509-key.pem";
$localhost = "no";            # listen beyond 127.0.0.1, on port 5901 for :1
```

and restart it: `sudo systemctl restart tigervncserver@:1`. For X509Vnc,
the password is the one set with `tigervncpasswd`. For X509Plain, it's
your Unix account's, and only the users in TigerVNC's `$PlainUsers` may
log in, by default the one the server runs as; it checks them with PAM
(`/etc/pam.d/tigervnc`).

Its port is now reachable from other machines, so let only the
container's host through a firewall: the login still needs the password,
but TabTop's login is meant to be the only door.

### In the container

Copy the certificate (`x509-cert.pem`, never the key) to the machine
running the container, and give it to the gateway as the certificate it
trusts, with the name it carries:

```sh
docker run -d --name tabtop -p 6080:6080 --restart unless-stopped \
  -e VNC_TOTP_SECRET="$(head -c 20 /dev/urandom | base32)" \
  -e VNC_USER="$USER" \
  -e VNC_PASSWORD=<a login password> \
  -e VNC_ADDR=vnc.example.lan:5901 \
  -e VNC_X509=1 \
  -v ~/x509-cert.pem:/run/vnc-ca.pem:ro \
  -e VNC_CA_FILE=/run/vnc-ca.pem \
  -e VNC_UPSTREAM_PASSWORD=<the VNC password> \
  -v tabtop-home:/home/$USER \
  ghcr.io/hw/tabtop-lite:latest
```

For X509Plain, add `-e VNC_UPSTREAM_USERNAME=<the account>` and give that
account's password as `VNC_UPSTREAM_PASSWORD`.

- **`VNC_SERVER_NAME`:** the name the certificate must carry. It defaults
  to the host in `VNC_ADDR`; set it when they differ, as when `VNC_ADDR`
  is an IP address and the certificate names a DNS name, or for a Unix
  socket, which has no host name.
- **`VNC_CA_FILE`:** certificates to trust, beside the system's. A
  self-signed certificate is its own; a certificate from a public CA needs
  none.
- **`VNC_UPSTREAM_PASSWORD`** is required with `VNC_X509=1`. Like the
  others, it's kept in a file only the container's user can read, never
  on a command line; see
  [`VNC_UPSTREAM_PASSWORD`](environment.md#vnc_upstream_password).

## Host audio

To hear the host's sound, mount the folder of the host user's PulseAudio
socket (PipeWire's `pipewire-pulse` provides one too) and set
`WEB_AUDIO_SERVER` to the socket's path in the container:

```sh
  -v /run/user/$(id -u)/pulse:/run/host-pulse \
  -e WEB_AUDIO_SERVER=/run/host-pulse/native \
```

The gateway then records the monitor of `WEB_AUDIO_SINK`, by default
whichever sink is the host's default when a browser starts listening, and
streams it as the full image streams its own; see
[Audio](full-image.md#audio). Programs run in the terminal play on the
host too. It's the host's playback only: there's no microphone. The full
image can use the host's sound the same way, and then doesn't start its
own PipeWire.

- Mount the folder, not the socket itself: the sound server makes a new
  socket each time it starts, which a mount of the old one wouldn't see.
  If the socket isn't there when the container starts, as when the folder
  doesn't exist yet, the container won't start.
- The container user (`VNC_USER`, uid 1000 when it's created) must be let
  in. PipeWire and PulseAudio accept the same uid as their own user, which
  is usually 1000 on a desktop. Otherwise, a PulseAudio server may want its
  cookie: mount `~/.config/pulse/cookie` and set `PULSE_COOKIE` to its path.
- The socket is only reachable on the same machine. A sound server on
  another machine would need PulseAudio's unencrypted TCP module, which
  isn't supported here.

If the server doesn't answer at startup, the log says so and the container
starts anyway; the [doctor report](health-checks.md) shows why audio fails.

## An SSH terminal

`WEB_TTY_COMMAND` is a shell command each terminal tab runs instead of
tmux, run with the user's shell (`bash -c`). With `ssh`, the terminal is a
login on the host, or any other machine:

```sh
  --add-host host.docker.internal:host-gateway \
  -e WEB_TTY_COMMAND="ssh -t $USER@host.docker.internal" \
```

`--add-host` names the host, as seen from the container, as
`host.docker.internal`. It works in the full image too.

- Each tab runs its own copy, which ends when the tab is closed or its
  connection is lost; reconnecting starts it again. To keep sessions
  running, use tmux or screen on the other machine, as in
  `ssh -t $USER@host.docker.internal tmux new -A -s web`.
- When it exits, as when SSH can't connect, what it printed stays on the
  screen, and Enter runs it again.
- Search isn't shown, since it searches tmux's history: the mouse wheel
  scrolls the terminal's own. Bells and notifications (OSC 9 and 777) from
  the other machine reach the page; copy `/usr/local/bin/notify` there to
  send them.
- SSH asks for a password, or uses a key in `~/.ssh`, as made above
  under [Running it](#running-it). Keep the home folder on a volume, so
  the key and the trusted host keys outlast the container.
- Downloads and the files page are still the container's `~/Downloads`.

## The image

An image for `VNC_ADDR` alone needn't carry a desktop, so `tabtop-lite` is
built without Xvnc, XFCE, Chromium, the Arc theme, Numix icons or
PipeWire, at about a seventh of the full image's size. GitHub Actions
publishes it beside the full image, as `ghcr.io/hw/tabtop-lite`, with the
same tags (see [Continuous integration](development.md#continuous-integration));
or build it:

```sh
docker build --build-arg DESKTOP=none -t tabtop-lite .
```

It keeps the gateway, the terminal, the files page and
[host audio](#host-audio), and won't start without `VNC_ADDR`.
`CHROMIUM_NO_SANDBOX`, `VNC_GEOMETRY` and `VNC_DEPTH` don't apply to it.
