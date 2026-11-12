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
| `ICED_X86_VERSION` | `1.22.0` | iced-x86 release from npm (`iced-x86`), which disassembles x86 code in the hex preview's data inspector. `scripts/disasm/build.mjs` makes its Node build loadable in a browser worker, without its documentation comments, and checks it at build time. |
| `ICED_X86_SHA256` | *(checksum of 1.22.0)* | SHA-256 of `https://registry.npmjs.org/iced-x86/-/iced-x86-<version>.tgz`. |
| `CAPSTONE_JS_REV`, `CAPSTONE_JS_SHA256` | *(revision and checksum in Dockerfile)* | Capstone.js wrapper source, built with Emscripten 4.0.23 and only the ARM, ARM64 and MIPS backends. |
| `CAPSTONE_REV`, `CAPSTONE_SHA256` | *(revision and checksum in Dockerfile)* | The Capstone submodule matching that wrapper revision. Update both source pins together. |
| `ONNX_WEB_VERSION` | `1.22.0` | ONNX Runtime Web, WASM backend only, for U2NetP background removal in the image editor. |
| `ONNX_WEB_SHA256` | *(checksum of 1.22.0)* | SHA-256 of `https://registry.npmjs.org/onnxruntime-web/-/onnxruntime-web-<version>.tgz`. Update the pinned runtime license and third-party notice checksums with the version. |
| `U2NETP_SHA256` | *(checksum in Dockerfile)* | SHA-256 of the U2NetP ONNX weights from rembg's `v0.0.0` release. |
| `MIGAN_REVISION` | `406830d0fa60666da0071c342ad2fbc8f30c5c64` | Hugging Face revision of the authors' `andraniksargsyan/migan` repository, for the ONNX pipeline and its MIT weights license. |
| `MIGAN_SHA256` | *(checksum in Dockerfile)* | SHA-256 of `migan_pipeline_v2.onnx`. The bundled model is the official 28.1 MB export, without additional quantization. |
| `MOBILESAM_ONNX_REVISION` | `0d3b403339b4674a82493d5e97964dd78089ddc8` | Hugging Face revision of `Acly/MobileSAM`, for MobileSAM's ONNX image encoder and the Segment Anything single-mask decoder. |
| `MOBILESAM_ENCODER_SHA256`, `MOBILESAM_DECODER_SHA256` | *(checksums in Dockerfile)* | SHA-256 of `mobile_sam_image_encoder.onnx` (28.2 MB) and `sam_mask_decoder_single.onnx` (16.5 MB). |
| `MOBILESAM_REV`, `SAM_REV` | *(revisions in Dockerfile)* | MobileSAM's and Segment Anything's repositories, for their Apache-2.0 licence files. |
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

The gateway uses libopus (audio), liboath (logins) and libsqlite3 (database
previews) through cgo, so
building it needs a C compiler and their headers
(`apt install gcc libopus-dev liboath-dev libsqlite3-dev` on Debian).

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
The `services` browser group checks that a terminal with `WEB_FS=0` installs
no file-drop or screenshot-upload handlers. It runs separately from the normal
browser journey because it needs a terminal-only container.

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
`page_assets.go` serves page assets and headers; `tunnel_routes.go` lists every tunnel request, with whether it needs file
support (WEB_FS), and routes it; `tunnel_request.go` reads requests and holds the file handlers.

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
previews and do not offer Binary view, and data that isn't text has no
Text view, so neither shows the button. A file named as text (`.txt`, `.json`,
`.csv` and the like) with a NUL byte in its first 8000 opens in the binary
view instead. Inside the binary preview, **Interpret as**
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
tunnel and render 4 KB pages: **<** and **>** step a page, **−1 MB** and
**+1 MB** a range, and the byte-offset field jumps; together they browse the
whole file. On a phone, the four buttons and the offset field share a row, the
status line below leaves out which bytes are shown, keeping what's to say (a
selection, a search's result), and Find takes the row below that. Reads use the original size/mtime and fail if the file changes.
One fetched range is cached; the first range remains available for Kaitai.

