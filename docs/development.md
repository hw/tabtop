# Building and development

## Build arguments

| Argument | Default | Description |
|---|---|---|
| `DESKTOP` | `xfce` | `xfce` builds the image with its own desktop. `none` leaves out Xvnc, XFCE, Chromium, the Arc theme, Numix icons and PipeWire, for an image that only shows an RFB server elsewhere: see [Without a desktop](lite.md#the-image). |
| `NOVNC_VERSION` | `1.7.0` | noVNC release, downloaded from GitHub. |
| `NOVNC_SHA256` | *(checksum of 1.7.0)* | SHA-256 of `https://github.com/novnc/noVNC/archive/refs/tags/v<version>.tar.gz`. A mismatch fails the build. |
| `GHOSTTY_WEB_VERSION` | `0.4.0` | ghostty-web release for the terminal, downloaded from npm (`ghostty-web`). |
| `GHOSTTY_WEB_SHA256` | *(checksum of 0.4.0)* | SHA-256 of `https://registry.npmjs.org/ghostty-web/-/ghostty-web-<version>.tgz`. |
| `NERD_FONTS_VERSION` | `v3.5.1` | Nerd Fonts release that the terminal's font, JetBrains Mono Nerd Font (its `NL Mono` regular and bold, made WOFF2), and its license are taken from. |
| `NERD_FONT_SHA256` | *(checksum of v3.5.1)* | SHA-256 of `https://github.com/ryanoasis/nerd-fonts/releases/download/<version>/JetBrainsMono.tar.xz`. |
| `NOBLE_CIPHERS_VERSION` | `2.4.0` | `@noble/ciphers` release from npm, whose ChaCha20-Poly1305 the page uses for the [tunnel](encryption.md). |
| `NOBLE_CIPHERS_SHA256` | *(checksum of 2.4.0)* | SHA-256 of `https://registry.npmjs.org/@noble/ciphers/-/ciphers-<version>.tgz`. |
| `NOBLE_CURVES_VERSION` | `2.4.0` | `@noble/curves` release from npm, whose X25519 the page uses for the [tunnel](encryption.md). |
| `NOBLE_CURVES_SHA256` | *(checksum of 2.4.0)* | SHA-256 of `https://registry.npmjs.org/@noble/curves/-/curves-<version>.tgz`. |
| `NOBLE_HASHES_VERSION` | `2.4.0` | `@noble/hashes` release from npm, whose SHA-2 and HKDF the page uses for the [tunnel](encryption.md). Must be the version `@noble/curves` depends on. |
| `NOBLE_HASHES_SHA256` | *(checksum of 2.4.0)* | SHA-256 of `https://registry.npmjs.org/@noble/hashes/-/hashes-<version>.tgz`. |
| `HIGHLIGHT_VERSION` | `11.12.0` | highlight.js release from npm (`@highlightjs/cdn-assets`), which colours text previews on the files page. |
| `HIGHLIGHT_SHA256` | *(checksum of 11.12.0)* | SHA-256 of `https://registry.npmjs.org/@highlightjs/cdn-assets/-/cdn-assets-<version>.tgz`. |
| `PDFJS_VERSION` | `6.4.299` | pdf.js release from npm (`pdfjs-dist`), its legacy build, which shows PDFs in the files page's previews. |
| `PDFJS_SHA256` | *(checksum of 6.4.299)* | SHA-256 of `https://registry.npmjs.org/pdfjs-dist/-/pdfjs-dist-<version>.tgz`. |
| `KATEX_VERSION` | `0.19.0` | KaTeX release from npm (`katex`), which draws math in Markdown previews. |
| `KATEX_SHA256` | *(checksum of 0.19.0)* | SHA-256 of `https://registry.npmjs.org/katex/-/katex-<version>.tgz`. |
| `MERMAID_VERSION` | `12.2.0` | Mermaid release from npm (`mermaid`), which draws diagrams in Markdown previews. |
| `MERMAID_SHA256` | *(checksum of 12.2.0)* | SHA-256 of `https://registry.npmjs.org/mermaid/-/mermaid-<version>.tgz`. |

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

The browser's public tunnel API remains `tunnel.js`. Its implementation is
split into `tunnel-protocol.js` (handshakes, framing and transport),
`tunnel-crypto.js` (cryptographic primitives), `session-state.js` (stored
credentials), `session.js` (login coordination), and `login-ui.js` (the form
and login summary). The protocol layer has no dependency on the login UI.
`files.js` owns navigation and selection; `file-format.js` provides sorting
and time formatting, and `sessions-view.js` renders session administration.

On the server, `store.go` owns opened-file validation, upload creation and
resumption, publication, durability, deletion and moves; `store_zip.go`
owns archive traversal. Each filesystem request acquires one store.
`upload_manager.go` owns active/resumable upload transitions and timers
under its own mutex. Tunnel handlers own transport and session policy,
using `responder.go` to accept streams, finish requests and report errors.
`rfbauth.go` shares VeNCrypt/TLS negotiation between login
and diagnostics, and returns an explicit authentication outcome so its
caller can manage cooldowns. Proxy parsing and login limits live in
`proxy.go` and `login_limit.go`; page styles are embedded CSS assets.

`serverConfig` holds startup settings separately from mutable services and
session state. Defaults come from `defaultServerConfig`; `newServer`
validates settings and initializes runtime maps and services. Integration
tests use the same constructor as startup.

The files page's `folder-model.js` owns listing generations, filtering,
sorting and selection without DOM dependencies. `files.js` handles loading
and rendering. `chunk_writer.go` isolates download flow control behind a
small transport interface, with a configurable stall interval for tests.

`terminal_process.go` owns PTY setup, I/O deadlines, resizing, child reaping
and idempotent cleanup; the terminal handler only bridges its I/O to the
tunnel. Active uploads carry an interruption callback, keeping transport
internals out of upload coordination. Time formatting uses independent
`createTimeFormatter` instances with injectable timezone, locale and clock;
the files page passes its formatter to the session administration view.

`transfer.js` owns one upload or download attempt's cancellation, cleanup
and retry eligibility without DOM dependencies. Download presentation shares
one file/ZIP path; upload and download wire protocols remain separate.

`entrypoint.sh` orchestrates startup and supervises child processes. Its
sourced `startup/config.sh` validates the environment; `startup/user.sh`
provisions the account, credentials and runtime; `startup/desktop.sh` starts
the desktop and configures audio. These functions run in the supervising
shell so child PIDs and runtime outputs remain available for shutdown.
Run `test/startup-check.sh <image>` to check external-VNC startup, a custom
account, credential ownership, secret removal and restart with an existing home.

Filesystem notifications use `watch_source.go` for inotify registration,
decoding and reader shutdown; `watch_policy.go` for rename pairing, settling,
duplicate suppression and debounce deadlines; and `watch_monitor.go` to
connect events to notifications. Policies accept timestamps directly for
deterministic tests. Tunnel streams are accepted only after registration;
closing the event source interrupts and joins its reader, even with a full
delivery queue.

`tabtopd/glyphs.js` owns the UI's SVG icons and text glyphs. Use `iconSVG`
for inline SVG, `iconDataURL` for desktop image buttons, and `glyphs` for
text symbols. Keep labels and behavior with each control. The module has
no DOM or session dependencies; sandboxed PDF and EPUB frames import it
through its CORS-enabled asset route.

`osc.js` parses terminal escape sequences without browser APIs. The terminal
UI performs clipboard writes in response to its events. Run
`mise run test-js` for parser tests covering chunk boundaries, malformed
sequences and oversized input; CI runs these alongside the Go tests.

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
the desktop and its sound, lists, downloads, previews, uploads and deletes
files, uploads a folder both picked and dropped and deletes one, downloads
zips, makes a folder, renames, moves and copies the path of a file,
replaces one on upload, pastes one, uses the list from the keyboard,
deletes several at once, cancels an upload, sees the list update itself
and the page go back to the folder it last showed, drops a file on the
desktop and has the desktop announce one saved there, passes text both
ways between noVNC and the clipboard, runs commands in the terminal (with
its font size keys and touch keys), drops a file on it and searches its
history, retries a failed download, marks a failed login as seen, ends
another session (named by its
browser), has files too big together refused, carries on with an upload
whose connection was cut, cuts the
connection on each page to see it come back, logs in again when warned
the login is ending, and logs out, then checks from
inside the container what the pages left in `~/Downloads`, and what the
zips hold. It prints `ok` or `not ok` for each step, and the container's
log if one fails. It needs Docker, Node, Python 3 and Chrome or Chromium
(set `CHROME` if it isn't found). `mise run browser-check` builds the image
and runs it.

`test/lite-check.sh <lite image> <full image>` checks an image built
without a desktop: that it has none, that it won't start without
`VNC_ADDR`, and that with Xvnc from the full image as its RFB server, in a
container of its own, it becomes healthy, its troubleshooting report has
no failures and its pages load. It needs Docker and Python 3.
`mise run lite-check` builds both images and runs it.

## Continuous integration

`.github/workflows/build.yml` runs on pushes to `main`, on `v*` tags and on
pull requests. It checks formatting, runs `mise run vet` and `mise run test`,
then builds the image and runs `test/browser-check.sh` on it, and builds
the one without a desktop (`DESKTOP=none`) and runs `test/lite-check.sh`
on it. If all of that passes, it pushes them to `ghcr.io/<owner>/<repo>`
and `ghcr.io/<owner>/<repo>-lite`, each with these tags:

| Event | Tags |
|---|---|
| Push to `main` | `main`, `latest`, `sha-<commit>` |
| Tag `v1.2.3` | `1.2.3`, `1.2`, `sha-<commit>` |
| Pull request | none: the images are built and checked but not pushed |

The first push creates each package as private. To let others pull them without
logging in, make each public in its package settings on GitHub.

The browser regression suite also uses FFmpeg to generate an indexed video
fixture for range-based playback and seeking tests.
