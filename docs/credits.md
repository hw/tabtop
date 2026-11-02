# Credits

TabTop is built on other people's work. Thank you to everyone behind these
projects.

## In the web pages

Downloaded at build time (see [Build arguments](development.md#build-arguments)) and
served to the browser. Their license files are in the image next to their
files, except Ghostty's, which comes compiled into ghostty-web.

| Project | Used for | License |
|---|---|---|
| [noVNC](https://github.com/novnc/noVNC) | The desktop page: the VNC client in the browser, its control bar and icons | MPL 2.0 (core), BSD 2-Clause (HTML, CSS) and others; see its `LICENSE.txt` |
| [pako](https://github.com/nodeca/pako) | zlib in noVNC, bundled with it | MIT |
| [ghostty-web](https://github.com/coder/ghostty-web) | The terminal page's emulator | MIT |
| [Ghostty](https://github.com/ghostty-org/ghostty) | The terminal emulation in ghostty-web, compiled to WebAssembly | MIT |
| [Powerline](https://github.com/powerline/powerline) | `PowerlineSymbols.otf`, for the arrows in tmux status lines | MIT |
| [noble-ciphers](https://github.com/paulmillr/noble-ciphers), [noble-curves](https://github.com/paulmillr/noble-curves), [noble-hashes](https://github.com/paulmillr/noble-hashes) | The [encrypted tunnel](encryption.md) in the browser: ChaCha20-Poly1305, X25519, SHA-2 and HKDF | MIT |

## In tabtopd

Go modules (see `tabtopd/go.mod`), and the C libraries it links.

| Project | Used for | License |
|---|---|---|
| [Go](https://go.dev/) | The language and its standard library | BSD 3-Clause |
| [coder/websocket](https://github.com/coder/websocket) | WebSockets | ISC |
| [creack/pty](https://github.com/creack/pty) | The terminal's PTY | MIT |
| [jfreymuth/pulse](https://github.com/jfreymuth/pulse) | Recording sound over the PulseAudio protocol | MIT |
| [golang.org/x/crypto](https://pkg.go.dev/golang.org/x/crypto) | ChaCha20-Poly1305 for the tunnel | BSD 3-Clause |
| [golang.org/x/sys](https://pkg.go.dev/golang.org/x/sys) | Linux system calls (watching and renaming files) | BSD 3-Clause |
| [Opus](https://opus-codec.org/) (libopus) | Encoding the sound for the browser | BSD 3-Clause |
| [OATH Toolkit](https://www.nongnu.org/oath-toolkit/) (liboath) | Checking TOTP codes | LGPL 2.1 or later |

## In the image

Debian packages, under their own licenses: each one's is in
`/usr/share/doc/<package>/copyright` in the image.

- [Debian](https://www.debian.org/), the base system
- [TigerVNC](https://tigervnc.org/) (Xvnc), the desktop's X and VNC server
- [Xfce](https://www.xfce.org/), the desktop
- [Chromium](https://www.chromium.org/), the desktop's browser
- [Arc theme](https://github.com/jnsh/arc-theme) and [Numix icons](https://github.com/numixproject/numix-icon-theme), the desktop's look
- [PipeWire](https://pipewire.org/) and [WirePlumber](https://gitlab.freedesktop.org/pipewire/wireplumber), the desktop's sound
- [tmux](https://github.com/tmux/tmux), the terminal's sessions
- [OATH Toolkit](https://www.nongnu.org/oath-toolkit/) (pam_oath, oathtool) and [libqrencode](https://fukuchi.org/works/qrencode/), the TOTP key and its QR code at startup
- [tini](https://github.com/krallin/tini), the container's first process

`tabtop-lite`, the image without a desktop, leaves out TigerVNC, Xfce,
Chromium, the themes and PipeWire.