The hex view shows Offset, hex and ASCII as separate columns under a header
that scrolls sideways with them. Drag across bytes in either the hex or the
ASCII column to select them; the same bytes are highlighted in the other
column, more lightly. A drag keeps to the column it started in, so it follows
the pointer past a row's end or between bytes, and held above or below the
pane it scrolls and keeps selecting. Click an offset to select its row (drag
down or up the offsets to select whole rows), Shift-click to extend a selection, and Escape to clear it (a second Escape
closes the preview). The status line shows how many bytes are selected, and
where. Ctrl C (Cmd C) copies the selection as it appears in the column it was
made in: space-separated hex from the hex column, characters (with `.` for
unprintable bytes) from the ASCII column. Only bytes in the loaded 1 MB range
are copied, and the status line says when a longer selection was cut short.
The **data inspector**, beside the bytes (below them when the hex view is
narrow, as beside the Kaitai field tree), shows what the bytes from the
selection's start read as: **raw**, the 8 bytes there (fewer at the file's
end) as one hex number, in the byte order chosen (`0x0807060504030201` for
01 02 … 08, little-endian); int8, int16, int32 and int64, signed and unsigned, and
IEEE 754 float32 and float64, little-endian (as x86, ARM and most files
are) or, with **LE | BE** at its top, big-endian (as network protocols and
some formats, such as PNG, are; the choice is remembered). An unsigned value
the same as the signed one above it (its top bit clear) is dimmed, so the
rows never move. "—" shows where there
aren't bytes enough. Each value has a copy glyph. Under them, **Copy as**
**Hex**, **ASCII**, **Offset** (`0x10`, or `0x10-0x2f` for a range) or
**Base64** copies the selection, whichever column it was made in, and **…**
opens a box to copy it as hex as you choose: in lower or upper case, with a
space, nothing, a comma, a comma and a space, a colon, a dash or a new line
between the bytes, and a prefix before each, such as `0x` (`0x4D, 0x5A`); a
sample shows how it will look, and the choice is remembered in your browser. The glyph
at the right end of the **Interpret as** row shows or hides it; the choice is
remembered in your browser.

Drag the divider between the bytes and the inspector to resize the panel.
It changes width beside the bytes, or height when the inspector sits below
them. Width and height are remembered separately in your browser. Focus the
divider and use the arrow keys to resize it (Shift makes larger steps);
double-click it, or press Home, to reset the current dimension. The bytes
retain space for navigation, and long instructions scroll horizontally
instead of losing their operands to an ellipsis.

At the inspector's top, **Values** and **Disassembly** tabs pick what it
shows, the one given the whole panel (on a wide screen, all its height; on a
phone, or in a narrow window, the panel sits under the bytes); the tab is
remembered in your browser. **Disassembly** shows the selected bytes as
instructions, a line each: its offset, its bytes and the instruction. Choose
**x86-64**, **x86 (32-bit)**, **x86 (16-bit)**, **ARM64**, **ARM32**,
**ARM32-T (Thumb)**, or **MIPS32/64 LE/BE** at the right of the tabs; this
choice is remembered too. x86 uses Intel syntax. ARM modes use little-endian
instructions; Thumb includes both 16-bit and 32-bit instructions and tracks
IT state within the selection. MIPS modes use standard 4-byte instructions;
MIPS16, microMIPS and Release 6 modes are not offered. The Values tab's byte
order does not change the instruction set. Bytes that aren't an instruction show
as `(bad)`. An address an instruction goes to or names (`jmp short 018Ch`,
`call`, or memory read by its address alone, `[rip+…]` shown as where that is)
is a link when it's within the file: click it to select that byte and see its
code. With one byte selected, it's the 64 bytes from it; at most 4 KB, or
512 instructions, are shown at a time. Addresses are file offsets, with no
executable load-address mapping. Decoding starts at the exact selected byte;
unaligned ARM/MIPS starts are labelled rather than rounded. ARM/MIPS branch
destinations, and ARM64 ADR/ADRP addresses, are links when within the file.
Register-indirect destinations cannot be resolved statically.

