# Remote browser (`/go`) implementation plan

Implement a remote browser, served at `<base>/go`: [Moli](https://github.com/lexmount/moli), a headless browser engine, loads and runs each page on the TabTop host inside a sandbox, and the client displays a sanitized rendering of the resulting DOM. All destination traffic leaves from the TabTop host, and everything between the client and TabTop travels through TabTop’s authenticated E2E tunnel.

Moli was chosen after two rounds of hands-on comparison: Lightpanda against Kitesurf, then Lightpanda against Moli and Obscura (section 0). Moli supplies page loading, script execution, and the DOM. The session handling, sandbox, egress control, transport, and client renderer remain TabTop’s work.

## 0. Goals, decision, and evaluation results

### Goals

- Read and interact with web pages from a client that should not contact the destination directly: all destination traffic leaves from the TabTop host, through the E2E tunnel.
- Keep website code away from TabTop’s session, tunnel, files, and host, even when the website is hostile.
- Make unsupported features visible rather than silently broken.

### Target page classes

Compatibility is measured against these:

1. Static and documentation sites (HTML/CSS, images, fonts, anchors).
2. Pages with progressive enhancement: menus, tabs, disclosure widgets, client-side search.
3. GET/POST forms (search boxes, basic submissions).
4. Interactive pages and internal tools whose scripts use common DOM APIs, `fetch`, and WebSocket.
5. Moderate single-page applications, as far as Moli supports them.

### Non-goals

- Content that cannot be carried by a DOM snapshot: `canvas` drawing, WebGL, WebRTC; video and audio a site’s own player streams (Media Source), as YouTube’s does. Video and audio with a file to play are played (section 6).
- Logins and persistent destination sessions until Phase 3 decides cookie handling (see section 4).
- Service workers and browser extensions. Embedded pages (iframes) are shown as view-only copies (section 6), not as frames of their own.
- Filesystem access for pages.

### Decision

**Moli, driven over CDP, with a DOM snapshot rendered by the client.** Recorded 17 November 2026 after the second comparison round below. It replaces Lightpanda, chosen earlier the same day after the first round.

Reasons, from the measurements:

- **Containment equal to Lightpanda’s** in the same sandbox and egress proxy: every private, metadata, and loopback probe refused at the proxy, including WebSocket; no direct connection reached a loopback service; sandbox escape probes blocked.
- **CDP DOM mutation events** (`DOM.childNodeInserted`, `DOM.childNodeRemoved`). Changes are reported by the engine itself, not by an observer injected into the page’s process; an isolated-world observer also works as a fallback.
- **A built-in script watchdog** that ended a looping page after about 8 s while other CDP sessions kept working (Lightpanda’s took about 30 s).
- **MIT or Apache-2.0** at the user’s option, compatible with TabTop’s Apache-2.0; Lightpanda is AGPL-3.0.
- **Coordinate input fails loudly**: without layout, `Input.dispatchMouseEvent` is refused with an explicit error instead of hitting an element chosen from approximate boxes.
- No telemetry observed: every host in the proxy log during Moli’s runs was one the pages themselves contacted.

Accepted costs:

- About twice Lightpanda’s memory after the same pages (109 MB against 57 MB; peak 160 MB against 85 MB), and slower on some pages (Wikipedia about 1 s against 0.1 s).
- A 112 MB binary that also needs fontconfig, freetype, libpng, brotli, bzip2, expat, zlib, and libstdc++ from the system.
- CDP over TCP only. In sandboxed mode a bridge connects it to a Unix socket outside the sandbox’s network namespace. In unsandboxed override mode it listens on host loopback without authentication (section 3).
- A young, fast-moving, vendor-driven project (Lexmount also sells a hosted product); pin releases.
- A default Docker container cannot run the sandbox (section 3, “Sandbox modes”).

### Round 2 results: Lightpanda, Moli, Obscura

Tested 17 November 2026 on an x86_64 Debian host (6 cores, 11 GB RAM). Each engine ran inside the same bubblewrap sandbox with CDP and egress bridged out to Unix sockets and all traffic through a logging egress proxy that enforced the destination policy (`CONNECT` included), driven with Puppeteer over CDP. Engines were release binaries verified against their published SHA-256: Lightpanda 1.0.4, Moli 1.1.25, Obscura 0.2.7 (`x86_64-linux-no-render`, no stealth). The harness lived outside the repository, under `~/.cache/tabtop-eval2/` on the test machine.

| | Lightpanda 1.0.4 | **Moli 1.1.25** | Obscura 0.2.7 |
|---|---|---|---|
| Start-up to CDP ready | 52 ms | 35 ms | 38 ms |
| Memory idle / after all sites (peak) | 12 / 57 MB (85) | 14 / 109 MB (160) | 23 / 59 MB (98) |
| Six real sites | All loaded, no page errors | Same | Same |
| Load times: Wikipedia, GitHub, Hacker News | 0.09 s, 1.4–3.6 s, 0.7 s | 1.0–1.2 s, 2.4–3.4 s, 0.7 s | 0.2–0.7 s, 0.8–3.7 s, 0.9 s |
| TodoMVC React: renders, typing adds a to-do | Yes | Yes | Yes |
| Click by node ID, `preventDefault` reported | Yes | Yes | Yes |
| `Input.dispatchMouseEvent` | Accepted (approximate layout) | Refused: “requires layout hit testing” | Accepted |
| CDP DOM mutation events | None | `childNodeInserted`, `childNodeRemoved` | None |
| Isolated world | Isolated | Isolated | **Not isolated**: page globals visible, page’s replaced `MutationObserver` threw inside it |
| WebSocket to a public echo server | Works, through the proxy | Works, through the proxy | **Fake**: reports `open`, no connection made anywhere |
| Private, metadata, loopback (all spellings), `file://` probes | All refused | All refused | All refused |
| Requests reaching a loopback service directly | None | None | None |
| Infinite-loop page | Other sessions answer; engine watchdog ends it after ~30 s | Other sessions answer; engine watchdog ends it after ~8 s | Other sessions answer; still running at 30 s |
| Memory-exhaustion page | Killed at the cgroup limit (512 MB) | Same | Same |
| CDP transport | Unix socket or TCP | TCP | TCP, with a strict `Host` header check |
| Size and dependencies | 75 MB; libc, libm | 112 MB; font and image libraries (above) | 113 MB in two binaries; libc, libgcc |
| License | AGPL-3.0 | MIT or Apache-2.0 | Apache-2.0 |
| Telemetry | On by default | None observed | None observed |

Load times varied between runs with network conditions; the ranges come from two or three runs per engine.

### Round 1 results: Lightpanda and Kitesurf

Same host and sandbox, harness under `~/.cache/tabtop-eval/` (since deleted). Lightpanda was chosen in this round and later replaced by Moli.

| | Lightpanda 1.0.4 | Kitesurf at `39feadf` on `workerd` 2026-09-11 |
|---|---|---|
| Start-up to CDP ready, sandboxed | 41 ms | 273–650 ms |
| Memory, idle / after sites | 12 MB / 108 MB after six sites | 189 MB / 579 MB after the fixture and two sites |
| Load times | example.com 44 ms, Wikipedia 99 ms, Hacker News 719 ms, GitHub 1.9 s | example.com 0.6 s, Hacker News 2.2 s, Wikipedia 4.0 s, GitHub 5.8–19 s |
| Output to the client | DOM | Vector scenes on a canvas |
| Infinite-loop page | Other sessions answer | Whole engine unresponsive, even with Kitesurf’s CPU and wall-clock caps set |
| Packaging | One binary | `workerd` with `--experimental`, a 35 MB bundle, 22 MB of assets, 16-minute Bazel build |
| License | AGPL-3.0 | Apache-2.0 |

Sandbox escape probes, in both rounds (a shell run in place of a compromised engine): reading the home directory, `/etc/passwd`, and the TabTop checkout, connecting to the host’s loopback, connecting directly to the internet or the metadata address, and seeing host processes were all blocked.

### Other observations

- **Proxy routing is complete for Lightpanda and Moli.** For Lightpanda, every request path — document, scripts, images, stylesheets, iframes, `fetch`, XHR, EventSource, `sendBeacon`, and WebSocket (as `CONNECT`) — went through the HTTP proxy for `127.0.0.1`, `localhost`, `[::1]`, `127.1`, `0.0.0.0`, and `[::ffff:127.0.0.1]` alike. For Moli, the same paths plus top-level navigation were checked in Phase 1 against tabtopd’s own proxy (`TestGoProxyWithMoli`): all refused, and the target service saw no request. (A first-round reading that Lightpanda bypassed its proxy for localhost was wrong: those probes used port 9, a Fetch “bad port” refused inside the engine.)
- **The proxy must check `CONNECT` targets.** A test proxy without that check let a page’s WebSocket reach a loopback service.
- **Moli does not fetch images, fonts, or media unless asked** (`--image`, `--font`, `-r`); scripts and stylesheets are fetched. Images and fonts for display come from the client’s resource broker (section 4).
- **Moli sends page beacons** (`sendBeacon`, analytics endpoints) that Lightpanda skips by default; they go through the proxy like any other request.
- **Moli honours `NO_PROXY` / `no_proxy` and `--http-no-proxy`**, which would bypass the proxy; the engine’s environment must not contain them.
- **HTTPS goes through `CONNECT` tunnels**, so the egress proxy sees host and port, not the full URL; destination policy still applies at dial time.
- **Memory stays allocated across sessions in one engine process**, which supports one disposable engine per browsing context.
- **Kitesurf runs page scripts natively in V8** inside `workerd` isolates, so it needed the same host sandbox; `workerd`’s README states it “is not a hardened sandbox”.
- **chromedp v0.23 changed to a generic API**; earlier spikes used v0.14.2. Phase 1 used neither: tabtopd has a small CDP client of its own (`gocdp.go`) over `github.com/coder/websocket`.

Not yet covered, carried into Phase 1:

- Running Moli in the sandbox without `/proc` — done at the start of Phase 1: it works (see section 3).
- A seccomp filter and a minimal filesystem view (the comparison bound all of `/usr` and `/etc/fonts` read-only).
- Form submission, navigation after following a link, attribute and text mutation events, and reliability over long interactive sessions.
- arm64: out of scope for the first release (CI builds and ships amd64 images only). The arm64 Moli is pinned and the arm64 seccomp filter type-checks, but neither has run on arm64; test both before shipping an arm64 image.

### Evaluated and not chosen

Recorded so they are not re-proposed without new information:

- **Lightpanda** (tested, both rounds): lighter and faster on some pages, CDP on a Unix socket, but AGPL-3.0, telemetry on by default, no CDP DOM mutation events, and a slower script watchdog. The fallback if Moli fails in Phase 1.
- **Obscura** (tested, round 2): WebSocket is fake (reports `open` without connecting), its isolated world is not isolated, and it emits no DOM mutation events, so it offers no tamper-proof way to stream page changes. Its built-in private-network block also blocks a proxy-reached loopback page unless `--allow-private-network` is set.
- **Kitesurf** (tested, round 1): slower, heavier, canvas-only, freezes entirely on a looping page, and depends on an experimental `workerd` feature. Revisit if open-source `workerd` enforces per-isolate CPU limits.
- **OxiBrowser** (reviewed, not tested): JavaScript in the Boa interpreter (expected to be much slower, as with Kitesurf), essentially one maintainer, inconsistent documentation, very fast release cadence.
- **Servo** (reviewed, not tested): a full rendering engine with SpiderMonkey and WebDriver Classic but no CDP; using it means writing a Rust embedding program, and its layout and painting would be wasted on a DOM-snapshot design. Reconsider only if `/go` switches to streaming pixels.
- **Static sanitized browser (no page JavaScript)**: most target classes need scripts.
- **Headless Chromium on the host**: heavy per-session host cost and a large dependency. The default image (`DESKTOP=xfce`) already offers Chromium on the streamed desktop for pages that need full compatibility.
- **QuickJS virtual browser** (page scripts in QuickJS/WASM on the client against a hand-written DOM): writing and maintaining the DOM and browser APIs is the dominant cost, and compatibility would remain narrow.

### Industry reference: Cloudflare Browser Isolation

[Cloudflare Browser Isolation](https://www.cloudflare.com/sase/products/browser-isolation/) gives each user a disposable, containerized headless Chromium, treated as compromised and destroyed after each session, and (per the [2020 S2 Systems acquisition post](https://blog.cloudflare.com/cloudflare-and-remote-browser-isolation/)) streams Chromium’s draw commands to a WebAssembly renderer in the user’s browser. Per-session disposal and controlled egress are the same baseline hardening this plan adopts in section 3. TabTop needs no TLS interception: the user enters the URL in `/go`, so the engine fetches it directly.

## 1. Architecture

```text
client: <base>/go — trusted UI
  ├─ Address bar, history, reload, stop, errors
  └─ Sandboxed rendering iframe
       ├─ Trusted rendering agent
       ├─ Sanitized DOM, with brokered images, stylesheets and fonts
       └─ Events by node ID → host; snapshot and mutations ← host
          ⇅ existing E2E tunnel
host: tabtopd
  ├─ Browser session manager (one Moli process per browsing context)
  ├─ CDP client ── Unix socket ── bridge ── Moli on 127.0.0.1 inside its sandbox
  │                                          (DOM mutation events; isolated-world observer as fallback)
  ├─ Egress proxy dialling through fetch.go’s address policy ← bridge ← all engine traffic
  └─ Resource broker for the renderer (images, stylesheets, fonts)
```

Keep session secrets, tunnel objects, and filesystem capabilities in the trusted UI. The rendering frame receives only serialized content and narrowly scoped messages.

E2E protects the client-to-TabTop connection. The engine or broker fetches the destination through HTTP or HTTPS; the destination and gateway see the requested content, and the destination sees the TabTop host’s IP address.

### Security layers and which one is load-bearing

- **Host containment (load-bearing):** the engine’s process sandbox, network namespace, and resource limits (section 3). A fully compromised engine must be unable to read TabTop’s files or state, reach tabtopd except through its CDP socket, or connect anywhere except the egress proxy. In the unsandboxed override mode (section 3) only the egress proxy remains, so it must check every request, `CONNECT` included.
- **Client containment (load-bearing):** the rendering iframe’s sandbox and CSP. Even with a completely broken sanitizer, snapshot content must be unable to reach the parent DOM, TabTop storage, the tunnel, or the network.
- **Frame navigation (load-bearing):** the frame's CSP doesn't limit navigation; the `/go` page's `frame-src 'self'` does. A link or script that sends the frame to another site is blocked (tested: no request leaves), the frame shows the browser's error page, and `go.js` puts its own document back. Messages from the frame carry a per-document token, so no other document in it is heard. Links in snapshots never keep their address (`href="#"`, the address kept by the agent), and `href` is denied by default on every other element.
- **Broker enforcement (load-bearing for "no direct traffic"):** the frame CSP permits no network origins at all — only `'self'` for the trusted renderer, `blob:`, and `data:`. A URL the rewriter misses fails to load rather than leaking a request.
- **Sanitizer and rewriter (correctness and defence in depth):** removes active content from snapshots and rewrites resource URLs to broker-backed `blob:` URLs. A sanitizer bug should cause broken rendering, not an escape or a leak; tests confirm this by disabling the sanitizer and checking that the layers above still hold.

## 2. Reuse existing TabTop components

Build on:

- `tabtopd/tunnel_routes.go`: authenticated request dispatch.
- `tabtopd/tunnel_request.go`: request envelopes and streamed responses.
- `tabtopd/fetch.go`: `newFetchClient` and `fetchPolicy`/`fetchAllowed`, which already check the address on the socket actually opened (covering DNS rebinding, redirects, and odd spellings of local hosts), block this machine’s addresses, link-local and cloud metadata ranges, and use no proxy. The egress proxy and the resource broker must both dial through this policy, not a new one.
- `tabtopd/preview_resource.go`: per-request limits, slot limiting (`previewResourceSlots`), redirect handling, and the `WEB_GO_FETCH=0` off switch.
- `tabtopd/preview-html-resources.js` and `tabtopd/preview-css.js`: resource resolution and CSS rewriting for the renderer.
- `tabtopd/page_assets.go`: embedded assets and frame/worker CSP patterns.

Add dedicated browser routes rather than broadening `preview-resource`, whose accepted types and limits serve a different purpose.

**Do not reuse the existing preview frame settings.** `frameSandbox` (`page_assets.go`) and `sandboxFrame` (`preview-frames.js`) grant `allow-popups allow-popups-to-escape-sandbox`, and `directFrameCSP` allows `http:` and `https:` loads. Both would let page content bypass the broker. `/go` gets its own sandbox string (`allow-scripts` only), its own CSP constant, and its own frame helper, with a test asserting their exact values.

## 3. Engine service and host sandbox

### Moli as a component

- Pin a release (1.1.25 at the time of the comparison) and verify its published SHA-256 on install. Release archives exist for Linux x86_64 and aarch64 (glibc), macOS, and Windows.
- MIT or Apache-2.0, so it may be bundled in the image; keep its license files and `license-metadata.json` (Chromium BSD and Selenium notices included) with it. Install the system libraries it links against (fontconfig, freetype, libpng, brotli, bzip2, expat, zlib, libstdc++). `/go` reports itself unavailable when the binary is absent.
- Run as `moli serve --host 127.0.0.1 --port <port> --http-proxy http://<user>:<password>@127.0.0.1:<proxy-port> --user-agent <fixed> --layout` with no `--image`, `--font`, `--resource`, `--cookie-jar`, or `--profile-dir`, and with no `NO_PROXY`/`no_proxy` in its environment. `--block-private-networks` is not used: it applies only to directly connected targets, and all targets go through the proxy.
- `--layout` (added after Phase 2) gives pages real sizes and places, so a page that measures itself (a menu placed under its header) works. The engine’s window is the person’s frame: its size and pixel ratio come with each navigation and with each resize (`{"op":"viewport",…}`), set with `Emulation.setDeviceMetricsOverride`; `screen` is the person’s window (the `/go` page’s, which the frame is within), so a page sizing itself to the display does so to what they see, and their own screen isn’t told. A device with touch (`navigator.maxTouchPoints`) has the page told so too (`Emulation.setTouchEmulationEnabled`: `ontouchstart`, `maxTouchPoints`), as a page offers touch screens what it offers them. Moli computes layout once a page loads and again at the next CDP evaluation after a script changes the page (every act and change poll is one); a resize alone doesn’t, so a one-pixel `Page.captureScreenshot` follows it (3 ms). Geometry is close, not exact: the engine has its own fonts (DejaVu in the image) and loads no web fonts or pictures. Moli’s `IntersectionObserver` never reports anything visible, with or without layout, so `/go` answers it from the person’s browser instead (below). Measured with it: the same elements and pictures on the real sites as without; 60 pages in one tab, the engine at most 259 MiB and tabtopd 150 MiB, about 15% slower in all. Sites learn the window’s size and pixel ratio, where before every tab looked 1920×1080.
- No telemetry was observed; Phase 1 confirms this from the egress proxy log over longer sessions.

### Lifecycle

- One Moli process per browsing context, started on `browser-open`, killed on `browser-close`, logout, session expiry, tunnel loss, or idle timeout. No engine state outlives its context. Start-up measured at 35–77 ms, so there is no need to pool engines.
- Moli’s own watchdog ends a looping script after about 8 s. tabtopd’s watchdog is the outer limit: it pings the engine over CDP and watches its CPU and memory, and kills an engine that stays over budget or stops answering.

### Sandbox modes

At start-up tabtopd probes whether bubblewrap can create its namespaces, and `/go` runs in one of three states:

1. **Sandboxed** (probe passes): the engine runs in bubblewrap as below.
2. **Unavailable** (probe fails, no override): `/go` reports that it is unavailable and why, and how to enable it.
3. **Unsandboxed** (probe fails and `WEB_GO_UNSANDBOXED=1` / `-go-unsandboxed` is set): the engine runs as a plain child process of tabtopd. tabtopd logs this at start-up and for each tab opened. Never chosen silently.

The override exists because most full TabTop containers are disposable. Its risks:

- A page that exploits a Moli or V8 bug runs native code with tabtopd’s user, files, and network access.
- Moli’s CDP listens on host loopback with no authentication (it checks only the `Origin` header), so any local process can drive the engine while it runs. tabtopd uses a random port per context; this is acceptable only for disposable containers.

Without an engine exploit, page traffic is still confined by the egress proxy: in the comparison, Moli sent every request path through `--http-proxy`, and a loopback service saw no direct connection.

Findings in Docker (Docker’s built-in seccomp profile and `docker-default` AppArmor, Debian trixie image):

- With default settings, bubblewrap cannot create any namespace, as root or as an unprivileged user.
- `--security-opt seccomp=unconfined` alone or `apparmor=unconfined` alone is not enough; both together are.
- Mounting a fresh `/proc` additionally needs `--security-opt systempaths=unconfined`. Moli runs without `/proc`, so the sandbox omits `--proc` and needs only the first two. Tested at the start of Phase 1 in a `debian:trixie-slim` container as an unprivileged user: Moli 1.1.25 loaded example.com and Wikipedia in the sandbox, without `/proc`, through the egress proxy.
- These options relax the whole TabTop container, not just the engine. A seccomp profile derived from Docker 26.1.5’s default — dropping its `CAP_SYS_ADMIN`-only restrictions on `clone`, `clone3`, `unshare`, `setns`, `mount`, and `umount2`, and allowing those and `pivot_root` — works in place of `seccomp=unconfined`. Docker’s `docker-default` AppArmor profile still blocks namespace creation with it, so `apparmor=unconfined` (or a host-loaded AppArmor profile) remains necessary. Phase 1 ships the seccomp profile and documents both routes.
- On hosts (lite installs) bubblewrap works without extra settings.

### Sandbox

The comparison used bubblewrap, which worked without root on the test host:

- `--unshare-all` (new user, PID, IPC, UTS, cgroup, and network namespaces), `--cap-drop ALL`, `--die-with-parent`, `--new-session`, `--clearenv`.
- A read-only view of the engine’s binary alone (not its directory, which could be someone’s home), the system’s libraries, fontconfig’s configuration, and CA certificates; a private `/tmp` capped at 256 MiB; the run directory read-only, holding only the CDP and egress sockets. tabtopd creates the CDP socket and hands it to the bridge as file descriptor 3, so the bridge needs no write access there. No access to `$HOME`, roots, tabtopd’s state or other sockets, or the X display.
- No `--proc`: Moli runs without it (tested on the host and in Docker).
- A seccomp filter (`goseccomp.go`), passed to bwrap as `--seccomp`: a denylist like Flatpak’s, built by tabtopd as classic BPF for the architecture it’s built for (x86-64 and arm64). It refuses keyrings, BPF, `userfaultfd`, `io_uring`, `perf_event_open`, `ptrace` and `process_vm_*`, new namespaces and mounts (including `clone` with a namespace flag; `clone3` gets `ENOSYS` so glibc falls back to `clone`), modules, kexec, clocks, and the TIOCSTI and TIOCLINUX ioctls; sockets are limited to Unix, IPv4, IPv6 and routing netlink; another architecture’s calls (x32) kill the process. The startup probe runs with the filter too. Tested: `unshare -U` and AF_ALG, AF_VSOCK and netfilter sockets work without the filter and are refused with it; Moli runs under it on the host and in the image.
- `/usr` stays bound whole, read-only: it’s the distribution’s public files, and narrowing it to the binary’s libraries would break with each Moli or Debian update for little gain.
- Confirmed in TabTop’s image (`GO_IMAGE=… test/go-check.sh`, also in CI): `tabtop-lite` with the seccomp profile and `apparmor=unconfined` runs `/go` sandboxed, every end-to-end check passing.

### Bridges

The engine’s network namespace contains only loopback. A small bridge inside the sandbox — tabtopd itself, run with a bridge subcommand and bound in read-only — forwards both ways:

- **CDP in:** a Unix socket in the run directory to Moli’s CDP port on `127.0.0.1`. tabtopd connects to the socket and sends the `Host` header Moli expects.
- **Egress out:** `127.0.0.1:<proxy-port>` (Moli’s `--http-proxy`) to the egress proxy’s Unix socket.

In unsandboxed mode there is no bridge: the proxy listens on loopback TCP with per-context credentials, and tabtopd connects to Moli’s CDP port directly.

### Shared HTTP cache

The engines share Moli’s HTTP cache (`--http-cache-dir`, `gocache.go`): one directory on disk (`~/.cache/tabtop/go-http-cache`, private to TabTop’s user), bound writable into each engine’s sandbox at `/cache` (or given as it is, unsandboxed), so a site’s scripts and stylesheets fetched in one tab are on disk for the next and survive restarts. Measured: GitHub in a fresh engine took 23 of its 105 requests from it, its document ready 0.5 s sooner; `TestGoCacheWithMoli` has a second engine load a page without asking for its script or stylesheet again. Moli doesn’t bound it; tabtopd prunes it to 512 MiB, the entries used longest ago first, at start-up and as tabs close (at most once a minute). `WEB_GO_CACHE=0` (`-go-cache=false`) turns it off.

Chosen with its costs, which a per-tab engine didn’t have: the engines write it themselves, so one taken over by a page could change what’s cached for another site, which later tabs then run (its compromise outliving its tab), or fill the disk through it between prunings; and Moli keys entries by address alone, not partitioned by the site that asked as browsers now are, so a site can time another site’s resources to learn whether they were fetched before. A cache tabtopd itself fills, read-only to the engines, was considered and set aside for now (it relies on Moli’s cache format and re-fetches without cookies).

### Resource limits

Memory is capped by `RLIMIT_DATA`, which V8 tolerates where it doesn’t tolerate `RLIMIT_AS`. The bridge sets it on itself just before starting the engine, which inherits it; unsandboxed, tabtopd still starts the engine through the bridge, forwarding nothing, for this. Measured in Phase 1: Moli needs at least 640 MiB to start (512 MiB crashes it); with the default 1 GiB, a page allocating as fast as it can was stopped at a 473–479 MB peak, on the host and in Docker, sandboxed and not. A 1-second watchdog alone let the same page reach 1.2–1.46 GB first. The watchdog’s resident-memory check remains a second layer.

The sandbox’s `/tmp` is a tmpfs capped at 256 MiB (`--size`). Moli keeps cookies and IndexedDB in `TMPDIR` (`moli-storage-*`) when it has no profile; unsandboxed, `TMPDIR` is inside the run directory, removed when the engine is killed (Moli deletes it only on a clean exit).

The comparison used a systemd user scope (`systemd-run --user --scope -p MemoryMax=… -p MemorySwapMax=0 -p CPUQuota=100% -p TasksMax=…`), which killed a memory-exhaustion page at the limit without affecting anything else. Containers usually have no systemd, so the portable floor is tabtopd’s own watchdog: it polls each engine’s resident memory and CPU time and kills it over budget, and caps the number of live engines (3 per login, 8 in all). CPU counts only while nobody is using the tab: each message from the person restarts the 60-second window, since loading a heavy site legitimately takes more than a core for seconds (GitHub: 3.5 s of CPU in 3.3 s). The first long-session run, 60 real pages back to back, was killed as busy at page 23–29 before this; Moli itself idles at under 1% of a core after 25 heavy pages, so nothing was left running. Measured after the fix: 60 pages in one tab (Wikipedia, Hacker News, GitHub, MDN, DuckDuckGo), all shown, the engine at most 218 MiB resident, tabtopd 136 MiB. A cgroup limit is added where one can be created. Do not use `RLIMIT_AS`, which breaks V8’s address-space reservations.

### Egress proxy

The proxy handles plain proxied requests and `CONNECT`, and dials every connection through `fetch.go`’s address policy, checked on the socket actually opened:

- HTTP/HTTPS only; public destinations by default; private networks only when separately configured (a browser-specific flag alongside `-fetch-private`/`previewFetchPrivate`, defaulting off); loopback, link-local, metadata, and the host’s own addresses never.
- Ports 80 and 443 only, for `CONNECT` and plain requests alike (`goProxyPorts`), with the same address check for both. HTTPS and WebSocket pass through `CONNECT` tunnels, so rules are per host and port; URL-level rules apply only to plain HTTP.
- Plain requests are forwarded with the transport’s `RoundTrip`, so the engine sees and follows redirects itself, each one checked again.
- `WEB_GO_FETCH=0` disables `/go`.
- Per-context limits on connections, bytes, and request rate, since all traffic originates from the TabTop host’s IP. Done: 64 connections at once, requests and tunnels at 30 a second after a burst of 300, and 4 GiB in all, both ways, for the engine’s life (`goProxyBudget`); then requests get 429 and open tunnels close.
- Logging matching `fetch.go`: the destination host only, never the full URL.

## 4. Transport

One tunnel is one browsing context (`goroute.go`). The page opens it with the request `{"type":"go"}`; tabtopd starts an engine for it and answers `{"ok":true,"sandboxed":…}`, or fails with the reason (off, unavailable and why, too many tabs). The engine is killed when the tunnel closes, which also happens when the session ends or logs out and when the server stops. At most 3 engines run per session and 8 in all.

The page then sends JSON messages, each starting a new generation:

- `{"op":"navigate","url":…}`: HTTP or HTTPS with a host and no credentials; anything else is refused before the engine sees it.
- `{"op":"stop"}`.

History, back, forward and reload are kept by the page and sent as navigations. Phase 2 added `{"op":"event","gen":N,"kind":…,"id":…}` (addressed by node ID), `{"op":"dialog",…}` and `{"op":"resync","gen":N}`, and the replies `go-changes`, `go-url`, `go-dialog` and `go-file`; `goroute.go`’s header lists them all.

The server answers per generation:

- `{"type":"go-loading","gen":N,"url":…}`
- `{"type":"go-snapshot","gen":N,"url":final,"base":…,"title":…,"doc":tree}`, once the page’s document is ready (`Page.domContentEventFired`, or `Page.loadEventFired` if that comes first, after its `Page.frameNavigated`; what it does until it’s loaded comes as changes), at once for a navigation within the document, or after 30 s with what has loaded.
- `{"type":"go-error","gen":N,"message":…}`

Messages for a generation older than the newest are dropped on the server. Snapshot nodes are `{"i":id,"t":type,"n":name,"v":text,"a":[name,value,…],"c":[…]}`, read by the agent in an isolated world (section 6); the server leaves out scripts, `noscript`, templates, comments, doctypes, and every `on…` attribute, as defence in depth before the client’s sanitizer. A snapshot larger than 16 MB is an error, not a partial page. The page may send at most 64 KiB per message.

Run directories left by a tabtopd that died (each holds an `owner` file with its tabtopd’s process ID) are removed at start-up.

The broker (`goresource.go`) fetches images, stylesheets, and fonts for the renderer. They come over the tab’s own tunnel (`goprefetch.go`): `{"op":"res","rid":N,"kind":…,"url":…}`, answered by a `go-res` header (size and type, or an error) and the bytes in binary messages of up to 256 KiB that start with the request’s number, so they go between the tab’s other messages. A separate `go-resource` request, with a tunnel of its own, is used only while the tab’s isn’t open: a new tunnel is a WebSocket and a key exchange, which cost about 80 ms a resource on the same machine and several round trips on a distant connection, more than the fetch.

As soon as a page’s snapshot is sent, the server fetches ahead what the page shown will ask for: its stylesheets, `<img>` pictures and inline styles’ pictures, and what the stylesheets use (imports four deep, `@font-face` sources as fonts, other `url()` and `image-set()` as pictures, as `go-frame.js` takes them), at most 300 a page. They’re kept in the tab (64 MiB, the oldest dropped; failures not kept); a request for one being fetched waits for it. Measured on the same machine, from the snapshot to the page shown with its styles and pictures, first visits: Wikipedia 2.6 s → 0.4 s, www.sg 5.0 s → 0.1 s, GitHub 3.9 s → 2.4 s (most of it its 7.6 MB of CSS, rewritten in the frame).

The resource broker enforces:

- The same `fetch.go` client and policy as the egress proxy.
- Header filtering: never forward TabTop credentials, cookies, authorization, or proxy headers. Send a fixed, generic User-Agent.
- Compression: accept gzip, deflate, and brotli, decompress on the server, and enforce the limit on decompressed bytes. The client receives identity-encoded bytes.
- Per-request limits on time, bytes, redirects, and decompressed size, and at most 8 broker fetches at once across all sessions, 4 of them for one session (its others wait without holding a slot). Per-context byte limits are left to Phase 3.
- Accepted resource types: images, stylesheets, and fonts only.

### Cookies

The engine keeps cookies in memory for the life of its context only; nothing is persisted (no `--cookie-jar` or `--profile-dir`), and the cookie jar is destroyed with the engine. The resource broker sends no cookies. Decided for the first release: signing in to a site works within a tab (its cookies last while the tab does), and nothing persists across tabs or restarts; pictures, stylesheets and fonts behind a login don’t show. Persistent logins are not a goal for now. Never inherit TabTop’s authentication.

## 5. Rendering and sanitization

Use a dedicated frame document with `sandbox="allow-scripts"` only — no `allow-same-origin`, `allow-popups`, `allow-forms`, `allow-top-navigation`, or `allow-modals`. Its only JavaScript is TabTop’s trusted rendering agent; page scripts run only in the engine. See [iframe sandbox behavior](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/iframe).

The frame CSP (a new constant, not `mdFrameCSP` or `directFrameCSP`):

```text
default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline' blob:;
img-src blob: data:; font-src blob: data:; media-src 'none'; connect-src 'none';
frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none';
```

No network origin appears anywhere, so remote content cannot load except through the broker. Establish a private `MessageChannel` after validating the frame handshake.

Snapshots and mutations from the engine are untrusted. Before rendering:

1. Drop scripts, inline handlers, `javascript:` and other unsafe URLs, refresh directives, frames (an iframe’s page is drawn as a view-only copy in a box instead, section 6), objects, embeds, `<base>`, and media elements.
2. Parse and rewrite CSS, including `@import`, `url()`, `image-set()`, and fonts.
3. Replace resource URLs with broker-backed `blob:` URLs, resolved against the document’s final URL.
4. Map engine node IDs to rendered elements, so events can be addressed back.

Apply the same checks to every mutation batch, not only the initial snapshot.

## 6. Interaction and DOM streaming

### Snapshot and mutations

- On each navigation, the snapshot is read by the agent (`goagent.js`) in an isolated world (`tabtop`), not `DOM.getDocument`, which leaves out whitespace-only text nodes (spaces between links went missing). The script numbers nodes in that world, so changes and events can use the same IDs, and reads forms as they are now.
- Changes come from a `MutationObserver` installed by the same agent (`goagent.js`) in the same isolated world, read in numbered batches; on a gap, an unknown ID or an oversized batch, the client asks for a full snapshot again. (Moli’s CDP DOM events carry CDP node IDs and skip whitespace nodes, so they can’t address the snapshot’s tree.)
- tabtopd polls for them (every 250 ms, every second once a page has been quiet for 10 s, and 300 ms after each thing the person does) instead of being signalled through a binding: in Moli 1.1.25, `Runtime.addBinding` with an `executionContextName` stops links within a page (`#fragment`) from navigating. Page scripts can neither see nor replace the agent.
- Moli emits no event for `history.pushState`; the agent’s batches carry the document’s URL, which the address bar follows. A fragment link emits `Page.navigatedWithinDocument`.
- Changes are serialized for the sanitizer, coalesced into batches, and subject to the per-context byte limits, since page scripts can produce mutations quickly.

### What the page observes (`IntersectionObserver`)

- `goobserve.js` replaces the page’s `IntersectionObserver` (with `Page.addScriptToEvaluateOnNewDocument`, before any of its scripts). `observe` and `unobserve` tell the agent, in its isolated world, by a DOM event on the element; the agent asks for those made before it started (as the page loaded) when it starts.
- The agent sends an observed element, with its options, once it’s one the shown copy has (snapshots carry them all, batches what’s new: `io` in `go-snapshot` and `go-changes`). tabtopd keeps only well-formed options (`goCleanIO`), at most 5,000.
- The frame observes the copy’s element with the browser’s own `IntersectionObserver`, which sees it as laid out and scrolled there, and sends what it sees, with the element’s box, its visible part and the root’s bounds as shown there (`{"op":"io","gen":N,"entries":[…]}`, in pieces of 500). Pages go by those places: YouTube loads a thumbnail only when its `intersectionRect` has a height, which the engine’s own 0×0 box for a picture it hasn’t fetched never has.
- tabtopd hands them to the page on the acts’ queue (callbacks may open a dialog), one handing over at a time, the newest per element kept meanwhile; the agent drops what repeats what was last handed over; callbacks run from a task of their own, as in browsers. It isn’t counted as the person’s doing, so a page that makes what it observes come and go can’t keep the idle watchdog off.
- Measured: YouTube’s channel page shows its thumbnails (18 of 35 pictures, those in view; none without). CNA, BBC News and The Verge load their lazy pictures either way. Sites learn which of their elements the person has scrolled to, as they would in a browser. A new observation reaches the person’s browser with the next batch of changes, up to a second on a quiet page.

### Embedded pages (iframes)

- An iframe is drawn in the copy as a box of its own (a shadow root, sized from its `width` and `height`, the page’s `iframe` rules rewritten to `[data-go-iframe]` so they apply to it), its page copied into it, sanitized as the page is, and `inert`: view-only. Pointer events over the box aren’t given to the engine, which would give them to the frame’s page at a place that needn’t be what’s shown (its size and scroll differ); its scripts run in the engine as they would in a browser.
- A frame of the page’s own origin (or `srcdoc`) is read by the agent in the page’s world, into the snapshot, as a document node (`t: 9`, with its base, checked as an http(s) address) under its iframe; its changes resend it whole.
- A frame of another origin, which the agent can’t see into, is read in an isolated world of its own (`goframes.go`): once a second the page’s frames are listed (`Page.getFrameTree`), a new one matched to its iframe (`DOM.getFrameOwner`, `DOM.resolveNode` into the agent’s world, then the agent’s number for it, which the copy must already have), and each new, navigated or changed one read again and sent whole after the page, as its iframe’s content (`{o: "c", i, c: [document]}`). A slow, looping or huge frame holds up nothing but itself; frames sent are budgeted at 4 MB a second a tab, at most 16 frames a page and 2 MB each, and a frame that changes every time is read less often, up to every 8 s. What its stylesheets and pictures need is fetched ahead against its own base.
- Only the page’s own frames are shown: a frame’s frames show as unavailable. A Cloudflare or other challenge in a frame shows, but can’t be answered. Measured: Bootstrap’s docs show their YouTube embed (309 KB, sent once); `TestGoFramesWithMoli` has a frame of another origin shown, changed and navigated.

### Audio and video

- The copy can’t play anything: its frame’s policy has no media, and it’s at an origin of its own, which the streaming service worker doesn’t serve. So, as the files page’s previews do (`preview-media.js`), a `<video>` or `<audio>` with a file to play (its `src`, or its first `<source>`’s) is drawn as a box, and the trusted `/go` page lays a native player over it (`go-media.js`), kept within the frame’s area and following the box as the copy scrolls or changes (the frame reports where its boxes are). The player’s file is read from the site by the server in 1 MiB ranges as it plays (`go-resource` `"media"`, with the remote browser’s address policy, its ports and its User-Agent; through the service worker, over the tunnel), so the site isn’t contacted from the device, and none of its script runs in the player. At most 8 players a page; a video’s poster is fetched as the page’s pictures are, and its box takes the video’s proportions once known (an empty box would have no height).
- The box follows the page’s player: a new `src` (or, with none, new `<source>`s) gets a player of its own, the last one stopped, as a feed that plays one video after another in the same element does; a player given a file only once scrolled to (none when the page was read) gets one then. The page starting or stopping its player (`play()`, `pause()`, its end) is reported by the agent (an `"m"` op, from `play`/`pause`/`ended`/`emptied` caught on the document) and done to the player here; a player with `autoplay` starts when made. If this browser won’t play it with sound unasked (its autoplay rules), it plays muted, for the person to unmute.
- A player whose source is a `blob:` URL is fed by the site’s own player (Media Source, as on YouTube): there’s no file to read, so its box says so. Those would need the player’s pixels streamed instead (a full engine with a media pipeline).
- The player’s parts come over the tab’s own tunnel (`{"op":"res","kind":"media",…}`, answered by `serveMedia` as a `go-resource` `"media"` request is), three parts asked for ahead of the one played (`go-media.js`), so the server’s fetch of one and its way to the browser overlap the next’s. Each part had come on a tunnel of its own, its connection and handshake first, one part at a time. Measured (November 2026) through a far link (`GO_LINK`, 50 ms each way, 2.5 MB/s; a 30 MB, 24 Mbit/s clip, `GO_VIDEO_URL`): 2.55 MB/s, the link’s, a part every 0.41 s, the whole clip in its 10 s and 15 s; before, 1.1 MB/s, 6.7 s of it played in 15 s, 19 stalls. Chrome’s own network throttling can’t measure this: it holds a WebSocket to well under the rate it’s set to.
- The `/go` page’s policy gains `media-src 'self'` and `worker-src 'self'`; the frame’s stays `media-src 'none'`. Measured: W3Schools’ HTML5 video page plays its clip (`mov_bbb.mp4`); the server’s fetch had been refused there as Go’s default User-Agent, which the broker’s replaces.

### Performance

Measured on the same machine, Wikipedia, GitHub, Hacker News and www.sg, before and after (November 2026):

- **The snapshot is read at DOMContentLoaded**, not the load event: 0.05–0.4 s sooner (Wikipedia’s document is ready at 0.37 s, loaded at 0.70 s).
- **Changes that come while the frame builds a page are kept** and applied once it’s shown, in order. They were dropped, so the next batch named nodes the copy never had, and the whole page was read and sent again (Wikipedia: a second 736 KB snapshot and rebuild). Re-reads after this: none in the measured run.
- **Large messages are compressed** (`sendLarge`): snapshots, change batches and frames from 16 KiB, raw deflate at its fastest, if they shrink by a tenth, as binary messages of request number 0 (resources’ bytes start with theirs); the page says it can decompress (`DecompressionStream`) when it opens the tunnel, and takes messages in order, a compressed one before what follows it. Wikipedia’s snapshot is 124 KB instead of 630 KB, GitHub’s 91 KB instead of 620 KB: on a distant connection, about half a second less a large page.
- **The frame keeps a tab’s resources and stylesheets**: blob URLs across pages (1,500 or 256 MiB, the oldest revoked), and each stylesheet as rewritten, by address (32 MiB), dropped with any blob it may use. A site’s pages no longer parse and rewrite its stylesheets each time: GitHub’s 7.6 MB of CSS, about 0.8 s, once a tab (its page built in 0.5 s on a second visit, from 0.9 s).
- **A new page is shown settled** (November 2026, YouTube): the page before stays in view (inert: what’s done to it is for a page the engine has left) while the new one is built out of view, its stylesheets waited for (12 s at most, from 5: on a slow link a page was shown unstyled, then restyled), then until it settles: no change for 300 ms while the engine has at most two requests going (`go-net`, from the engine’s `Network` events; a long poll or a beacon mustn’t hold it), 4 s at most. YouTube had been drawn three times, unstyled, then as its grey skeleton, then built; its skeleton came 8.5 s in and its content 3–5 s later, so it’s now shown once, built, or as the skeleton at the cap.
- **Batches for the page shown are drawn once a frame** (`requestAnimationFrame`), all of those that came in it, and what a batch adds is hidden until the stylesheets it brought have come (2 s at most), so content a script adds isn’t seen unstyled.
- Left as they are: the engine’s own loading (mostly the sites and the network), and the agent’s read (0.25 s of its own on Wikipedia, mostly Moli’s attribute access; more while the page’s scripts are still busy).

### What the page fetches (`data:` URLs)

- `gofetch.js` patches the page’s `fetch` for `data:` URLs (in the same `Page.addScriptToEvaluateOnNewDocument`, before any of its scripts). Engines fetch `data:` URLs themselves (XHR always has), but a page’s CSP forbidding them — `connect-src` without `data:`, typical of sites that never fetch `data:` — refuses the fetch before the engine’s is asked, and pages that do fetch `data:` (inline datasets, self-contained exports) break.
- Those fetches are answered in the page instead: the URL’s own bytes, decoded the way `data:` URLs are (the fetch standard’s data: URL processor), in a `Response`. No request is made, so there’s nothing for the page’s CSP or the engine’s proxy to refuse; every other URL goes to the engine’s fetch as before, and a `data:` fetch sends nothing anywhere, so the engine’s address policy is untouched.
- Workers aren’t covered: their globals are the engine’s to start, not the page’s documents, and a `data:` fetch there goes as it would in a browser.
- Measured with Moli 1.1.25: under the page’s `connect-src 'none'` it refuses a `data:` fetch (“blocked by Content Security Policy for `data`”); with the patch, base64 and percent-encoded `data:` URLs are answered, and a fetch of any other address still goes to the engine’s own `fetch`, which the page’s CSP still refuses (`TestGoFetchDataWithMoli`). XHR isn’t patched.

### Events

- The mouse and keys are given to the engine as a browser’s own input (`goinput.go`: `Input.dispatchMouseEvent`, `Input.dispatchKeyEvent`), so the page gets trusted events and the engine does what a browser does with them: a click from a press and release, a double click, a context menu, focus, Enter sending a form, Space pressing a button, Tab moving on; hover menus, buttons that listen only for the pointer, and the wheel work.
- A pointer event names the element under the pointer and where within it, as fractions across and down, since the copy is laid out by the person’s browser. The engine scrolls it into view if it must (`block: "nearest"`), lays out again with a one-pixel screenshot (`relayout`) (neither a scroll nor a change of class does), finds that place in it, or its middle if something else is there, and gives the input there. If neither is on it (the engine has something over it the copy left out, an iframe say), a press is done as before, by script, as a click on release. A press is given or scripted once, at the press; its release follows it; a press let go outside the frame, or the window left, is let go away from the page (not a click).
- What’s typed is typed in the copy and sent as the field’s value; keys go as `rawKeyDown`, which do what keys do but type nothing, except Enter in a one-line field, given with its text, which sends the form. The engine gives the key’s element the focus first, unless it’s the document itself. Clicks the copy makes from a key the engine was given (Enter, Space) aren’t sent again.
- Moves and the wheel go at most every 50 ms, the newest kept (the wheel’s turns added up), one at a time on the acts’ queue, dropped while a dialog’s open; presses and keys are never dropped for them. A press or key that opens a dialog waits for it (up to the dialog’s minute), and is never given twice.
- Where the person scrolls an element (or the page) to is given to the engine, the newest place every 100 ms, while scrolling follows their input (3 s of it): a swipe, a fling, a scrollbar or a key scrolls the copy, not the engine, and a page that goes by where it’s scrolled (a feed playing the video scrolled to) needs to see it. The agent scrolls the element there (`behavior: "instant"`) and, as Moli fires scroll events only as it renders (which it doesn’t), fires `scroll` itself if it moved.
- Touches are given as touch input (`Input.dispatchTouchEvent`), each finger as the element under it and where within it, as the mouse’s; their moves as the mouse’s, the newest every 50 ms. The engine makes a tap’s click itself and a swipe’s none (Moli, measured: a long swipe doesn’t click), so the mouse events the person’s browser makes from a touch aren’t sent as well; a tap the engine can’t be given is a scripted click, as a press is. Swipes still scroll the copy, given to the engine as scrolling (above); a page’s own swipe handling (a carousel) sees the touches.
- Drag and drop within the page is the engine’s: Moli drags from the mouse it’s given as a browser does (`dragstart` to `drop`, with the page’s data). The person’s browser doesn’t start its own drag of the copy (it would keep the mouse’s moves and release). What’s dragged in from outside (text, a link, HTML, at most 32 KiB) is given with `Input.dispatchDragEvent`: its kinds as it’s dragged over, itself when dropped, at the element and place under it; files aren’t (the remote browser takes no files: the person is told).
- Sites get pointer movement and key timing, as in a browser. Not covered: files dropped or chosen, typing by IME into the engine (the copy’s value is sent), and typing in `contenteditable` (the copy’s edits aren’t sent).
- Otherwise (and when the engine won’t take input) the agent does it in the engine (`__tabtop.act`): `click()`, the value set through the element’s own setter followed by `input` and `change` events, keys as `keydown`/`keypress`/`keyup` (Enter in a field sends its form, as browsers do), `requestSubmit()`. Acts run in order on their own queue, so a page’s dialog can’t hold up reads. Coordinate-based input (`Input.dispatchMouseEvent`) is not used: the shown copy is laid out by the person’s browser, not the engine, so places on it aren’t the engine’s. An SVG element (a button’s icon) has no `click()`, so it’s sent a click event, which reaches its button.
- `alert`, `confirm` and `prompt` stop the whole engine until answered (`Page.handleJavaScriptDialog`); they’re asked in the trusted UI, a modal dialog over the page (a prompt with its default, Cancel answering `null`), whether the page asks as it loads, from a frame or from an act. They’re answered by the engine’s dialog events, not by replacing the page’s functions: those answer synchronously, which only the engine stopped can wait for. One unanswered for a minute is answered (OK to an alert, no to a question); `beforeunload` is always let go. From a page’s second, the dialog offers “Don’t let this page ask again”: ticked, its later dialogs are answered by the server the same way, unasked, so a page asking in a loop (or on every key) can’t keep the person answering (as browsers stop a page’s dialogs); a new page may ask again. `window.open` and `target=_blank` load in the same tab (the new target is closed).
- A document Moli loads as text that isn’t one (a PDF, an archive) is recognised by the type in `Network.responseReceived` (Moli’s `document.contentType` says `text/html`, and its MIME types keep their parameters) and offered to save into Downloads.
- The engine performs any default action itself; resulting navigations and DOM changes come back as messages.
- Input values are sent with `input` and `change` events, so the engine’s form state matches what the user sees.
- Navigations always go through the trusted UI’s history and address bar, never through the frame.
- Downloads are reported to the trusted UI, which can hand them to the existing fetch-to-Downloads flow in `fetch.go` with user confirmation, naming the file’s host. That fetch (`from_go`) uses a client that may reach private networks only when both `WEB_GO_FETCH_PRIVATE` and `WEB_GO_PRIVATE` allow it: the site chose the address and may redirect the second request elsewhere.
- A dialog is attributed to the document that opened it (the dialog event’s URL, or the main frame’s last committed address), not to the address bar, which a popup loading in the tab may already have changed.
- The frame’s token is handed out once per frame document. A whole-document re-read (on a gap in changes, or a batch too large) happens at most once a second per tab, and at most 64 of the person’s acts wait for a page that isn’t taking them; more are dropped.
- An address in `/go/#<address>` loads at once only when this tab put it there (a reload, remembered in `sessionStorage`); from a link elsewhere it waits in the address bar for Enter.
- Unsupported features (canvas content, media streamed by a site’s own player, popups, file inputs) are rendered as placeholders and reported through diagnostics.

## 7. Delivery phases

The feature flag exists from the first commit, so incomplete phases ship disabled.

| Phase | Deliverable | Exit criterion |
|---|---|---|
| 0 | Engine evaluation — **done** (section 0) | Decision recorded: Moli |
| 1 | Engine service, host sandbox, bridges, egress proxy, resource broker, and `/go` UI with read-only rendering — **done**, with the seccomp filter (`goseccomp.go`). `goproxy.go`, `goengine.go`, `gobridge.go`, `gocdp.go`, `goroute.go`, `goresource.go`, `gopage.go`, `go.html`, `go.js`, `go-frame.js`; `scripts/go-seccomp/`; `test/go-check.sh` (end to end in headless Chrome with real Moli, files on and off) | Met: pages render with their stylesheets, imports, fonts and pictures through the broker; navigation, history, reload, stop, fragments; sandbox escape and egress tests pass on the host and in Docker; frame CSP and sandbox values tested; no request leaves the browser except to TabTop |
| 2 | Interaction: events by node ID, form input, changes from the agent’s observer — **done**. `gobrowser.go`, `goagent.js` | Met: clicks, typing, Enter, checkboxes, selects, GET and POST forms, `pushState` routes, dialogs, script redirects and popups, files, a page that never stops changing — on fixtures, end to end; generations owned by the server; 60 real pages in one session measured (section 3) |
| 3 | Compatibility and policy — **partly done**: downloads (a file the page leads to is offered to save into Downloads), unsupported features shown as notes (canvas, streamed media), cookies and logins decided (section 4), the proxy’s rate, byte and port limits (section 3), CSS custom properties’ `url()` rewritten. Measured on real sites: Wikipedia, Hacker News, GitHub, MDN, DuckDuckGo, and 60 pages in one tab. Open: a wider survey of target class 5 (single-page applications) | Target class 5 measured; cookie and login decision; stylesheet and resource-family decisions; downloads; diagnostics for unsupported features; rate limits tuned |
| 4 | Integration — **done** except the default. Moli in the image (`/opt/moli`, pinned with checksums for amd64 and arm64, licences beside it), bubblewrap and fontconfig; `WEB_GO_ENGINE` defaults to it; `docs/environment.md`; CI runs the real-engine tests and `go-check.sh` against the image | Moli packaged in the image with checksum, license files and system libraries; documentation; session cleanup; flag on by default — `WEB_GO` stays off by default until decided, since it needs the container's seccomp and AppArmor options |

## 8. Verification

Use local fixture sites and browser automation to verify:

- DOM rendering, mutations, events (including `preventDefault` on links and forms), form input, redirects, and resource resolution.
- No destination traffic leaves the client directly, including with the sanitizer and rewriter disabled (CSP alone must block it).
- Sanitizer bypasses through HTML, CSS, SVG, and mutation batches.
- Attempts from snapshot content to access the parent DOM, session storage, tunnel credentials, or files.
- From inside the engine sandbox: reading `$HOME`, roots, or TabTop state; reaching tabtopd sockets other than CDP; connecting to private, loopback, metadata, or host addresses directly, via the proxy, or via redirects and DNS rebinding. Include page requests to every spelling of localhost and WebSocket connections, and repeat the network checks in unsandboxed mode, where the proxy is the only barrier.
- Resource exhaustion: infinite loops (Moli’s watchdog, then tabtopd’s), memory growth (the cgroup limit or tabtopd’s watchdog kills it), process forks, oversized and compressed responses.
- Stale navigation generations are dropped by the server.
- Logout, session expiry, and tunnel loss kill the engine and delete its scratch directory.
- Exact sandbox and CSP values for the `/go` frame.
- No unexpected hosts: every destination in the egress proxy log belongs to the pages loaded.

## 9. Dependencies and references

| Project | Role | Notes |
|---|---|---|
| [Moli](https://github.com/lexmount/moli) | Page engine | Rust, V8 (`rusty_v8`), html5ever, own DOM, Stylo cascade, optional layout; CDP, WebDriver Classic and BiDi; MIT or Apache-2.0; maintained by Lexmount |
| [coder/websocket](https://github.com/coder/websocket) | WebSocket for tabtopd’s own CDP client (`gocdp.go`) | chromedp was used in the spikes but not adopted. Domains used: `Target`, `Page`, `DOM`, `Emulation`, `Runtime`, `Network` |
| [bubblewrap](https://github.com/containers/bubblewrap) / [nsjail](https://github.com/google/nsjail) | Engine sandbox | bubblewrap 0.12.0 worked unprivileged on the test host; in Docker it needs the options in section 3 |
| [Lightpanda](https://github.com/lightpanda-io/browser) | Fallback engine | See section 0 |
| [Obscura](https://github.com/h4ckf0r0day/obscura), [Kitesurf](https://github.com/cloudflare/kitesurf), [OxiBrowser](https://github.com/project-oxi/oxibrowser), [Servo](https://github.com/servo/servo) | Evaluated, not chosen | See section 0 |

The expected result is a contained engine, a sanitized client renderer, and TabTop’s E2E broker. Combining them does not by itself establish broad website compatibility or a secure isolation boundary; both must be demonstrated by the verification above.
