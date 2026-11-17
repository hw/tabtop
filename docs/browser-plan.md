# `/browser` implementation plan

Implement `/browser` as a remote browser: a headless browser engine loads and runs each page, and the client displays a sanitized rendering of the result. All destination traffic leaves from the TabTop host, and everything between the client and TabTop travels through TabTop’s authenticated E2E tunnel.

Two engines are candidates: **D, Lightpanda** and **E, Kitesurf**. Phase 0 chooses between them. Both are young projects, and neither ships the session handling, sandboxing, transport, or client renderer this plan needs; those remain TabTop’s work.

## 0. Goals, non-goals, and options

### Goals

- Read and interact with web pages from a client that should not contact the destination directly: all destination traffic leaves from the TabTop host, through the E2E tunnel.
- Keep website code away from TabTop’s session, tunnel, files, and host, even when the website is hostile.
- Make unsupported features visible rather than silently broken.

### Target page classes (proposed — confirm before Phase 0 ends)

Compatibility is measured against these:

1. Static and documentation sites (HTML/CSS, images, fonts, anchors).
2. Pages with progressive enhancement: menus, tabs, disclosure widgets, client-side search.
3. GET/POST forms (search boxes, basic submissions).
4. Interactive pages and internal tools whose scripts use common DOM APIs and `fetch`.
5. Moderate single-page applications, as far as the chosen engine supports them.

### Non-goals

- Content that cannot be carried by a DOM snapshot or scene: `canvas` drawing, WebGL, video and audio playback, WebRTC.
- Logins and persistent destination sessions until Phase 3 decides cookie handling (see section 4).
- Service workers, browser extensions, and nested browsing contexts initially.
- Filesystem access for pages.

### Options

| Option | Compatibility | Isolation | Cost | Status |
|---|---|---|---|---|
| **D. Lightpanda DOM snapshot**: Lightpanda (headless, V8, no rendering) on the host, driven by tabtopd over CDP; the client renders a sanitized DOM snapshot and its mutations | Most script-driven pages (about 80% of Chrome’s WPT subtests); gaps in CSS, editing, SVG; layout APIs approximate | Foreign code runs on the host in V8 with no process sandbox of its own; TabTop must supply one | Medium: CDP bridge, host sandbox, client renderer and sanitizer | Phase 0 candidate. Preferred if its host sandbox is acceptable. |
| **E. Kitesurf engine**: Cloudflare’s experimental browser engine (Boa JavaScript in WASM, Blitz/Stylo layout, Vello painting), either **E1** self-hosted beside tabtopd on `workerd`, or **E2** its Rust core compiled to WASM and run in a client worker | Unknown; full layout and partial CDP, experimental | E1: foreign code runs on the host, but inside WASM in a per-page isolate. E2: on the client, inside WASM in a worker | E1: medium. E2: high (effectively a fork) | Phase 0 candidate behind a short feasibility check. |

Phase 0 runs E’s feasibility check, then compares D and (if feasible) E on the target-class fixtures and records which one proceeds.

### Dropped alternatives

Recorded so they are not re-proposed without new information:

- **Static sanitized browser (no page JavaScript)**: dropped; most target classes need scripts.
- **Headless Chromium on the host**: dropped; heavy per-session host cost and a large dependency. The default image (`DESKTOP=xfce`) already offers Chromium on the streamed desktop for pages that need full compatibility.
- **QuickJS virtual browser** (page scripts in QuickJS/WASM on the client against a hand-written DOM): dropped; writing and maintaining the DOM and browser APIs is the dominant cost, and compatibility would remain narrow.

### D and E in detail

Figures are estimates or vendor claims, not measurements; Phase 0 replaces them with measured values.