iced-x86 handles x86; Capstone.js handles ARM/MIPS. Each backend is fetched
only when first used and runs as WebAssembly in the existing worker (the page
itself isn't allowed to run WebAssembly). The Capstone subset adds 1,141,542
bytes of JS/WASM, or 417,439 bytes with gzip, at the pinned versions. Browser
assets have immutable content-hashed URLs. On **Values**, or with the inspector
hidden, neither backend is requested.

The `capstone` Docker stage builds from checksummed source with a pinned
Emscripten version; the SDK is absent from the final image. The upstream JS
detail reader has older C layout offsets, so `scripts/disasm/capstone-layout.c`
generates offsets using the actual WASM ABI and headers. `capstone-detail.js`
uses these to read instruction groups and immediate operands. The `disasm`
stage runs `check-capstone.mjs` against the actual WASM through the worker,
checking modes, Thumb IT state, branch targets, byte order, invalid words,
truncated input and limits, and prints raw/gzip sizes. To run this check
independently, build `docker build --target disasm -t tabtop:disasm-check .`.

**Find**, in the bar above the bytes, looks for a run of bytes in the whole
file, as hex or, with the mode button beside it (its glyph a drawn 0x) switched to Aa, as ASCII text
(matched as UTF-8). In hex, bytes are pairs of
digits, spaced or not, and `?` matches any digit: `4?` is any of 0x40–0x4f, and
`??` (or `?` alone) any byte, as in `4d 5a ?? 00`. Enter (or **›**) finds the
next match after the selection, Shift Enter (or **‹**) the one before it; the
match is selected. The server reads the file a stretch at a time, so a search
of a large file shows its progress. It looks in the file as saved, so not at
changes not yet saved.

**Edit** changes bytes where they are: none is ever inserted or removed, so the
file keeps its size. Click a byte (or select one), then type: hex digits in
the hex column change it a digit at a time (the second half of the caret is
shaded once the first is typed), and characters in the ASCII column the whole
byte; the caret moves on. Arrows move it (up and down by a row, across pages),
Tab switches column, Backspace moves back, and Ctrl Z undoes. Changed bytes
show in orange, and the inspector reads them. Editing, each of the
inspector's values is a box: type a new one (integers in decimal, within
the type's range, or in `0x` hex, as the bytes' value, signed or not: `0xff`
in int8 is -1, and `0x80` -128; or, with a sign, in hex as the number itself,
`-0x7F` in int8 being -127, and `+0xff` too big for one; floats as numbers, `NaN` or `Infinity`; raw as hex digits, `0x` or not, zeros put before them to fill its bytes) and
press Enter, or leave the box, and its bytes, as that type and byte order,
are written at the selection's start; Escape puts the box back. Ctrl Z, back
at the bytes, undoes such a value whole.

