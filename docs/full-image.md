# Running TabTop with XFCE

The `tabtop` image has a desktop of its own: XFCE on TigerVNC's Xvnc, with
Chromium, the Arc-Dark theme, Numix icons, and PipeWire for its sound.
Start it as the [quick start](../README.md#local-quick-start) shows:

```sh
docker run -d --name tabtop -p 6080:6080 \
  -e VNC_USER="$USER" \
  -e VNC_TOTP_SECRET="$(head -c 20 /dev/urandom | base32)" \
  -v tabtop-home:/home/$USER \
  ghcr.io/hw/tabtop:latest
```

The volume is optional. It keeps the home folder, and with it Chromium's
data, `~/Downloads` and the desktop's settings, when the container is
replaced.

## The desktop

The desktop has one panel at the top: show desktop, launchers for
Chromium (in incognito mode) and a terminal, the window list, the
workspace, the tray and a clock in the time zone set by `TZ`. A home
directory kept from an older image keeps its own panel, so it doesn't
get the terminal launcher; delete
`~/.config/xfce4/xfconf/xfce-perchannel-xml/xfce4-panel.xml` and restart
to get the new one.

Web links open in Chromium in incognito mode, terminals in
xfce4-terminal, which starts in the home folder, and folders in Thunar.
Downloads land in `~/Downloads`, where the [files page](downloads.md)
offers them, and the desktop page offers each one as it's saved.

## Desktop size

`VNC_GEOMETRY` sets the desktop's size before a browser connects, and
`VNC_RESIZE` how noVNC fits it to the browser window afterwards; see
[`VNC_GEOMETRY` and `VNC_RESIZE`](environment.md#vnc_geometry-and-vnc_resize).

## Chromium's sandbox

Chromium runs without its internal sandbox by default, since restricted
container runtimes don't allow it; see
[`CHROMIUM_NO_SANDBOX`](environment.md#chromium_no_sandbox).

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
- **Login:** sound comes through the [encrypted tunnel](encryption.md), only
  for a session that has the desktop open from the same IP address, and
  stops a few seconds after the desktop connection closes. There's no
  separate login.
- **Bandwidth:** 64 kbit/s per listener by default, even during silence;
  see [`WEB_AUDIO_BITRATE`](environment.md#web_audio_bitrate).
- **Output only:** the desktop has no microphone.

At startup, PipeWire logs a few errors and notices about realtime scheduling,
D-Bus, Bluetooth and cameras, which a container doesn't have. They're
harmless.