| | D: Lightpanda DOM snapshot | E: Kitesurf engine (E1 host, E2 client) |
|---|---|---|
| Sites that work | Most script-driven pages; gaps in CSS, editing, SVG; layout APIs approximate | Unknown; experimental engine with full layout and partial CDP. Measure on the target-class fixtures |
| Where untrusted code runs | TabTop host, in V8, without a process sandbox of its own | E1: TabTop host, in Boa inside WASM, one Worker isolate per page. E2: client, in WASM inside a worker |
| If it is compromised | A V8 exploit runs on the server, contained only by the sandbox TabTop builds around it | E1: needs a Boa bug plus a WASM or isolate escape to reach the server. E2: confined to the client worker |
| What the client receives | Real, sanitized DOM (snapshot plus mutations): selectable, accessible, responsive | Probably a recorded scene of draw commands rasterized on the client (inferred from package names, unverified). E2 renders to a canvas: no selectable text or accessibility |
| Network leaks | Page fetching happens on the host; resources the client renders go through the broker and frame CSP | E1: fetching happens on the host, if its egress can be forced through `fetch.go`’s policy. E2: relies on the broker |
| Host load | Low to moderate: tens of MB per page (vendor benchmark: 123 MB peak for 100 pages versus 2 GB for Chrome) | E1: moderate; WASM interpreter per page, memory growth reported without `--expose-gc`. E2: low |
| Client load | Low to moderate: renderer only | E1: low to moderate (scene rasterizer). E2: high: full engine in WASM, interpreted JavaScript |
| Bandwidth | Low: serialized DOM, mutations, and brokered resources | E1: low to moderate (scenes). E2: low, plus a large one-time engine download |
| Lite build | Adds the Lightpanda binary (size unpublished; V8 is linked in, so likely tens of MB), installed separately | E1: `workerd` plus the engine. E2: probably several MB of WASM (Stylo, Blitz, Boa, Vello; estimate) |
| Engineering effort | Medium: CDP bridge, snapshot and mutation streaming, host sandbox, renderer and sanitizer | E1: medium: authentication, resource and egress sandbox, client scene renderer, `workerd` deployment. E2: high: separating the Rust core from Workers-specific code amounts to a fork |
| Ongoing upkeep | Fast-moving young project (1.0 in October 2026); pinned updates, including V8 security fixes | Experimental, weeks old, calendar-tagged releases; pin a tag and expect breaking changes |
| License | AGPL-3.0 (see below) | Apache-2.0 (Stylo dependency MPL-2.0) |

### Resources required

**D: Lightpanda DOM snapshot**

- Host disk: the Lightpanda binary (size unpublished; measure in Phase 0). Linux x86_64 and arm64 builds need glibc 2.35+ (x86_64) or 2.38+ (arm64); Debian trixie meets both. No Alpine/musl support.
- Host memory and CPU: tens of MB per page, one process per session; V8 can still spend a core on heavy scripts.
- Isolation work (mandatory, the main cost): see section 3.
- tabtopd side: a CDP client (`chromedp`) that navigates, serializes the DOM, streams mutations (via CDP `DOM.*` events or an injected `MutationObserver`), and dispatches events to elements by node ID rather than by coordinates (Lightpanda has only partial layout).
- Client: a sanitizing renderer in a sandboxed frame (section 5).
- Engineering: roughly 6–10 weeks for the CDP bridge, snapshot and mutation streaming, host sandbox, and renderer.
- Dependencies: Lightpanda (pinned release), `chromedp`, a sandbox tool (bubblewrap or nsjail).
- License: Lightpanda is AGPL-3.0; TabTop is Apache-2.0. Running an unmodified Lightpanda as a separate process over CDP does not place TabTop under the AGPL. Any patched Lightpanda must have its source offered to network users, and bundling it in the image distributes AGPL software with its source obligations. Keep it an optional, separately installed component, and do not patch it without a licensing decision.
- Telemetry is on by default; always run with `LIGHTPANDA_DISABLE_TELEMETRY=true`.
- Open questions for Phase 0: reliability over long interactive sessions (Lightpanda targets scraping and agents), CDP coverage for mutation streaming and event dispatch, start-up time per session, and binary size.

**E: Kitesurf engine**