Editing x86 code, a click on an instruction in **Disassembly** opens a box with it, to
type another over it in Intel syntax, as the list shows them (`mov rbp,rsp`,
`jmp short 1012h`, `mov eax,dword ptr fs:[28h]`, `vaddps zmm0{k1}{z},zmm1,[rax]{1to16}`)
or as other assemblers take them (`0x1f`, `jz`, `qword [rax]`, `'A'`, `rep stosb`),
in the instruction set chosen. Enter writes its bytes there, as one change:
one shorter than what was there is followed by `nop`s (`90`) up to the next
instruction, and one longer goes over the next, the last of those it ends
inside filled out with `nop`s, so the code after it still reads as it did
(the status says how many). Branch targets are addresses as listed, file
offsets; so is `[addr]`, which in 64-bit code is RIP-relative, as most are,
unless it's through `fs` or `gs` (thread-local, as the stack guard at
`fs:[28h]`), or the instruction there before had an absolute address, or it's
`[abs addr]`, or it's too far for RIP-relative; `[rel addr]` is always
RIP-relative. (The disassembly shows both kinds the same way.) Memory with no register to give its
size needs one (`inc dword ptr [rax]`). A line that can't be assembled says
why, and the box stays to put right; Escape puts it back. `x86-asm.js`
assembles it, in the disassembler's worker: it reads the line, tries each of
iced-x86's encodings of that name whose operands fit, encodes them with
iced-x86, and keeps the shortest that decodes back to the same instruction.
ARM/MIPS instructions remain view-only; their raw hex bytes can still be edited.
The image build checks it on lines as typed and on random bytes, as each
instruction set decodes them, assembled back to the same, RIP-relative or not. The disassembly shows the
instructions themselves rather than pseudo-ops (`cmpss xmm0,xmm1,4`, not
`cmpneqss`), so each can be typed back as shown. **Save** (or Ctrl S) writes them
into the file where they are, rather than writing a new copy, as a text save
does, since a binary file may be large: only if the file is as it was when
opened (its version and size, and, checked by a SHA-256 of them, the bytes
being replaced: written in place, the file keeps its inode, so its version
alone wouldn't show a change made within the same tick of the clock), not
through a link, not a file with other names (a hard link, whose
other names may be outside Downloads), and at most 256 KB of changes at a time. The whole
change reaches the server before any of it is written, so a lost connection
writes nothing; a crash while writing could leave some of it written.
**Done** waits for a save going to finish, then asks before discarding changes not saved.
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

## Image background removal

**Scan document** turns a photographed receipt or page into a rectangular
scan. Drag the numbered corners clockwise around the paper (top left, top
right, bottom right, bottom left). Focus a corner and use the arrow keys for
one-pixel adjustments, or Shift for ten pixels. **Preview** shows the flattened
page; **Corners** returns to the original photo and outline. The compact
adjustments popover provides Color, Grayscale, and Black & white finishes,
Paper whitening, and Ink strength. Apply adds one history entry; Cancel
preserves the original image. Undo and Redo work normally.

New scans start in **Curved paper** mode. The arrow beside Preview chooses
Curved paper or Sharp folds. Four extra side points shape the
left and right paper edges; each left/right pair also locates an interior
guide. Drag the guide's blue middle diamond onto a bowed table rule or text
baseline. The guide passes through that point, and the resulting scan
straightens the entire curve. Focus any point and use the arrow keys for
fine adjustments. A point outside the image turns red, announces itself as
invalid, and disables Apply until it is moved back inside.

`image-scan.js` first removes the corners' perspective. It interpolates the
side boundaries and interior guides in that rectified plane with
shape-preserving cubic Hermite curves. Adjacent regions share derivatives
so there are no hard joins. Guide tangents are limited against the inverse-
projected picture bounds to prevent overshoot without moving the control
points. Interior guides are resampled by arc
length in page-pixel coordinates to reduce stretching around a bow. Profiles
are fitted once per output column; full-resolution and preview use the same
normalized mapping. Vertical Jacobian polynomials are checked with Bernstein
bounds and recursive subdivision; horizontal checks cover arc-length lookup
boundaries and their midpoints, with adaptive horizontal subdivision where
the Jacobian changes nonlinearly. The mesh check also rejects collapsed regions.
These checks reject crossed guides and folded-over regions before
Apply. The controls define a manual two-dimensional correction, not an
inferred three-dimensional paper surface.

**Sharp folds** retains the continuous bilinear strip mapping, with a change
in slope at each fold. Switching modes retains the curve adjustments. All
regions use a shared camera transform, preserving complete boundary
alignment. Output dimensions stay fixed to the four-corner scan, and default
guides give exactly the same pixels as four corners alone. Older recipes
without a surface mode retain sharp-fold behavior. Scan recipes include the
surface mode and curve points, which scale with other controls for PDF batches.

`image-scan.js` validates a convex, uncrossed outline and resamples with
premultiplied-alpha bilinear interpolation. Paper
cleanup estimates illumination separately for each color channel on a field
up to 192 pixels per side, enlarges bright paper regions to bridge ink, and
smooths the field. The image's lettering stays in its original pixels; there
is no OCR or text generation. Preview uses an image up to 900 pixels per side;
Apply processes the full resolution. Scan inputs and outputs are limited to
16 megapixels, with output sides at most 8192 pixels. Scan recipes retain the
corners and adjustments and scale them to other pages in PDF batch editing.

**Save as → PDF** writes a single-page PDF copy beside the image, preserving
its aspect ratio at 150 pixels per inch. Transparency is flattened onto white
and the page is encoded as JPEG at the chosen quality. The source image stays
unchanged when saving a PDF copy. PNG remains available for lossless output.

**Invert selection** is available for background removal, inpainting masks,
and paint-bucket selections. Background removal and the bucket act outside
the outlined rectangle or circle when inverted. Inpainting inversion
complements the complete current mask, including brush and subtracted marks;
it is itself a mark that Undo can remove. Its SVG highlight and raster repair
mask use the same complement, and inverted selections survive batch scaling.

The image editor's **Remove background** tool runs U2NetP in a dedicated
browser worker with ONNX Runtime Web, using one WASM thread. Both images
bundle the model and runtime in `/opt/background`; no Python, GPU or remote
inference service is needed. The browser fetches them from TabTop only on
first use, under a content-hashed asset path. The worker may run WebAssembly;
the files page's CSP remains unchanged. The model sees a 320×320 RGB sample
of the current edit; its soft foreground mask is scaled to the current
picture and multiplied with existing alpha. The glyph activates the main
toolbar; its Adjustments button opens a popover with Threshold, Edge softness
and Shrink / grow controls, using the same style as Save options, without a
heading, tool strip or action buttons. Each previews from the original mask.
The initial settings are threshold 50%, softness 100% (the original soft
mask), and no growth. Growth is a separable max/min filter with a radius
relative to the mask dimensions. Apply in the main toolbar adds an undo
checkpoint; Cancel discards the preview. Each new activation analyzes the current image and adds
a separate operation, preserving earlier removals. Cancel and leaving the editor
terminate the worker.

Selected-area removal clips alpha changes to a rectangle or circle; pixels
outside it are unchanged, or inside it when the selection is inverted.
Erase/restore strokes use round paths at image resolution,
without reducing them to the 320×320 model mask. Restore copies the pixels
from before the background operation, preserving existing alpha. Selection
and stroke coordinates belong to that operation's input image; pointer
coordinates are mapped back through later crops, flips, rotations and resizes.
All of this remains a preview until Apply. Pointer cancellation discards the
active gesture; Undo stroke removes the latest brush stroke, and Whole image
clears the selected area. The settings use an auto popover: its toggle, Escape
or an outside click dismisses the popup while retaining the adjustment preview.
The image and spatial toolbar remain part of the editing session; clicking
outside that session still cancels it.

For a standalone gateway, pass `-background-dir` with `ort.wasm.min.js`,
`ort-wasm-simd-threaded.mjs`, `ort-wasm-simd-threaded.wasm`, and `u2netp.onnx`.
Without these assets, the tool reports an error and leaves the image intact.
The Docker build pins downloaded bytes by SHA-256 and retains the model's
Apache-2.0 license and the runtime's MIT license and third-party notices.

## Image inpainting

Both images bundle the authors' MI-GAN ONNX pipeline as `/opt/inpaint/migan.onnx`
with its MIT license. `-inpaint-dir` locates the model; `-background-dir` supplies
its shared ONNX Runtime Web assets. MI-GAN uses a separate content-hashed asset
set, so opening background removal doesn't read the inpainting model. The
inpainting worker has the same WASM-only CSP as background removal; no change
to the files page's CSP is needed.

Marks are image-coordinate rectangles and round brush paths, drawn as an SVG
mask overlay. Only a bounded crop around additive marks is rasterized. The crop
includes 32–128 pixels of context and is capped at 16 megapixels; the worker input
is downsampled to a maximum side of 1024. The official pipeline then handles its
512×512 internal inference and returns the crop at the submitted resolution.
Inputs are uint8 RGB `[1,3,H,W]` and a binary uint8 `[1,1,H,W]` mask with 255 to
keep and 0 to repair. Repaired RGB is scaled back and blended only through the
original full-resolution mask; input alpha and every unmasked pixel are kept.
The resulting patch is an ordinary undoable image operation, so later rotations,
crops and resizing also work. Cancel terminates the worker; asynchronous results
from a previous session are ignored. Leaving the editor frees masks and workers.

Mask shapes, brush dropdowns and enclosed-region flood fill are shared in
`image-mask.js`. Both tools support round brush strokes, rectangles and circles.
Circle gestures measure a radius from their initial point. Bucket fill rasterizes
only the existing marks' bounded area, then performs a scanline flood fill through
unmasked pixels. Touching the crop boundary rejects an open outline without
changing the marks. Fills are stored as row spans, so Undo removes a fill as a
single operation, without retaining a full-size bitmap. The same vector shapes
and spans drive the SVG mask overlay and the actual canvas mask.

## Magic select

Both images bundle MobileSAM as `/opt/segment`: Acly's ONNX export of its
image encoder and the Segment Anything mask decoder exported to return a
single mask. Both are Apache-2.0 (`LICENSE.mobilesam`,
`LICENSE.segment-anything`). `-segment-dir` locates them; `-background-dir`
supplies the shared ONNX Runtime Web assets. The worker
(`image-segment-worker.js`) has the same WASM-only CSP as background removal.

Choosing **Object**, magic select, as the inpainting tools' selection shape
(beside Rectangle and Circle) analyses the picture once:
it's scaled so its longest side is 1024 pixels (larger or smaller), and the
encoder takes raw 0–255 RGB `[H,W,3]`, normalizing and padding it itself. The
256×64×64 embedding stays in the worker. Each click is then a decoder run
with that point and a padding point (label −1); a dragged box is its two
corners (labels 2 and 3). With one point or a box, the decoder picks the best
of Segment Anything's three masks. Masks come back at the analysed size, not
the picture's, and are thresholded at zero.

The mask is grown by 3 analysed pixels, so a repair takes in the object's
edge, and stored as a fill mark: row spans at the analysed size with a
`scale` to the picture. The overlay, inpainting crop, Undo and PDF batches
handle it like any other mark; on other pages it's replayed as the same
area, not segmented again. Shift-click (or Alt-click) adds the object as a
subtracting mark. Closing the tool terminates the worker.

Background removal has the same **Object** selection shape, analysing the picture
as it was when removal began. There a click removes the object (a
subtracting mark) and Shift-click adds it back. The objects picked (marks, as above, without
growing) edit U2NetP's mask in order, at the analysed size (`objectMask`):
each removes its area or adds it back. **Keep all objects** makes one mark
flagged `only`, which clears the mask before it, so what's found replaces
the cutout. The sliders, selection and brushes apply on top as before. On
other PDF pages the recipe's `objects` replay as the same areas, over
U2NetP's mask for that page (not run when an `only` mark makes it
unneeded).

