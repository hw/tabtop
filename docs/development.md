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
| `KAITAI_FORMATS_COMMIT` | `7d175667527372eb0c521045c1dac212230d9779` | Pinned Kaitai format library snapshot (191 formats). |
| `KAITAI_FORMATS_SHA256` | *(checksum in Dockerfile)* | SHA-256 of the format library archive. |
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
Run `bash test/features-check.sh <image>` to check
files-only, terminal-only and desktop-only startup, disabled routes and
navigation, health checks and invalid service switches.

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
log if one fails. It needs Docker, Node, Python 3, FFmpeg, and Chrome or
Chromium (set `CHROME` if it isn't found). `mise run browser-check` builds
the image and runs it.

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

## Preview and file modules

`files.js` owns folder listing, selection and keyboard navigation;
`files-actions.js` owns mutations, share links and transfer tracking. Actions
receive the refresh callback and formatting helpers without importing the page.
`e2e.go` serves page assets and headers; `tunnel_request.go` owns tunnel routing.

`preview.js` owns the lightbox, navigation and cancellation. `preview-loaders.js`
selects transport loaders; `preview-renderers.js` selects format adapters. Frame
messaging is bound in `preview-frames.js`, editing lives in `preview-editor.js`,
and each mounted renderer has the lifecycle documented in `preview-view.js`.
Text editing reuses the preview's language detection and validated highlight.js
markup behind a native textarea. Highlighting pauses during composition and
falls back to plain text above the preview's 512 KiB character limit.
The code glyph before fullscreen in the preview toolbar toggles highlighting
while editing and remembers the choice in this browser. Routine edit status
stays in the toolbar; the editor only shows validation errors, render failures
and recovery controls when needed. Error line and column links focus and scroll
the textarea to the reported location.
`stream-worker.js` centralizes worker readiness and retries. `media-source.js`
owns media lifetimes, while `ranged-file.js` validates and cancels shared PDF and
media reads. Their range caps and concurrency policies remain format-specific.
The `video-stream.js` shim and legacy video-range messages support cached pages;
media's buffered fallback still supports browsers without service workers.

`file-types.json` is the binary MIME/kind registry shared by the browser, worker
and EPUB picture validation. After editing it, run `go -C tabtopd generate` and
commit the two generated JavaScript files. The MIME interop test checks them
against the registry. Text previews retain their separate plain-text policy.

The Go preview handlers share Downloads file opening and child-process
mechanics. Each format retains its own input, output and timeout limits. Work
admission waits up to five seconds, then returns that format's busy error; each
read/render format has two slots and EPUB rewriting has one. ZIP listing and EPUB
opening share bounded directory validation (10,000 entries/4 MiB for listings,
20,000 entries/8 MiB for EPUB), before the standard ZIP parser allocates entries.
See [preview sanitizer boundaries](preview-security.md) before changing HTML handling.

Browser fixtures and feature checks live under `test/browser/`. Run an independent
group against a built image, or omit `--group` for the complete journey:

```sh
mise exec -- bash test/browser-check.sh tabtop:review --group zip
mise exec -- bash test/browser-check.sh tabtop:review --group mkv
mise exec -- bash test/browser-check.sh tabtop:review --group editing
mise exec -- bash test/browser-check.sh tabtop:review --group previews
mise exec -- bash test/browser-check.sh tabtop:review
```

Other groups are `audio`, `video`, `media`, `text`, `html`, `markdown`, `pdf`,
`epub` and `tables`. Each creates its own required fixtures.

## Binary structure previews

Unknown files offer a single **Preview** action, choosing Text for readable
UTF-8 and Binary for other data. The lightbox has a glyph button
to switch between Text and Binary for unknown files using the same loaded bytes.
Its tooltip names the view it will switch to. Known file types use their native
previews and do not offer Binary view. Inside the binary preview, **Interpret as**
is an autocomplete dropdown: open the arrow to browse all formats, or type to
filter by name, ID or category. Use Up/Down and Enter to select a format; Escape
closes the dropdown. You can also enter its exact format ID and press Enter.
Expand decoded fields and click their names to highlight the corresponding file
bytes. Formats with required parameters show an input form. A format mismatch
shows the fields decoded so far while preserving the hex view. Decode status
separates format validation failures, unexpected end-of-data, data outside the
prefix, and resource-budget exhaustion. When a required original-file offset is
known, **Jump to required bytes** fetches that hex range without extending the
Kaitai decoding limit. Decoder details retain the underlying error for inspection.

Click any field name to show its path, type, value, numeric hex value, enum,
byte order, offset, length and documentation where available. Computed/lazy
fields and transformed data can be inspected even without a source-byte range.
Byte offsets are never inferred for decompressed or parameter buffers.

Unknown files are classified using their first 1 MB. Readable text previews load
up to the first 10 MB, with a notice when the rest is omitted; truncated text
cannot be edited. Binary previews fetch aligned 1 MB ranges through the encrypted
tunnel and render 4 KB pages. Previous/Next 1 MB and the byte-offset field browse
the whole file. Reads use the original size/mtime and fail if the file changes.
One fetched range is cached; the first range remains available for Kaitai.
Already buffered text bytes can also be reused without another transfer.

Kaitai decodes only the first 1 MB, regardless of the range being viewed in hex.
Fields that need data beyond that prefix may fail to decode; the raw hex viewer
can still browse those ranges. Existing known-type native preview limits remain
in effect.
The parser runs in a dedicated browser worker, terminated when the preview closes
or decoding times out. Generated parsers are instrumented before bundling: allocation checks run
before object/array creation, repeat loops spend work units, and constructors,
readers and lazy getters have a depth limit. One parse, including all lazy
expansions, has budgets of 20,000 allocations, 100,000 operations, 128 nesting
levels, 32 MiB of transformed/string allocation and 8 MiB of cumulative inflated
output. Tree children load in groups of 100 and UI expansion is separately
capped at 20,000 fields. These structural bounds are not an exact browser heap
quota; the worker timeout remains an additional cancellation mechanism. Transformed data is labelled separately
and does not link to misleading original byte offsets. Numeric values above
JavaScript's safe integer range are approximate; the hex bytes remain exact.

The Docker build compiles all formats with byte-position metadata, bundles shared
parser dependencies, and copies only generated assets and license/source notices
into `/opt/kaitai`. It adds no compiler or Node service to the running container.
Parsers are fetched only when selected and served from disk without retaining
the full gallery in the gateway's asset cache. The gateway flag is
`-kaitai-dir /opt/kaitai`; leave it empty to disable format decoding.

For a local build, download the archive pinned in `scripts/kaitai/sources.json`,
verify its SHA-256, and extract it. Then run:

```sh
npm ci --ignore-scripts --prefix scripts/kaitai
node scripts/kaitai/build.mjs /path/to/extracted-formats scripts/kaitai/dist
```

Run the gateway with `-kaitai-dir scripts/kaitai/dist` (using an absolute path
when starting it from another directory). `node test/kaitai.test.mjs` tests the
generated parser bundles when present; `test/browser-check.sh <image> --group
binary` verifies format selection, field jumps and error handling through the
actual encrypted file preview. The Docker Kaitai stage also runs the allocation/decompression regression
tests against its generated parser bundles. Build dependencies are pinned in
`scripts/kaitai/package-lock.json`. Update the library commit and checksum in
both `Dockerfile` and `scripts/kaitai/sources.json` when refreshing the gallery.