[Kitesurf](https://github.com/cloudflare/kitesurf) describes itself as "an experimental browser engine that runs on Cloudflare Workers" that "parses HTML, applies CSS, runs page JavaScript, and renders screenshots without Chrome or a browser container." It exposes a partial CDP endpoint for Puppeteer. Page JavaScript runs in Boa inside WebAssembly; Blitz handles the DOM, layout, and painting, Stylo handles CSS, Parley and Vello handle text and graphics, and Krilla produces PDFs. Each page gets its own isolate through Cloudflare Dynamic Workers (the Worker Loader binding). It is built with Rust, TypeScript, Bazel, and Wrangler, licensed Apache-2.0 (Stylo is MPL-2.0), and was at tag `2026.11.9` (13 November 2026) when reviewed.

What it sends to clients and how input returns are undocumented; the `page-renderer` ("renderer for recorded page scenes") and `scene-host-wasm` packages suggest recorded draw scenes rasterized on the client. This is inferred from package names and must be confirmed from the source.

- **E1, on the host:** run Kitesurf on `workerd` (the open-source Workers runtime that `wrangler dev` uses) beside tabtopd. Foreign JavaScript stays inside WASM in a per-page isolate, so reaching the host needs a Boa bug plus a WASM or isolate escape — stronger than D’s native V8.
  - Host: `workerd` plus the engine; memory per page to be measured. The README reports local engines running out of memory after about 300 pages without `--expose-gc`, so per-session process recycling is required.
  - Isolation work: Kitesurf "has no authentication of its own", so it must listen only on a private socket reachable from tabtopd; otherwise as section 3.
  - Client: a scene renderer (Kitesurf’s, if usable in a browser) or, if a DOM can be extracted over CDP, the sanitizing renderer as in D.
  - Engineering: medium, mostly deployment, sandboxing, and the client renderer.
- **E2, on the client:** compile the Rust core (Boa, Blitz, Stylo, Vello) to WASM and run it in a client worker, with all fetches routed through the tunnel broker.
  - Keeps foreign code off the host entirely.
  - Output is a canvas: no selectable text, accessibility, or native scaling.
  - Client: probably several MB of WASM (estimate) and interpreted JavaScript; slow on phones.
  - Engineering: high. The core is not packaged for use outside Workers, so separating it from the Workers-specific TypeScript and Worker Loader code amounts to a fork.
- **Hard requirement:** E is acceptable only if it runs fully self-hosted. Any dependency on a Cloudflare account or Cloudflare-hosted services would send browsing through a third party and break TabTop’s self-hosted, E2E design.
- **Risks:** experimental and weeks old, partial CDP, active redesign likely; pin a tag. Its `SECURITY.md`, documentation site, client protocol, and `workerd` support for Dynamic Workers were not reviewed.
- **Feasibility check (Phase 0, one to two days):**
  1. Does it run on `workerd` without a Cloudflare account, including per-page isolates?
  2. Can all of its outbound traffic be forced through the egress proxy (section 3)?
  3. Can its Rust core build and run in a browser worker without Workers APIs?

  If 1 and 2 pass, evaluate E1 against D. If only 3 passes, evaluate E2 against D. If none pass, keep E as a reference only.

### Industry reference: Cloudflare Browser Isolation

[Cloudflare Browser Isolation](https://www.cloudflare.com/sase/products/browser-isolation/) is a commercial remote browser. Per its [developer documentation](https://developers.cloudflare.com/cloudflare-one/policies/browser-isolation/) and the [2020 S2 Systems acquisition post](https://blog.cloudflare.com/cloudflare-and-remote-browser-isolation/):

- Each user gets a disposable, containerized headless Chromium in Cloudflare’s network, treated as compromised and destroyed after each session.
- It streams Chromium’s Skia draw commands before rasterization ("Network Vector Rendering"), compressed and encrypted; a cached WebAssembly build of Skia in the user’s browser replays them. Input events go back to the remote browser.
- Isolation is applied by Gateway HTTP policies, with Cloudflare decrypting the user’s HTTPS traffic through its own root certificate.

The NVR details come from the 2020 post; the current product pages do not mention NVR, so the shipping product may differ.

What this means here:

- Per-session disposal and controlled egress are the baseline hardening for any host-side engine (section 3).
- Draw-command streaming from a patched Chromium is not realistic for TabTop; Kitesurf’s scene output (E1), if confirmed, is the closest available equivalent.
- TabTop does not need TLS interception: in `/browser` the user enters the URL, so the engine fetches it directly.

## 1. Architecture

Host-side engine (D and E1):

```text
client: /browser — trusted UI
  ├─ Address bar, history, reload, stop, errors
  └─ Sandboxed rendering iframe
       ├─ Trusted rendering agent
       ├─ Sanitized DOM (D) or scene (E1), with brokered resources
       └─ Events by node ID → host; snapshot and mutations ← host
          ⇅ existing E2E tunnel
host: tabtopd
  ├─ Browser session manager (one engine per browsing context)
  ├─ CDP client (chromedp) ── engine in sandbox (Lightpanda, or Kitesurf on workerd)
  ├─ Egress proxy using fetch.go’s client and address policy ← all engine traffic
  └─ Resource broker for the renderer (images, stylesheets, fonts)
```

Client-side engine (E2):

```text
client: /browser — trusted UI
  ├─ Kitesurf WASM core in a dedicated worker (page JavaScript, DOM, layout)
  │    └─ all fetches → resource broker → E2E tunnel → fetch.go’s client
  └─ Canvas output in the trusted UI; input events → worker
```

Keep session secrets, tunnel objects, and filesystem capabilities in the trusted UI. The rendering frame and any client-side engine receive only serialized content and narrowly scoped messages.

E2E protects the client-to-TabTop connection. The engine or broker fetches the destination through HTTP or HTTPS; the destination and gateway see the requested content, and the destination sees the TabTop host’s IP address.

### Security layers and which one is load-bearing

- **Host containment (load-bearing for D and E1):** the engine’s process sandbox, network namespace, and resource limits (section 3). A fully compromised engine must be unable to read TabTop’s files or state, reach tabtopd except through its CDP socket, or connect anywhere except the egress proxy.
- **Client containment (load-bearing):** the rendering iframe’s sandbox and CSP. Even with a completely broken sanitizer, snapshot content must be unable to reach the parent DOM, TabTop storage, the tunnel, or the network. For E2, the engine worker gets no network access except the broker.
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

## 3. Engine service and host sandbox (D and E1)

tabtopd owns the engine’s lifecycle:

- One engine process per browsing context, started on `browser-open`, killed on `browser-close`, logout, session expiry, tunnel loss, or idle timeout. No engine state outlives its context.
- A dedicated unprivileged user; a process sandbox (bubblewrap or nsjail) with a seccomp filter; a private, empty filesystem view apart from the engine binary and a per-context scratch directory deleted on exit. No access to `$HOME`, `/fs`, roots, tabtopd’s state, its sockets, or the X display.
- Its own network namespace whose only route is the egress proxy. The CDP connection to tabtopd uses a dedicated Unix socket or socketpair passed into the sandbox.
- External limits on memory, CPU, process count, and wall-clock time (cgroups or `prlimit`), plus a watchdog that kills an unresponsive engine.
- The engine’s own controls (Lightpanda’s `--block-private-networks` and `--block-cidrs`, telemetry disabled; Kitesurf’s isolates) are additional layers only, since they are enforced inside the untrusted process.

### Egress proxy

tabtopd runs an HTTP forward proxy (including `CONNECT` for HTTPS) reachable only from the engine’s namespace. Every connection is dialled through `fetch.go`’s client and address policy, so the engine gets the same destination rules as every other TabTop fetch:

- HTTP/HTTPS only; public destinations by default; private networks only when separately configured (a browser-specific flag alongside `-fetch-private`/`previewFetchPrivate`, defaulting off); loopback, link-local, metadata, and the host’s own addresses never.
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

For E2, the client engine’s fetches use the same broker with methods limited to GET and HEAD, plus POST with small bodies (for example, 1 MiB) under a per-session rate limit.

### Cookies

The engine keeps cookies in memory for the life of its context only; nothing is persisted, and the cookie jar is destroyed with the engine. The resource broker sends no cookies. Whether logins are a goal, and whether cookies may persist across contexts, is decided in Phase 3. Never inherit TabTop’s authentication.

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

For E1 with scene output, the renderer draws scenes to a canvas in the same sandboxed frame; DOM sanitization is replaced by validation of the scene format. For E2, the engine’s output is drawn in the trusted UI from a worker that has no network access.

## 6. Interaction and requests

- The renderer cancels every native default action (following a link, submitting a form, toggling a control) and sends the event to the engine. The engine dispatches it, runs page handlers, and performs any default action itself; resulting navigations and DOM changes come back as messages.
- Input values are sent with `input` and `change` events, so the engine’s form state matches what the user sees.
- Navigations always go through the trusted UI’s history and address bar, never through the frame.
- Downloads are reported to the trusted UI, which can hand them to the existing fetch-to-Downloads flow in `fetch.go` with user confirmation.
- Unsupported features (canvas content, media, popups, file inputs) are rendered as placeholders and reported through diagnostics.

## 7. Delivery phases

The feature flag exists from the first commit, so incomplete phases ship disabled.

| Phase | Deliverable | Exit criterion |
|---|---|---|
| 0 | Time-boxed evaluation (2 weeks) of D and E. First E’s one-to-two-day feasibility check; then a throwaway spike per remaining option running the interactive fixture: for D, sandboxed Lightpanda + chromedp + snapshot to a crude renderer; for E, E1 or E2 as the feasibility check allows | Decision between D and E recorded, with licenses, pinned revisions, measured fixture behaviour, start-up time, host and client memory, and the sandbox design |
| 1 | Engine service, host sandbox, egress proxy, and `/browser` UI with read-only rendering | Target class 1 renders; navigation, history, reload, stop, cancellation; sandbox escape and egress tests pass; frame CSP and sandbox tests; no direct remote requests |
| 2 | Interaction: events by node ID, form input, mutation streaming | Target classes 2–4 work on fixtures; engine-side `preventDefault` respected; stale generations dropped |
| 3 | Compatibility and policy | Target class 5 measured; cookie and login decision; downloads; diagnostics for unsupported features; rate limits tuned |
| 4 | Integration | Packaging as an optional component (and AGPL handling if D), documentation, session cleanup; flag on by default |

## 8. Verification

Use local fixture sites and browser automation to verify:

- DOM rendering, mutations, events (including `preventDefault` on links and forms), form input, redirects, and resource resolution.
- No destination traffic leaves the client directly, including with the sanitizer and rewriter disabled (CSP alone must block it).
- Sanitizer bypasses through HTML, CSS, SVG, and mutation batches.
- Attempts from snapshot content to access the parent DOM, session storage, tunnel credentials, or files.
- From inside the engine sandbox: reading `$HOME`, `/fs`, or TabTop state; reaching tabtopd sockets other than CDP; connecting to private, loopback, metadata, or host addresses directly or via redirects and DNS rebinding through the egress proxy.
- Resource exhaustion: infinite loops, memory growth, process forks, oversized and compressed responses; the watchdog kills the engine.
- Stale navigation generations are dropped by the server.
- Logout, session expiry, and tunnel loss kill the engine and delete its scratch directory.
- Exact sandbox and CSP values for the `/browser` frame.

First milestone (end of Phase 0): one interactive fixture, loaded by the sandboxed engine, that reads the DOM, handles a click, performs a `fetch`, and updates the client’s rendering. That tests the riskiest assumptions — that the engine can be contained on the host (or run on the client for E2) and that its output can drive an interactive client rendering — before broader work.

## 9. Existing projects and reuse candidates

These candidates were reviewed at the documentation level. Their security properties, maintenance, licensing, and suitability must be checked against a pinned revision before adoption.

| Project | Relevant capabilities | Gaps relative to this plan |
|---|---|---|
| [Lightpanda](https://github.com/lightpanda-io/browser) (for option D) | Headless browser in Zig with V8, html5ever, and its own DOM; no graphical rendering; CDP and WebDriver BiDi (Puppeteer, Playwright, chromedp); about 80% of Chrome’s WPT subtests; private-network blocking, proxy, cookie jar; 1.0 released October 2026 | Runs foreign JavaScript on the host with no process sandbox; AGPL-3.0; telemetry on by default; built for automation rather than long interactive sessions; partial layout only |
| [Kitesurf](https://github.com/cloudflare/kitesurf) (for option E) | Experimental engine for Cloudflare Workers: Boa JavaScript in WASM, Blitz DOM/layout/paint, Stylo CSS, Vello graphics; per-page isolates via Dynamic Workers; partial CDP; Apache-2.0 | Weeks old and experimental; built around Workers and Wrangler, with self-hosting on `workerd` unconfirmed; no authentication of its own; client protocol undocumented; reported memory growth without `--expose-gc`; client-side use would mean a fork and canvas output |
| [chromedp](https://github.com/chromedp/chromedp) | Go CDP client for driving either engine from tabtopd | Engines implement only part of CDP; confirm the domains used against each engine |
| [bubblewrap](https://github.com/containers/bubblewrap) / [nsjail](https://github.com/google/nsjail) | Unprivileged process sandboxing with namespaces and seccomp | Requires user namespaces or container privileges; confirm availability in TabTop’s container deployments |

### Evaluation sequence (Phase 0, time-boxed)

1. Check licenses and maintenance status of both engines and the sandbox tools.
2. Confirm the sandbox tool runs inside TabTop’s container image (user namespaces, seccomp) without extra privileges, or record what it needs.
3. Run Lightpanda (pinned release, telemetry off) inside the sandbox with its own network namespace and the egress proxy. Drive it from Go with `chromedp`: load the fixture, serialize the DOM, stream mutations, and dispatch a click by node ID. Measure start-up time, memory per session, and binary size, and confirm that the sandboxed process cannot read `$HOME` or `/fs`, reach other tabtopd sockets, or connect to private or metadata addresses.
4. Run E’s feasibility check (section 0): self-hosting on `workerd` without a Cloudflare account, egress forced through the egress proxy, and a standalone browser-worker build of the Rust core. Read its `SECURITY.md` and confirm what it sends to clients. Stop after two days if none of the checks pass.
5. Build the interactive fixture with D, and with E if feasible: DOM reads and writes, a click callback with `preventDefault`, a script `fetch`, and a resource-bearing mutation, rendered in the sandboxed client frame.
6. Record the decision between D and E.

The expected result is a contained engine, a sanitized client renderer, and TabTop’s E2E broker. Combining them does not by itself establish broad website compatibility or a secure isolation boundary; both must be demonstrated by the verification above.
