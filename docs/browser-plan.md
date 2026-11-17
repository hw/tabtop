# `/browser` implementation plan

Implement `/browser` as a remote browser: [Lightpanda](https://github.com/lightpanda-io/browser), a headless browser engine, loads and runs each page on the TabTop host inside a sandbox, and the client displays a sanitized rendering of the resulting DOM. All destination traffic leaves from the TabTop host, and everything between the client and TabTop travels through TabTop’s authenticated E2E tunnel.

Lightpanda (option D) was chosen in Phase 0 over Kitesurf (option E); the measurements and reasons are in section 0. Lightpanda supplies page loading, script execution, and the DOM. The session handling, sandbox, egress control, transport, and client renderer remain TabTop’s work.

## 0. Goals, decision, and Phase 0 results

### Goals

- Read and interact with web pages from a client that should not contact the destination directly: all destination traffic leaves from the TabTop host, through the E2E tunnel.
- Keep website code away from TabTop’s session, tunnel, files, and host, even when the website is hostile.
- Make unsupported features visible rather than silently broken.

### Target page classes (proposed — confirm before Phase 1 ends)

Compatibility is measured against these:

1. Static and documentation sites (HTML/CSS, images, fonts, anchors).
2. Pages with progressive enhancement: menus, tabs, disclosure widgets, client-side search.
3. GET/POST forms (search boxes, basic submissions).
4. Interactive pages and internal tools whose scripts use common DOM APIs and `fetch`.
5. Moderate single-page applications, as far as Lightpanda supports them.

### Non-goals

- Content that cannot be carried by a DOM snapshot: `canvas` drawing, WebGL, video and audio playback, WebRTC.
- Logins and persistent destination sessions until Phase 3 decides cookie handling (see section 4).
- Service workers, browser extensions, and nested browsing contexts initially.
- Filesystem access for pages.

### Decision

**Lightpanda, driven over CDP, with a DOM snapshot rendered by the client.** Recorded 17 November 2026 after the Phase 0 checks below.

Reasons, from the measurements:

- 3–40× faster page loads (Hacker News 3×, GitHub 3–10×, MDN 21×, Wikipedia 40×) and 5–15× less memory than Kitesurf on the same pages.
- The client receives a real DOM, so text stays selectable and accessible; Kitesurf sends vector scenes drawn on a canvas.
- A page stuck in an infinite loop does not stop the engine answering CDP, so the watchdog can see the problem and kill it. In Kitesurf on open-source `workerd`, one looping page froze the whole engine and its configured CPU and wall-clock caps were not enforced.
- One 77.6 MB binary with no build step, against `workerd` plus a 35 MB bundle and 22 MB of assets built with Bazel and nightly Rust, relying on a `workerd` feature marked experimental.
- Version 1.0 (October 2026), against a self-described proof of concept.

Accepted costs: Lightpanda is AGPL-3.0 (handled by keeping it an unmodified, optional, separately installed component; see section 3), it bypasses its HTTP proxy for localhost (contained by the network namespace; see section 3), and it does not emit CDP DOM mutation events (handled with an isolated-world observer; see section 6).

### Phase 0 results

Both engines were tested on 17 November 2026 on an x86_64 Debian host (6 cores, 11 GB RAM), each inside the same bubblewrap sandbox with all traffic through a logging egress proxy, using a local interactive fixture and six real sites (example.com, Wikipedia, Hacker News, TodoMVC React, GitHub, MDN). The harness lives outside the repository; its scripts and raw results were kept under `~/.cache/tabtop-eval/` on the test machine.

| | D: Lightpanda 1.0.4 | E: Kitesurf at `39feadf` on `workerd` 2026-09-11 |
|---|---|---|
| Start-up to CDP ready, sandboxed | 41 ms | 273–650 ms |
| Memory, idle | 12 MB | 189 MB |
| Memory after loading sites | 25 MB after the fixture; 108 MB (peak 116 MB) after six sites in one process | 579 MB after the fixture and two sites |
| Load times | example.com 44 ms, Wikipedia 99 ms, MDN 178 ms, Hacker News 719 ms, TodoMVC 912 ms, GitHub 1.9 s | example.com 0.6 s, TodoMVC 2.1 s, Hacker News 2.2 s, MDN 3.7 s, Wikipedia 4.0 s, GitHub 5.8–19 s |
| Compatibility on these pages | All loaded with no script exceptions; TodoMVC renders and typing adds a to-do | Same |
| Fixture interaction | DOM snapshot, click by node ID, `preventDefault` reported, page `fetch` and DOM update in 52 ms | Same, update in 95–121 ms |
| Output to the client | DOM | Vector scenes on a canvas |
| Egress | All page traffic through the proxy except localhost, which Lightpanda connects to directly (contained by the network namespace) | All traffic through the proxy, including localhost, as full URLs; the proxy makes the TLS connection |
| Private and metadata probes from page JavaScript | Refused by the proxy; localhost probes failed inside the empty namespace | Refused by the proxy |
| Infinite-loop page | Engine at 99% CPU, but a second CDP session still answered in 22 ms; kill took 5 ms | Whole engine unresponsive (no answer in 30–45 s), even with `KITESURF_PAGE_CPU_MS_CAP=2000` and `KITESURF_PAGE_WALL_MS_CAP=5000` |
| Memory-exhaustion page | Killed by the cgroup `MemoryMax` (512 MB); nothing else affected | Killed by the cgroup `MemoryMax` (1 GB) |
| CDP DOM mutation events | Not emitted (only `DOM.setChildNodes` and `DOM.documentUpdated`); an isolated-world `MutationObserver` reporting through `Runtime.addBinding` delivered every change and could not be reached or replaced by page scripts | `Page.createIsolatedWorld` and `Runtime.addBinding` supported |
| Packaging | One binary, 77.6 MB (x86_64), needs only libc and libm; CDP on a Unix socket (`--unix-socket`) | `workerd` with `--experimental` (Worker Loader “may change or go away”), a 35 MB bundle (10.7 MB gzipped), 22 MB of assets; 16-minute Bazel build |
| License | AGPL-3.0 | Apache-2.0 (Stylo MPL-2.0) |

Sandbox escape probes (a shell run in place of a compromised engine, same sandbox as both engines): reading the home directory, `/home`, `/etc/passwd`, and the TabTop checkout, connecting to the host’s loopback, connecting directly to the internet or the metadata address, and seeing host processes were all blocked. The sandboxed process saw 5 processes, ran with no capabilities, and shared only the run directory holding the CDP and egress sockets.

Other Phase 0 observations:

- **Layout is approximate in Lightpanda.** `DOM.getBoxModel` returned a 5×5 box for a button, so events must be addressed by node ID, not coordinates.
- **Memory stays allocated across sessions in one Lightpanda process** (108 MB after six sites), which supports one disposable engine per browsing context.
- **In `serve` mode, Lightpanda does not fetch images or stylesheets unless `--load-resources` asks for them**; scripts are always fetched. Images and stylesheets for display are fetched by the client’s resource broker instead (section 4). Pages whose scripts depend on computed styles may need `--load-resources stylesheet`, decided in Phase 3.
- **Lightpanda sends HTTPS through `CONNECT` tunnels**, so the egress proxy sees host and port, not the full URL, and cannot apply URL-level rules to HTTPS traffic. Destination address policy still applies at dial time.
- **chromedp v0.23 changed to a generic API**; the spike used v0.14.2. Choose and pin one for tabtopd in Phase 1.
- **Kitesurf runs page scripts natively in V8** inside per-page `workerd` isolates, with Boa (in WASM) only for generated code, so it needed the same host sandbox as Lightpanda. `workerd`’s README states it “is not a hardened sandbox”. Running Kitesurf in the client (E2) was ruled out because page scripts would run natively in a browser worker.

Not yet covered by Phase 0, and carried into Phase 1:

- Running the sandbox inside TabTop’s own container image (user namespaces and seccomp without extra privileges).
- A seccomp filter and a minimal filesystem view (the spike bound all of `/usr` read-only).
- Form submission, navigation events after following a link, and reliability over long interactive sessions.
- arm64.

### Evaluated and not chosen

Recorded so they are not re-proposed without new information:

- **Kitesurf (option E)**, Cloudflare’s experimental engine for Workers, self-hosted on `workerd`: works without a Cloudflare account and routes egress cleanly, but is slower, heavier, canvas-only, freezes entirely on a looping page, and depends on an experimental `workerd` feature (see the results above). Revisit if it matures and open-source `workerd` enforces per-isolate CPU limits.
- **Static sanitized browser (no page JavaScript)**: most target classes need scripts.
- **Headless Chromium on the host**: heavy per-session host cost and a large dependency. The default image (`DESKTOP=xfce`) already offers Chromium on the streamed desktop for pages that need full compatibility.
- **QuickJS virtual browser** (page scripts in QuickJS/WASM on the client against a hand-written DOM): writing and maintaining the DOM and browser APIs is the dominant cost, and compatibility would remain narrow.

### Industry reference: Cloudflare Browser Isolation

[Cloudflare Browser Isolation](https://www.cloudflare.com/sase/products/browser-isolation/) gives each user a disposable, containerized headless Chromium, treated as compromised and destroyed after each session, and (per the [2020 S2 Systems acquisition post](https://blog.cloudflare.com/cloudflare-and-remote-browser-isolation/)) streams Chromium’s draw commands to a WebAssembly renderer in the user’s browser. Per-session disposal and controlled egress are the same baseline hardening this plan adopts in section 3. TabTop needs no TLS interception: the user enters the URL in `/browser`, so the engine fetches it directly.

## 1. Architecture

```text
client: /browser — trusted UI
  ├─ Address bar, history, reload, stop, errors
  └─ Sandboxed rendering iframe
       ├─ Trusted rendering agent
       ├─ Sanitized DOM, with brokered images, stylesheets and fonts
       └─ Events by node ID → host; snapshot and mutations ← host
          ⇅ existing E2E tunnel
host: tabtopd
  ├─ Browser session manager (one Lightpanda process per browsing context)
  ├─ CDP client over a Unix socket ── Lightpanda in its sandbox
  │                                     └─ isolated-world MutationObserver → Runtime.addBinding
  ├─ Egress proxy dialling through fetch.go’s address policy ← all engine traffic
  └─ Resource broker for the renderer (images, stylesheets, fonts)
```

Keep session secrets, tunnel objects, and filesystem capabilities in the trusted UI. The rendering frame receives only serialized content and narrowly scoped messages.

E2E protects the client-to-TabTop connection. The engine or broker fetches the destination through HTTP or HTTPS; the destination and gateway see the requested content, and the destination sees the TabTop host’s IP address.

### Security layers and which one is load-bearing

- **Host containment (load-bearing):** the engine’s process sandbox, network namespace, and resource limits (section 3). A fully compromised engine must be unable to read TabTop’s files or state, reach tabtopd except through its CDP socket, or connect anywhere except the egress proxy. Phase 0 showed that the network namespace, not Lightpanda’s `--http-proxy`, is what stops localhost traffic.
- **Client containment (load-bearing):** the rendering iframe’s sandbox and CSP. Even with a completely broken sanitizer, snapshot content must be unable to reach the parent DOM, TabTop storage, the tunnel, or the network.
- **Broker enforcement (load-bearing for "no direct traffic"):** the frame CSP permits no network origins at all — only `'self'` for the trusted renderer, `blob:`, and `data:`. A URL the rewriter misses fails to load rather than leaking a request.
- **Sanitizer and rewriter (correctness and defence in depth):** removes active content from snapshots and rewrites resource URLs to broker-backed `blob:` URLs. A sanitizer bug should cause broken rendering, not an escape or a leak; tests confirm this by disabling the sanitizer and checking that the layers above still hold.

## 2. Reuse existing TabTop components

Build on:

- `tabtopd/tunnel_routes.go`: authenticated request dispatch.
- `tabtopd/tunnel_request.go`: request envelopes and streamed responses.
- `tabtopd/fetch.go`: `newFetchClient` and `fetchPolicy`/`fetchAllowed`, which already check the address on the socket actually opened (covering DNS rebinding, redirects, and odd spellings of local hosts), block this machine’s addresses, link-local and cloud metadata ranges, and use no proxy. The egress proxy and the resource broker must both dial through this policy, not a new one.
- `tabtopd/preview_resource.go`: per-request limits, slot limiting (`previewResourceSlots`), redirect handling, and the `WEB_FETCH=0` off switch.
- `tabtopd/preview-html-resources.js` and `tabtopd/preview-css.js`: resource resolution and CSS rewriting for the renderer.
- `tabtopd/page_assets.go`: embedded assets and frame/worker CSP patterns.

Add dedicated browser routes rather than broadening `preview-resource`, whose accepted types and limits serve a different purpose.

**Do not reuse the existing preview frame settings.** `frameSandbox` (`page_assets.go`) and `sandboxFrame` (`preview-frames.js`) grant `allow-popups allow-popups-to-escape-sandbox`, and `directFrameCSP` allows `http:` and `https:` loads. Both would let page content bypass the broker. `/browser` gets its own sandbox string (`allow-scripts` only), its own CSP constant, and its own frame helper, with a test asserting their exact values.

## 3. Engine service and host sandbox

### Lightpanda as a component

- Pin a release (1.0.4 at the time of Phase 0) and verify its published SHA-256 on install. Linux x86_64 needs glibc 2.35+, arm64 2.38+; Debian trixie meets both. No Alpine/musl support.
- Optional and separately installed, never bundled into the image by default, and never patched without a licensing decision: Lightpanda is AGPL-3.0 and TabTop is Apache-2.0. Running an unmodified Lightpanda as a separate process over CDP does not place TabTop under the AGPL; distributing it, or a patched version, carries AGPL source obligations. `/browser` reports itself unavailable when the binary is absent.
- Always run with `LIGHTPANDA_DISABLE_TELEMETRY=true`; telemetry is on by default.
- Run as `lightpanda serve --unix-socket <path> --http-proxy http://127.0.0.1:<port>`, adding `--block-private-networks` as an extra layer once confirmed compatible with the proxy.

### Lifecycle

- One Lightpanda process per browsing context, started on `browser-open`, killed on `browser-close`, logout, session expiry, tunnel loss, or idle timeout. No engine state outlives its context. Start-up measured at 41 ms, so there is no need to pool engines.
- A watchdog pings the engine over CDP and watches its CPU. A looping page keeps a core busy while CDP still answers, so the watchdog kills an engine that stays at its CPU limit beyond a page budget, as well as one that stops answering.

### Sandbox

Phase 0 used bubblewrap, which worked without root on the test host:

- `--unshare-all` (new user, PID, IPC, UTS, cgroup, and network namespaces), `--cap-drop ALL`, `--die-with-parent`, `--new-session`, `--clearenv`.
- A read-only view of the binary, its libraries, and CA certificates; a private `/tmp`; a run directory holding only the CDP and egress sockets. No access to `$HOME`, roots, tabtopd’s state or other sockets, or the X display.
- Phase 1 adds a seccomp filter and narrows the read-only binds from all of `/usr` to what the binary needs, and confirms both inside TabTop’s container image.

### Resource limits

Phase 0 used a systemd user scope (`systemd-run --user --scope -p MemoryMax=… -p MemorySwapMax=0 -p CPUQuota=100% -p TasksMax=64`), which killed a memory-exhaustion page at the limit without affecting anything else. Inside containers without systemd, use the cgroup directly or `prlimit`; do not use `RLIMIT_AS`, which breaks V8’s address-space reservations.

### Egress proxy

The engine’s network namespace contains only loopback. A small bridge inside the sandbox connects `127.0.0.1:<port>` (Lightpanda’s `--http-proxy`) to tabtopd’s egress proxy on a Unix socket bound into the sandbox.

The proxy handles plain proxied requests and `CONNECT`, and dials every connection through `fetch.go`’s address policy, checked on the socket actually opened:

- HTTP/HTTPS only; public destinations by default; private networks only when separately configured (a browser-specific flag alongside `-fetch-private`/`previewFetchPrivate`, defaulting off); loopback, link-local, metadata, and the host’s own addresses never.
- `CONNECT` only to ports 80 and 443 initially. HTTPS passes through `CONNECT` tunnels, so rules are per host and port; URL-level rules apply only to plain HTTP.
- `WEB_FETCH=0` disables `/browser`.
- Per-context limits on connections, bytes, and request rate, since all traffic originates from the TabTop host’s IP.
- Logging matching `fetch.go`: the destination host only, never the full URL.

## 4. Transport

Add authenticated tunnel operations such as:

- `browser-open`: create a browsing context and start its engine.
- `browser-navigate`: load a URL, go back or forward, reload, or stop; increments the context’s navigation generation.
- `browser-event`: deliver a user event (click, input with value, key, scroll, submit) addressed by node ID.
- `browser-resource`: fetch an image, stylesheet, or font for the renderer through the broker.
- `browser-close`: kill the engine and release context state.

The server streams to the client, per context and generation: the initial snapshot, ordered mutation batches, navigation and title changes, and diagnostics. Messages from an older generation are dropped on the server, and starting a navigation cancels the previous generation’s in-flight work.

The resource broker enforces:

- The same `fetch.go` client and policy as the egress proxy.
- Header filtering: never forward TabTop credentials, cookies, authorization, or proxy headers. Send a fixed, generic User-Agent.
- Compression: accept gzip, deflate, and brotli, decompress on the server, and enforce the limit on decompressed bytes. The client receives identity-encoded bytes.
- Per-request and per-context limits on time, bytes, redirects, concurrency, and decompressed size.
- Accepted resource types: images, stylesheets, and fonts only.

### Cookies

The engine keeps cookies in memory for the life of its context only; nothing is persisted (no `--cookie-jar`), and the cookie jar is destroyed with the engine. The resource broker sends no cookies. Whether logins are a goal, and whether cookies may persist across contexts, is decided in Phase 3. Never inherit TabTop’s authentication.

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

1. Drop scripts, inline handlers, `javascript:` and other unsafe URLs, refresh directives, nested frames, objects, embeds, `<base>`, and media elements.
2. Parse and rewrite CSS, including `@import`, `url()`, `image-set()`, and fonts.
3. Replace resource URLs with broker-backed `blob:` URLs.
4. Map engine node IDs to rendered elements, so events can be addressed back.

Apply the same checks to every mutation batch, not only the initial snapshot.

## 6. Interaction and DOM streaming

### Snapshot and mutations

- On each navigation, take the initial snapshot with `DOM.getDocument` (depth −1) or the document’s outer HTML.
- Lightpanda does not emit CDP DOM mutation events. Instead, create an isolated world (`Page.createIsolatedWorld`), add a binding (`Runtime.addBinding`), and run a `MutationObserver` in that world that reports batches through the binding. Phase 0 confirmed that page scripts can neither see nor replace the observer, and that every change arrived.
- The observer reports enough to rebuild changes on the client: node identities, attribute changes, text changes, and added subtrees serialized for the sanitizer. Its exact format is designed in Phase 2.
- Page scripts can still produce mutations quickly; the server coalesces batches and applies the per-context byte limits.

### Events

- The renderer cancels every native default action (following a link, submitting a form, toggling a control) and sends the event to the engine by node ID.
- tabtopd resolves the node (`DOM.resolveNode`) and dispatches a cancelable event on it (`Runtime.callFunctionOn`), which returns whether the page called `preventDefault()`. Coordinate-based input (`Input.dispatchMouseEvent`) is not used, because Lightpanda’s layout is approximate.
- The engine performs any default action itself; resulting navigations and DOM changes come back as messages.
- Input values are sent with `input` and `change` events, so the engine’s form state matches what the user sees.
- Navigations always go through the trusted UI’s history and address bar, never through the frame.
- Downloads are reported to the trusted UI, which can hand them to the existing fetch-to-Downloads flow in `fetch.go` with user confirmation.
- Unsupported features (canvas content, media, popups, file inputs) are rendered as placeholders and reported through diagnostics.

## 7. Delivery phases

The feature flag exists from the first commit, so incomplete phases ship disabled.

| Phase | Deliverable | Exit criterion |
|---|---|---|
| 0 | Evaluation of Lightpanda and Kitesurf — **done** (section 0) | Decision recorded: Lightpanda |
| 1 | Engine service, host sandbox (with seccomp and minimal binds, inside TabTop’s container), egress proxy, and `/browser` UI with read-only rendering | Target class 1 renders; navigation, history, reload, stop, cancellation; sandbox escape and egress tests pass inside the container; frame CSP and sandbox tests; no direct remote requests |
| 2 | Interaction: events by node ID, form input, isolated-world mutation streaming | Target classes 2–4 work on fixtures; engine-side `preventDefault` respected; stale generations dropped; long-session reliability measured |
| 3 | Compatibility and policy | Target class 5 measured; cookie and login decision; `--load-resources` decision; downloads; diagnostics for unsupported features; rate limits tuned |
| 4 | Integration | Optional install of a pinned Lightpanda with checksum, AGPL notice, documentation, session cleanup; flag on by default |

## 8. Verification

Use local fixture sites and browser automation to verify:

- DOM rendering, mutations, events (including `preventDefault` on links and forms), form input, redirects, and resource resolution.
- No destination traffic leaves the client directly, including with the sanitizer and rewriter disabled (CSP alone must block it).
- Sanitizer bypasses through HTML, CSS, SVG, and mutation batches.
- Attempts from snapshot content to access the parent DOM, session storage, tunnel credentials, or files.
- From inside the engine sandbox: reading `$HOME`, roots, or TabTop state; reaching tabtopd sockets other than CDP; connecting to private, loopback, metadata, or host addresses directly, via the proxy, or via redirects and DNS rebinding. Include page requests to `localhost`, which Lightpanda sends outside its proxy.
- Resource exhaustion: infinite loops (the watchdog kills the engine while CDP still answers), memory growth (the cgroup limit kills it), process forks, oversized and compressed responses.
- Stale navigation generations are dropped by the server.
- Logout, session expiry, and tunnel loss kill the engine and delete its scratch directory.
- Exact sandbox and CSP values for the `/browser` frame.
- Telemetry stays disabled: no traffic to Lightpanda’s telemetry endpoint appears in the egress proxy log.

## 9. Dependencies and references

| Project | Role | Notes |
|---|---|---|
| [Lightpanda](https://github.com/lightpanda-io/browser) | Page engine | Zig, V8, html5ever, own DOM; no graphical rendering; CDP and WebDriver BiDi; about 80% of Chrome’s WPT subtests per its 1.0 announcement; AGPL-3.0; telemetry on by default |
| [chromedp](https://github.com/chromedp/chromedp) / [cdproto](https://github.com/chromedp/cdproto) | Go CDP client in tabtopd | v0.23 introduced a generic API; Phase 0 used v0.14.2. Lightpanda implements only part of CDP; the domains used are `Page`, `DOM`, and `Runtime` |
| [bubblewrap](https://github.com/containers/bubblewrap) / [nsjail](https://github.com/google/nsjail) | Engine sandbox | bubblewrap 0.12.0 worked unprivileged on the test host; container support to confirm in Phase 1 |
| [Kitesurf](https://github.com/cloudflare/kitesurf) | Evaluated, not chosen | See section 0 |

The expected result is a contained engine, a sanitized client renderer, and TabTop’s E2E broker. Combining them does not by itself establish broad website compatibility or a secure isolation boundary; both must be demonstrated by the verification above.
