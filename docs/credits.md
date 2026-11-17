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
| [JetBrains Mono](https://github.com/JetBrains/JetBrainsMono), patched by [Nerd Fonts](https://github.com/ryanoasis/nerd-fonts) | The terminal's font, with its icons and status-line arrows (regular and bold, as WOFF2) | OFL 1.1 (the font); the Nerd Fonts patcher is MIT |
| [Kaitai Struct](https://kaitai.io/) and its [format gallery](https://formats.kaitai.io/) | Binary structure previews with links to source bytes | Runtime: Apache-2.0; each format has its own license, retained in `/opt/kaitai/sources`; compiler used only during the build |
| [ONNX Runtime Web](https://github.com/microsoft/onnxruntime) | Running image background removal in a browser worker | MIT; license and third-party notices in `/opt/background` |
| [MI-GAN](https://github.com/Picsart-AI-Research/MI-GAN) | Filling painted image regions to remove logos and objects, in a browser worker | MIT code and model weights; `/opt/inpaint/LICENSE.migan` |
| [U²-Net](https://github.com/xuebinqin/U-2-Net) (U2NetP) | Foreground masks for image background removal, using the ONNX weights distributed by [rembg](https://github.com/danielgatis/rembg) | Apache-2.0; license in `/opt/background/LICENSE.u2net` |
| [MobileSAM](https://github.com/ChaoningZhang/MobileSAM) and [Segment Anything](https://github.com/facebookresearch/segment-anything) | Magic select in image inpainting: the object at a click, or in a box, in a browser worker. The ONNX exports are [Acly's](https://huggingface.co/Acly/MobileSAM) | Apache-2.0 weights (`/opt/segment/LICENSE.mobilesam` and `LICENSE.segment-anything`); Acly's ONNX export repository is tagged MIT |
| [iced-x86](https://github.com/icedland/iced) | x86, x86-64 and 16-bit disassembly in the hex preview's data inspector, and the encoding behind assembling an edited line there (its WebAssembly decoder, formatter and encoder, run in a worker) | MIT (its licence in `/opt/disasm/LICENSE.iced`) |
| [fARM64](https://github.com/binsnake/fARM64) | ARM64 disassembly in the hex inspector, and the encoding behind assembling an edited ARM64 instruction there (its decoder, formatter and encoder, run as WebAssembly in a worker) | MIT (`/opt/disasm/LICENSE.farm64` and `NOTICE.farm64`) |
| [Capstone.js](https://github.com/AlexAltea/capstone.js) and [Capstone](https://www.capstone-engine.org/) | ARM32 and Thumb/Thumb-2 disassembly in the hex inspector, run as WebAssembly in a worker; a build with ARM64, MIPS and RISC-V checks fARM64 and tabtop's own MIPS and RISC-V disassemblers when the image is built, and isn't in it (the table of MIPS instructions was first drawn up from what it shows), and is where the list of ARM64 system register names (`scripts/disasm/arm64-asm/src/sysreg_names.rs`) is drawn from | BSD-3-Clause and LLVM notices (`/opt/disasm/LICENSE.capstone-js`, `LICENSE.capstone`, `LICENSE.capstone-llvm` and `CREDITS.capstone`) |
| [rustc-demangle](https://github.com/rust-lang/rustc-demangle), [cpp_demangle](https://github.com/gimli-rs/cpp_demangle) and [msvc-demangler](https://github.com/mstange/msvc-demangler-rust) | The names of a program's Rust and C++ symbols as they were written, in the hex inspector (one WebAssembly module, run in a worker), with [bitflags](https://github.com/bitflags/bitflags), [itoa](https://github.com/dtolnay/itoa) and [cfg-if](https://github.com/rust-lang/cfg-if), which they use | MIT or Apache-2.0, used under MIT; msvc-demangler MIT and NCSA (LLVM's). Licences in `/opt/disasm/LICENSE.rustc-demangle`, `LICENSE.cpp_demangle`, `LICENSE.msvc-demangler`, `LICENSE.msvc-demangler-llvm`, `LICENSE.bitflags`, `LICENSE.itoa` and `LICENSE.cfg-if` |
| [pako](https://github.com/nodeca/pako) | Bounded zlib decompression in binary previews | MIT |
| [highlight.js](https://github.com/highlightjs/highlight.js) | The colours of text previews, and of code in Markdown previews, on the files page | BSD-3-Clause |
| [KaTeX](https://github.com/KaTeX/KaTeX) | Math in Markdown previews | MIT |
| [three.js](https://github.com/mrdoob/three.js) (`three`) | 3D previews of models and G-code, with the [fflate](https://github.com/101arrowz/fflate) module 3MF and AMF are unzipped with | MIT (`/opt/three/LICENSE.three`; fflate's MIT notice is in its file) |
| [Draco](https://github.com/google/draco), [Basis Universal](https://github.com/BinomialLLC/basis_universal), [meshoptimizer](https://github.com/zeux/meshoptimizer) (as three.js ships them) | Decoding compressed glTF: Draco meshes, KTX2 textures, meshopt buffers | Apache-2.0, Apache-2.0 (`/opt/three/LICENSE.decoders`), MIT (meshoptimizer's notice is in its file) |
| [chevrotain](https://github.com/Chevrotain/chevrotain) 9.0.1, with [regexp-to-ast](https://github.com/bd82/regexp-to-ast) (as three.js ships them) | Parsing VRML for its 3D preview | Apache-2.0, MIT (`/opt/three/LICENSE.decoders`) |
| [Khronos glTF Sample Assets](https://github.com/KhronosGroup/glTF-Sample-Assets) (Box; a Stained Glass Lamp texture) | Test models for compressed glTF (`test/data/3d/CREDITS.md`) | CC BY 4.0 |
| [pdf.js](https://github.com/mozilla/pdf.js) (`pdfjs-dist`) | PDF previews, with its OpenJPEG, JBIG2 and QCMS decoders and the Foxit and Liberation standard fonts it ships | Apache-2.0 (the decoders and fonts under their own licences, in `/opt/pdfjs`) |
| [Mermaid](https://github.com/mermaid-js/mermaid) | Diagrams in Markdown previews | MIT |
| [goldmark](https://github.com/yuin/goldmark) | Turning Markdown into HTML for previews, in tabtopd | MIT |
| [bluemonday](https://github.com/microcosm-cc/bluemonday) | Cleaning that HTML to plain formatting, in tabtopd | BSD-3-Clause |
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
| [SQLite](https://sqlite.org/) (libsqlite3) | Reading databases for their previews | Public domain |
| [libheif](https://github.com/strukturag/libheif) | Decoding HEIC pictures for their previews | LGPL 3.0 |
| [libde265](https://github.com/strukturag/libde265) (libheif's plugin) | Decoding HEIC pictures' HEVC | LGPL 3.0 |

The remote-login QR code is generated locally with [Nayuki’s QR Code Generator](https://www.nayuki.io/page/qr-code-generator-library), under the MIT license; its license is included in the vendored source.

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