The draw tool's paint bucket offers **Object** as a selection shape: a
dragged box or a Shift-click asks the decoder, and the result is a selection
`{shape: "object", x, y, width, height, mask: {width, height, spans}}`, its
spans relative to its bounds, so scaling the bounds (as `scaleRecipe` does)
scales the outline. `image-fill.js` tests each pixel against those spans.
Cropping has a wand too: the crop becomes the object's bounds, in whole
pixels (`objectBounds`).

**Select all objects** (Mark all objects, Keep all objects, and crop to every
object) clicks an 8×8 grid over the picture, one decoder run each. A mask is
kept if the decoder's own score is at least 0.8, it's stable (the area above
a logit of +1 is at least 90% of that above −1), it's between 0.2% and 50%
of the picture, and it doesn't reach three of its sides (the background).
Of masks overlapping by more than 70%, the better (score × stability) is
kept. The rest are combined into one mask, so one Undo takes them back, and
Shift-click takes out any one of them.

## PDF pages as images

`pdf-image-editor.js` manages a local batch session opened from the PDF frame's
toolbar. PDF parsing stays inside the existing opaque sandbox. Its narrow
`image-render`/`image-rendered` bridge returns a PNG and page dimensions for one
requested page; `image-cancel` cancels outstanding rendering. Requests and replies
validate page numbers, resolution, dimensions and blob sizes. Raster requests
are capped at 16 megapixels and 8192 pixels per side; thumbnail requests render
only to 144 pixels. At most two raster requests are active (an editor page and
one visible thumbnail). The sandbox and CSP permissions do not change.

The ordinary image editor supplies pending tool recipes and PNG snapshots.
`image-batch.js` scales complete masks, including brush geometry and flood-fill
spans, with a canvas transform. It uses the same `inpaintPatch` function and
background compositing as single-image editing. Models process one page at a
time; cancellation aborts the frame request and terminates model workers. Each
page error is recorded independently. The session retains PNG blobs, one decoded
editor page, lazy thumbnails, and a single previous batch for Undo. Selections
are limited to 200 pages and edited/output image blobs to 256 MiB per set.

**Merge PDF** appends pages from one or more local PDFs through additional
opaque PDF frames. **Add image** decodes local images into new image pages;
image dimensions use 96 DPI for the initial physical page size. Imports are
atomic, cancellable, and bounded by the existing page, pixel, and byte limits.
The thumbnail sidebar supports dragging pages before or after another page.
Stable page identities retain edits and operation history
when order changes; ranges and page labels refer to the current document order.
Exports follow that order. **Undo page change** restores the last import or
reorder, independently of batch undo. Removing an imported PDF releases its
sandbox. These features
use the editor's existing raster PDF output; text and links are not retained.

`image-export.js` writes stored ZIPs with CRC-32 and UTF-8 names, or raster PDFs
with JPEG XObjects and byte-counted xref offsets. PDF page sizes follow the
source geometry, adjusted for page crops/resizes. JPEG and PDF exports flatten
alpha on white; PNG and WebP preserve it. Downloads use the topmost open dialog
so nested PDF editing sessions can download while their source preview is inert.
The source file is never uploaded or overwritten by this workflow.

`test/image-batch.test.mjs` covers ranges, mask scaling, ZIP records/CRC and PDF
offsets. `test/browser-check.sh IMAGE --group pdf-images` exercises real models,
different page sizes, excluded pages, per-page errors, cancellation, batch Undo,
all export formats and reopening the rebuilt PDF. `--group pdf-assembly`
checks PDF/image insertion, thumbnail reordering, page-change undo, failed
imports, resolution changes, and assembled export order independently. The
full PDF image group also runs these assembly checks. It also runs with the `pdf`,
`previews` and full browser suites.
