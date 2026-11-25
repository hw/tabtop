# Refactoring review

A review of the whole code base for duplication and other refactoring
opportunities, made on 2026-11-25. Line numbers are from `main` at
`e1c0d43`, before PR #3 (merged as `62524c0`) moved some lines in
`gobrowser.go`, `goclipboard.go` and `goagent.js`; lines marked *(rq)* are
from PR #3's branch. Find code by its symbol where a line has moved.

The work on these recommendations is tracked under [Progress](#progress):
each item's status is updated as it lands.

**Verified** means the claim was checked against the code after the review.
**Reported** means a reviewer traced it in the code but no one has
reproduced it. **Fixed** names the item (see [Progress](#progress)) that
fixed it.

## Progress

Groups are done in the order E, A, B, C, D, F, with the full suite (gofmt,
`go vet`, `go test`, the Node tests, both images built, every
`browser-check.sh` group, `lite-check.sh`, `startup-check.sh`,
`features-check.sh` and `go-check.sh` against the lite image) run once after
each group.

| Item | Status |
|---|---|
| Baseline | `main` at `62524c0`: all passed (`go-check` 136 of 136), but `features-check.sh`, which failed: it expected the pages' list without `go` (it ran nowhere; fixed in E3). |
| Group E's run | Passed: gofmt, vet, Go tests, Node tests (450), both images, the 14 `browser-check.sh` groups, `lite-check.sh`, `startup-check.sh`, `features-check.sh`, and `go-check.sh` 136 of 136, the same steps as the baseline's. On the way it caught: the disassemblers' checks needing the worker's own scope (`check-arm64.mjs`) and `self` (RISC-V, MIPS) from the harness; `-check-config` refusing a terminal alone (the terminal's files are given only at the start: a stand-in now); and two of mine in `go-check.mjs` (a Settings close that must not wait, as it's asked about unsaved filters first; a step's own `closeSettings` made to call itself). Seen once each, then passing: `binary`'s "first byte selected" (a known flake its own comment names), a page's file input in a whole run (passed 3 of 3 alone), and the Node tests' timing test while other tests ran beside it. |
| Group A's run | Passed (E and A, in a tree of their own), on its second run: gofmt, vet, Go tests, Node tests (450), both images, the 14 `browser-check.sh` groups, `lite-check.sh`, `startup-check.sh`, `features-check.sh`, and `go-check.sh` 136 of 136. Its first run had one step fail, "a page's file input" (it timed out waiting for the page to read the files it was given), as one of E's had: a run made while other heavy work shared the machine. Run again with nothing beside it, the whole suite passed, that step with it. |
| A1 Page headers | Done (group run passed): `setPageHeaders` (`pageheaders.go`) sets the CSP, `nosniff`, `no-referrer`, and `X-Frame-Options: DENY` where the CSP says `frame-ancestors 'none'` (not for pages framed by their own site: SAMEORIGIN is judged against every ancestor, a sandboxed one's opaque origin among them); used by the desktop, files, terminal, approval, doctor, share and `/go` pages. The files and terminal CSPs gain `base-uri 'none'` (no page uses `<base>`); the approval and doctor CSPs are named constants. `TestPageCSPs` checks every page's CSP has `base-uri 'none'`, `form-action` and `frame-ancestors`. Workers and preview frames keep their own CSPs. |
| A2 Login attempts | Done (group run passed): `loginAttempt` (`beginAttempt`, `failed`, `badMessage`, deferred `end`) in the tunnel login, passkey login, `checkCode` and the passkey confirmation; each counts as before. **Open decision, unchanged:** an error checking a TOTP code (liboath's, not a wrong code) counts as a failed login in the tunnel login but not in `checkCode`; both now say so where they decide. |
| A3 Disk space | Done (group run passed): `fileService.room(f, need, reclaim)`. Uploads, link uploads (whole and in pieces), fetches, stream saves (all four places) and EPUB edits clear resumable uploads first, as uploads and fetches did; a cross-root copy and a version restore (which had no check) count only what's free now. Zip extraction (not a `fileService` method) keeps its `fileDiskSpace` check, the same thing. `uploadRoom` stays for the free space the files page shows. |
| A4 State files | Done (group run passed): `serverConfig.stateFiles()` (`statefiles.go`), with the remote browser's `go-filters/` and its engines' cache added, used by root exclusion and `cleanGatewayTemps` (which now looks beside every state file, not four). `writeFileAtomic` moved to `atomicfile.go`, its temporary files named `.tabtop-*`; cleanup takes both that and the old `.shares-*`. `TestStateFiles`. |
| A5 Share limits | Done (group run passed): `shareSpec.check`, `validShareLife`, `validShareMax`, and `errShareLimits`/`errShareLabel`, checked by the store in `create`, `change` and `changeMany` (which now returns an error); the routes pass the store's word on. Making a link still checks first, before what it's to is looked for. `TestShareLimits`. |
| A6 Counters | Done (group run passed): `keyedSlots` (no lock of its own) for tunnels being set up, share downloads, upload forms and terminals; `windowCounter` (zero value ready; window and key bound given by its owner) for failed logins (no bound on keys, as before: forgetting one to make room would forget an address's failures) and requests for links that don't exist (10,000 addresses, as before). Link uploads keep their count on each link. |
| Group B's run | Passed (E, A and B, in a tree of their own, its offline pack rebuilt for B's `go.js`): gofmt, vet, Go tests, Node tests (450), both images, the 14 `browser-check.sh` groups, `lite-check.sh`, `startup-check.sh`, `features-check.sh`, and `go-check.sh` 136 of 136. (A first run, its tree saved before the pack was rebuilt, failed only the pack's check.) |
| B1 Page and connection lifecycle | Done (group run passed): three places say what each feature does: `leftPage` (the page gone), `connLost` (renamed from `releaseDevices`: the person's browser gone, or another took the tab) and `connBack` (split out of `resume`: one taking it back). **Fixed:** a lost connection now lets the page's fullscreen go, the page told (a browser enters fullscreen only after its person's press, so the next to connect can't be put back in it); a connection taking the tab back is asked again for the page's notification permission and its reads of the clipboard waiting on the person (each read keeps the site it's said to be asked by). `TestGoConnLostAndBack`. The viewer's own (`go.js`) cleanup lists are C's. |
| B2 Generations | Done (group run passed): `newGen(left)` starts all five; pop-ups asked about are let go in `leftPage` (so also on a certificate warning, and a blocked address, where they weren't); `loadTimeout` and `dialogTimeout` are fields, so `event` takes and gives back neither; `sayLoading` for the copied `go-loading` and `askAgain`. **Decision:** a stop and an address that isn't one still start a generation without leaving the page (it stays shown), as before. |
| B3 Pending asks | Done (group run passed): `goAsks[K, V]` (`goasks.go`) for the clipboard's reads, the orientation locks and the pop-ups, each with its generation, world and time; old ones let go in one place. Pop-up asks now carry their generation (one of a page gone can't be opened) and a wait (10 minutes). `goPasteID`/`goPasteAskFor` renamed `goAskID`/`goAskWait`. The single-slot asks (device, Picture-in-Picture, a position followed) stay as they are. |
| B4 Viewer messages | Done (group run passed): `goOps` (`goops.go`), each with its rule: any generation, the tab's now, or the page shown; `run()` keeps only `close`. `go.js` now sends its generation with `fullscreen-exit` and `wakelock-lost`, which are taken only for the page now. `TestGoOps`. |
| B5 Dead checks in `go.js` | Done (group run passed): the 11 `m.gen === gen` / `!== gen` checks in `message()` removed; the real `shown` checks stay. |
| B6 Per-site settings | Done (group run passed): `goPerSite` for pop-ups, media, ads, Dark mode and notifications: loaded, saved, set, forgotten and reported by one loop. **Fixed:** pop-up settings are kept by site, as the others (one kept by a host is read back as its site's). `TestGoPerSite`. |
| B7 Host helpers | Done (group run passed): `goSite` strips an IPv6 address's brackets itself (seven callers did; a cookie's site for an IPv6 page kept them, so never met the settings' Keep); `goCertHostOf` merged into `goPageHost`; `goHost` renamed `goHostPort`. `TestGoSiteOf`. |
| B8 `goBrowser` groups | Done (group run passed): `goPageAsks` (what the page's asked, embedded) and `goCertState` (certificate exceptions and warnings, embedded). The file system state (it holds a lock) and the viewer's capabilities stay in `goBrowser`. |
| Group C's run | Passed (E to C, its pack rebuilt): as B's, Node tests 451, `go-check.sh` 136 of 136. (A first run failed only the pack's check, for the same reason.) |
| C1 Page scripts in one function | Done (group run passed): `goPageSource` runs the stand-ins as one script, in one function, after `gopage-prelude.js` (`tabtopTop`, `tabtopIsTop`, `tabtopID`, `tabtopAsker`, `tabtopTell`), each guarded on its own (**fixed:** one that throws as it's set up no longer leaves those after it out). The wake lock, orientation and pointer lock stand-ins' waiting maps, ids and listeners are `tabtopAsker`'s; five copies of finding this origin's top window are `tabtopTop`; `goperms.js`'s check of the page's top is `tabtopIsTop`. `TestGoPageSource` (in Node: a stand-in that throws, the next set up, none of the prelude's names the page's). Left with their own: `goeme.js` (its Node tests load it alone), and `gonotify.js` and `godevice.js` (registered apart, with what they're given). |
| C2 One queue to the agent | Done (group run passed): `tabtopTell` keeps what a stand-in tells the agent on a document till the agent's next read (`__tabtop_read`, which the agent says at each batch, and as a frame's world's asks are read): the clipboard's, fullscreen, wake lock, orientation, vibration and (Obscura) dialogs, now in the one script. **Fixed:** what's told as the page loads, before the agent's there (an inline `alert()`), isn't lost. `gonotify.js` and `godevice.js` take `__tabtop_read` for their own queues (their `read_notify`/`read_device` gone). Kept apart: what's dispatched on an element whose target the agent needs (pointer lock, scrolls, device asks), and the EME and stream reads (each read is the agent's taking of a batch it has just emptied: one said earlier would be lost). |
| C3 The agent's outbox | Done (group run passed): `outbox` with `kept(key, max)` and `latest(key)` in `goagent.js`: each ask's list (or latest value) declared once, `clipboardOut` taking them all; nothing to reset by hand. Notifications keep their own (three lists and the pictures' budget). |
| C4 Event fields | Done (group run passed): `eventFor` in `go.js`: what's passed as sent, and an allowlist of the input fields, each with how it's cleaned. |
| C5 `changes()` and `act()` | Done (group run passed): `changes()` (72 lines from 260) calls nine phases (`frameOps`, `shadowOps`, `sheetOps`, `childOps`, `attrOps`, `mediaOps`, `textOps`, `valueOps`, `canvasOps`); `act()` (79 lines from 177) gives `edit`, `media-meta` and `scroll` to functions of their own. |
| C6 Event names | Done (group run passed): `test/tabtop-events.test.mjs`: every `__tabtop_` event said is listened for, and every one listened for said (by a literal, a constant that names it, or `tabtopAsker`); checked to fail on a name mistyped. |
| C+ The viewer's lifecycle (B1's viewer part) | Done (group run passed): `pageGone` and `connGone` in `go.js`, each as its server's part, used by the generation change, a connection closed, a fresh tab swapped in, and a resume that timed out. A lost connection now stops vibration and lets the pointer lock and the page's fullscreen go here too (the server's done so, the page told); the wake lock's kept (the server takes it again as the connection's back). |
| Group D's run | Passed (E to D, in a tree of their own: C's, with D's changes alone, its pack rebuilt), on its second run: gofmt, vet, Go tests, Node tests (453), both images, the 14 `browser-check.sh` groups, `lite-check.sh`, `startup-check.sh`, `features-check.sh`, and `go-check.sh` 136 of 136. Its first run failed one step, go-check's first, logging in (the page shown, its login form not come in time); that step passed alone, and the whole suite, run again, passed. (D was first run together with F, which passed too; its first run then stopped at the image, for `worker-client.js`: see D4.) |
| D1 The image editor's tools | Done (group run passed): `toolsOpen` and `otherOpen(...mine)` in `image-view.js` for the fifteen guards (each its own tool left out, which its button closes; background removal and inpainting each other's). **Fixed:** placing a pasted picture while a scan's open isn't let through. |
| D2 Frame replies | Done (group run passed): `replyFrom` and `replyTo` in `preview-frames.js` for the Markdown frame's resources, media and pictures and the book's pictures; `pictureFrom` for both kinds of picture, one cap (`FRAME_PICTURE_BYTES`, 20 MiB: the larger of the two, so none shown before is refused). **Fixed:** a media request whose preview's replaced meanwhile is answered (it waited for good). |
| D3 Frame bridge | Done (group run passed): `frame-bridge.js` (`TabTopFrameBridge`), loaded by the Markdown, PDF and book frames' pages before their own scripts (in tabtopd and the offline client's build); the pack rebuilt. Left as they are: the frames' own link handling (only Markdown's normalizes links; the book's keeps its own), and the stale header comments, now corrected in `md-frame.js`. |
| D4 Worker clients | Done (group run passed): `worker-client.js`: `OneAtATime` (background removal, inpainting, magic select), `ByID` (3D model decoding, the disassembler) and `oneShot` (text and picture comparisons); `ort-worker.js` for the three ONNX workers' runtime set-up (loaded by a literal `importScripts`, served with the runtime's path as they are; their Node tests run it; the Go tests of the inpainting and magic select workers' paths now look for the runtime's in `ort-worker.js`, and the worker loading it; the image build's 3D check copies `worker-client.js` too, which `model-decode.js` now imports: caught by D and F's first run, whose image didn't build). **Not moved:** the Kaitai view's client, whose worker is made by each decode and holds its parse: one made again on demand after a timeout wouldn't have it. |
| D5 Preview kinds | Done (group run passed): `textModel`, `thumbnail` and `toolpath` flags in `file-types.json` instead of three lists of extensions; `toggleView` and `modelAlternative` in `preview-model.js` (the view toggle's rules, once, for its drawing and its click); the loaders and renderers check, as they load, that each kind has theirs; `test/preview-kinds.test.mjs`. **Decision:** the limits, loaders and renderers stay three tables, in their three modules (one table would make the model's module import the renderers' DOM code); a kind missing from one now fails at once, not quietly. |
| D6 Dialog shell | Done (group run passed): `showModal` in `preview-dom.js` (shown, closed by ✕ or Esc, taken away, the focus given back), with `request(close, how)` for a dialog that decides first and `parent` for one kept in another's keys; used by every dialog of the files page's: the text and picture comparisons, the versions list, the search (Esc stops a search going before it closes), the picture's metadata (asked first, with changes unsaved), the picture chooser, an external link's, the confirmations (`choose` in `ui.js`), the PDF pages' editor (Esc cancels processing, else asks as ✕ does) and the preview itself (Esc a video player's; asked first while editing; the focus given back next frame). `maximizeButton` for all three widen buttons, with a kept choice for the preview's (one wording, "Fill the window" / "Back to a box"); the seven local `el()`s replaced by `preview-dom.js`'s. |
| D7 "Copied" notice | Done (group run passed): `copied-note.js` (`copiedNote`) for the desktop's and the terminal's. |
| E1 Flaky checks | Done (group run passed): the test and ads sites wait with `up` and fail clearly; `siteFetch` (retried, each try cut short) for the check's own fetches of them; the harness's `open` says a failed load at once, and `waitFor` tries again after an error (a context destroyed mid-load), each try cut short; the local DNS step adds its own record, and the ad-block step waits for whichever page the tab restores; `frameDrop` (page shown and drawn, `dragOver` paced by drawn frames) replaces three hand-written drops. |
| E2 Settings drift | Done (group run passed): `TABTOP_GO_DEBUG` logs only with `1` (`gobrowser.go`, `entrypoint.sh` passes the value on); `config.sh` accepts the remote browser alone, as tabtopd does, and checks every switch before turning sound off without a desktop, and `WEB_TTY` once; the docs' "won't start if" list names `VNC_USER` and the all-off case; the Dockerfile's `VNC_ADDR` comment says `VNC_X509` encrypts it. |
| E3 Validation blocks | Done (group run passed): one loop checks the 16 switches (14 blocks gone); `startup-check.sh` and `features-check.sh` run in CI with the `images` part (`features-check.sh` made executable, and its list of pages given `go`, which it had gone without since `/go` was added). |
| E4 Shell and Go validation | Done (group run passed): `serverConfig.check` (newServer's checks, touching nothing) and `tabtopd -check-config`, which says a wrong setting by its variable's name (`checkconfig.go`, `TestCheckSettings`). `config.sh` passes it `GATEWAY_SETTINGS`, the flags entrypoint.sh then starts the gateway with, and no longer re-implements the base path, session limits, bitrate, disassemblers, `WEB_HOSTS` or `VNC_ADDR`. Kept in the shell, as the shell uses them: the port, `WEB_TRUST_NPROXIES` (its arithmetic), `WEB_TTY_COMMAND`. Not checked early: `WEB_FS_ROOTS`, whose check needs the mounts. |
| E5 Go test polling | Done (group run passed): `waitUntil` (`testwait_test.go`, 10 s, `TABTOP_TEST_WAIT` changes it) replaces `eventually` (500 ms), `waitFor` and 9 inline loops. Left as they are: a loop that reads messages as it waits (`fetch_test.go`), one that checks a process is still alive after a second (`goengine_test.go`), and two lenient waits in `tty_remote_test.go`. |
| E6 `go-check.mjs` | Done (group run passed): helpers `leave` (16 uses), `submitUrl` (23), `viewOrigin` (14), `closeSettings` (9), `stillNot` (5 "sleep, then assert" checks now watched throughout); the test site (1,480 lines) moved to `test/browser/go-site.mjs`, the site it writes checked identical to `main`'s; the steps split into nine modules under `test/browser/go/` (pages, sites, input, pop-ups and streams, pointer and WebGL, video, frames and tabs, certificates and the network, the page's web APIs), each given the browser, the site and the helpers as one context (the count of choosers opened read through it, as it changes), and `step` (with `GO_ONLY`, `GO_FROM`) in `step.mjs`: `go-check.mjs` is 271 lines from 4,358. The modules' free names were taken from the TypeScript checker, not by hand. Its unused `mp4Encrypted` import (on `main` too) removed. Two mistakes in the split, found by F's runs and fixed: `origin` not passed to the web APIs' steps, and the offline client's step reading the pack by a path from its old place (see Group F's run). The other "sleep, then compare" checks compare values computed after a wait (a frame drawn, a size settled), not that something didn't happen, and are left. |
| E7 Smaller | Done (group run passed): `totp` in `harness.mjs`; `test/lib.sh` (`up`, `wait_healthy`, `free_port`) used by five scripts; `newE2EServerWith` for the roots, transfer and share test servers (`newFetchServer` and `newGoServer` keep their after-the-fact changes: a client that reaches loopback, a fake engine); `.github/actions/load-image` for the three cached loads and a push matrix (one tag list); `scripts/disasm/worker-harness.mjs` for the five checks, added to the Dockerfile's `COPY`. |
| Group F's run | Passed (the final tree, every group in), on its fifth run: gofmt, vet, Go tests, Node tests (453, the offline pack's check among them, the pack rebuilt), both images, the 14 `browser-check.sh` groups, `lite-check.sh`, `startup-check.sh`, `features-check.sh`, and `go-check.sh` 136 of 136; in both images, `--sandbox-check` (and in the full one, the HEIC child's own) says the sandbox is set up and refuses what it should. The runs before it found two mistakes of mine in splitting `go-check.mjs` (E6), each fixed: a helper, `origin`, not passed to the web APIs' steps (the checker took it for the page's global `origin`, so it wasn't counted as missing; checked again without the DOM's globals, for every module moved today, and no other was missed), and the offline client's step reading the pack by a path from its old place. The others failed a step each time on timing, a different one each run and each passing in the runs either side: the MIPS disassembly's (`binary`), a pointer click (`html`), the 20th WebGL canvas, and files dropped on another origin's embedded page; nothing else used the machine meanwhile. |
| F1 Two resumable-upload systems | Done (group run passed): each of the three things the two kept apart is one now. The finished-upload memory: generic `recent[V]` (`keyedslots.go`) for the files page's (`uploadDone`) and the links' (`linkDone`). The write loop: `writeLinkBytes` (`share_chunks.go`) for a link's whole uploads and its pieces. Pausing while a folder's moved or deleted: both hold a partial by `partialUpload.hold`/`let` (counted), and find what's in the folder by `inFolderOf` (resolved outside their locks); a link's upload has `writing` for a piece going, apart from being held. **Fixed:** a folder holding a link's upload kept the next move or delete of it, or of a folder around it, from holding it too (refused as busy, as if a piece were being written); now both hold it, and it carries on once the last lets go. **Changed:** one whose time ran out while held is given up once it's let go, as the files page's are (it was given another `partialKeep`). `TestUploadLinkPiecesHeld`. **Decision:** the two stores stay two maps, each by its own key (a link's limits are kept on its uploads), and the space check clears only the files page's partials: a link's are a visitor's, kept for them to resume. |
| F2 Sandbox the preview children | Done (group run passed): `children.go` has the children by argument (one table for `main` and `TestMain`, which had five `if`s each), `childLimits`, `startPreviewChild` and `sandboxReport`; HEIC's seccomp filter is now every preview child's (`child_sandbox.go`, built for Linux on x86-64 and arm64 whatever the tags). The Markdown and book children are limited (2 GiB of memory, C's too; 300 s of processor time) and sandboxed before they read anything; SQLite's is limited, opens its database, keeps sorts in memory (`temp_store = MEMORY`, within its 256 MiB heap: no temporary file can be opened now), then is sandboxed. HEIC's is as before. **Changed:** a sort or temporary table that outgrows SQLite's 256 MiB heap now fails, with an error, where it spilled to a temporary file; no check makes one so large. `TestChildSandbox` checks the sandbox without HEIC's build. **Decision:** if the sandbox can't be set up (a kernel, or a container, that doesn't allow it), Markdown, books and SQLite are still read, as they were before there was one, and nothing says so; HEIC pictures still aren't. (To refuse them instead, or log it, is a choice still to make.) **Unverified:** arm64 (the filter type-checks for it, as HEIC's did; there's no arm64 machine here to run it). |
| F3 Optional asset bundles | Done (group run passed): `bundles.go`, one table of the ten bundles (`assetBundle`: its setting, path, files and what it's for); the page accessors, `serveBundle`, the offline pack's list and the startup warnings (now for every bundle, not four) read it. |
| F4 Tunnel handler signature | Done (group run passed): the 29 `fileService` handlers take `*tunnelCall` and the route table names them as method values (no adapters); `req.dir()` for the 13 places that trimmed and cleaned `req.Path`. Six of them only trimmed, so had `""` for the root where they now have `"."`: each was checked to take both alike (`os.Root`, `topFolder`, the stream stage, a fetch's start, which cleaned it already). |
| F5 The largest closures | Done (group run passed): `hexView`'s disassembly panel is `hex-disasm.js` (`disasmPanel`; `hexView` 1,313 lines to about 1,060). The image editor's crop, resize and background removal are tools of their own, as `drawTool` and `placeTool` are: `image-crop.js` (`cropTool`: its rectangle, magic select and gestures, the stage's pointer handed to it as to the others), `image-resize.js` (`resizeTool`), and `image-background-tool.js` (`backgroundTool`, given the editor's state through one context, read as it goes and set where it's its own: `startEditing` 1,053 lines to 511, `imageView` 1,285 to about 710). `preview()`'s External resources menu is `preview-external.js` (`externalMenu`; with D6's dialog, `preview()` 866 to about 770). `pdfImageEditor`'s page cards are `pageCards` (their thumbnails, boxes and dragging; 539 to about 480). `goMedia`'s parts fetcher (`mediaParts`), `shortAddress` and `loadingUntilReady` are out of its closure (1,183 to about 1,100). Free names of what moved were taken from the TypeScript checker. |
| F6 Smaller | Done (group run passed): `fetchOrigin` (`by`, `ip`, `who`, `from`, `userAgent`) for the fetches and stream saves, `start`, `startGo` and `startFetch` (the five wrappers gone); the stale comments in `roots.go`, `main.go`'s header and `go-media.js` fixed; `ebmlIDLen` and `toBase64` removed. |
| Found on the way | `go-check.mjs`'s real-site steps (`GO_SITES`) used a `file` never defined, so each failed at its screenshot (on `main` too): it's now `GO_SHOTS`/the site's host `.png`, as the comment says. Not run: no suite sets `GO_SITES`. |

## Summary

There's little copy-pasted code. jscpd finds 1.2% of the tracked JavaScript
duplicated (508 of ~58,000 lines, outside the ignored
`scripts/bootstrap/.client-build`). dupl finds 20 small clone groups in the
Go server, none longer than about 15 lines. The one large verbatim copy,
`file-types-worker.js`, repeats 202 lines of `file-types.js`, and both are
generated by `gen_file_types.go` and checked by `test/file-types.test.mjs`:
leave it.

The real problem is one idea implemented in several places, or a list kept
in sync by hand in several places. Several of those copies have already
drifted apart, and some of the drift has become the bugs below. The most
valuable refactors are the ones that fix them.

## Bugs found

| Status | Bug | Where |
|---|---|---|
| Fixed (B1, C+) | After a reconnect, the page still thinks it's fullscreen, but the person's screen isn't. `resume` resends the wake lock, pop-up asks and stream offers but not fullscreen, and `releaseDevices` releases pointer lock and orientation but not fullscreen. | `gobrowser.go:1121-1146`, `godevice.go:426-444` |
| Fixed (C1) | One page-world script failing to install stops every script after it. They're joined into one script with nothing guarding each file, so a top-level throw (for example `defineProperty` failing in `govibrate.js:56`) leaves the wake lock, orientation, pointer lock, drop and permissions stand-ins uninstalled. | `goPageScripts` *(rq)*, `gobrowser.go:829` on `main` |
| Fixed (D1) | Pasting a picture while a scan is open opens the Place tool alongside it, and `change()` then drops the placement silently. `placePicture` doesn't check `scanning?.active()`; the Scan button's handler checks the others. | `image-view.js:1301` vs `:1327` |
| Fixed (D2) | If a preview is replaced while its media request is pending, the frame's media request never gets an answer. Its `resource` and `image` requests answer with an error. | `preview-frames.js:121-124` vs `:115-121`, `:132-136` |
| Fixed (E2) | `TABTOP_GO_DEBUG=0` turns debug logging on, which logs page addresses. The entrypoint passes it on if it's set at all (`:+`) and the server only checks it isn't empty; the docs say `1` turns it on. | `entrypoint.sh:53`, `gobrowser.go:164` |
| Fixed (C2) | Page requests made before the agent is installed are lost. The agent is installed at the first full read (DOMContentLoaded, `gobrowser.go:1611-1619`, `1799`). The dialog, copy, paste-ask, fullscreen, wake lock, orientation, pointer lock, vibrate and scroll requests are sent once with no queue: an `alert()` in an inline script under Obscura isn't shown, and early requests time out after 10 s or 120 s. Notifications, devices, EME and streams already queue. | `godialogs.js:19` and the other "sent once" scripts |
| Fixed (B2) | A pop-up the old page asked about survives into the next page. `popupAsks` is cleared at `gobrowser.go:1218` and `:1537` but not in `certFailed` (`:2484`) or `navigate`'s blocked-host return (`:1207-1213`); `resume` resends it under the new generation (`:1140`) and `popupAnswer` would open it. | `gobrowser.go` |
| Fixed (A3) | Some disk-space checks count resumable partial uploads as free space but never clear them, so the check passes and the write fails on a full disk: `uploadRoom` without a reclaim at `epub_edit.go:856` and the stream savers (`gosavestream.go:954`, `gostreammse.go:217,668,813`). Restoring a version checks no space at all (`versions.go:606`). | see the cell |
| Fixed in part (C+: vibration; the wake lock kept, as intended) | A lost connection in the viewer keeps the wake lock and vibration running until `pagehide` or the next generation. This may be intended while the server keeps the tab. | `go.js:1693-1697` vs `:1669-1675` |
| Fixed (B6) | Pop-up settings aren't reduced to the site in `goSites.set` or on load, though `popup()` looks them up by site. Latent: today's callers pass the site already reduced. | `gosites.go:553`, `:825` |

## Recommendations

Effort: S is hours, M a day or two, L longer.

### A. Rules copied in several places that have drifted

Small effort, and several are security-relevant: do these first.

1. **Page security headers (S).** Nine places set CSP, `nosniff`,
   `Referrer-Policy` and `Cache-Control` by hand: `http.go:99`,
   `page_assets.go:356` and `:481`, `tty.go:82`, `remote_auth.go:303`,
   `doctor.go:202`, `bootstrap.go:68`, `share_page.go:226`, `share.go:736`.
   They've drifted:
   - **Verified:** the files page CSP (`page_assets.go:29-30`) and the
     terminal CSP (`tty.go:44-45`) lack `base-uri 'none'`, which the other
     pages have. This is hardening: no HTML injection is known.
   - `X-Frame-Options` is set in only three places, though the comment on
     `novncHeaders` says the files and terminal pages are guarded the same
     way.

   Change: `setPageHeaders(h, csp, cache)` and a CSP builder that always
   appends `base-uri`, `form-action` and `frame-ancestors`.
2. **Login attempts (S–M).** Four places assemble `beginLogin`, `endLogin`,
   `loginTurn`, `startLoginWork` and `failedLogin` by hand: `tunnel.go:199-300`,
   `passkey_login.go:87-119`, `checkCode` (`passkey_login.go:242-275`) and
   `gorestart.go:89-105`.
   - **Verified:** an internal TOTP-check error counts as a failed login in
     `loginTunnel` (`tunnel.go:288-293`, returns `errWrongCode`) but not in
     `checkCode` (`passkey_login.go:263-266`, "not counted").
   - The passkey paths skip `startLoginWork`. This may be deliberate.

   Change: `a := g.beginAttempt(ip, browser, work)` with `a.failed()`,
   `a.notChecked()`, `a.ok()` and `defer a.end()`, recording both the
   lockout count and the activity entry.
3. **Disk-space checks (S–M).** Five different checks:
   - `reclaimPartials` at `upload.go:301`, `share_upload.go:169`,
     `share_chunks.go:338`, `fetch.go:643`;
   - `uploadRoom` with no reclaim at `epub_edit.go:856` and the stream
     savers (see Bugs);
   - raw `fileDiskSpace` at `zip_extract.go:127` and `copy_roots.go:455`,
     which refuse even when clearing partials would make room;
   - none at `versions.go:606`.

   Change: `g.ensureRoom(f, need, spare) error` that clears partials first,
   then checks, with one message.
4. **TabTop's own state files (S).** The files that must not sit inside an
   exposed root are listed at `config.go:138` (11 files); `cleanGatewayTemps`
   keeps its own list at `cleanup.go:148` (4). `writeFileAtomic`
   (`share.go:331`) names every store's temp file `.shares-*`, which the
   cleanup pattern `atomicTempName` (`cleanup.go:35`) depends on. Neither
   list includes `go-filters/` or `~/.cache/tabtop/go-http-cache`. Change:
   one `serverConfig.stateFiles()` used by root exclusion, cleanup and
   doctor, and `writeFileAtomic` in its own file with a neutral prefix.
5. **Share-link limits (S).** Lifetime and count are checked at
   `tunnel_request.go:452`, `tunnel_routes.go:465` and `:494`, each slightly
   differently. The upload byte limit is checked in the route when a link is
   made but inside the store when one is changed (`share.go:612-617`). The
   label check and its message appear four times. Change:
   `shareSpec.validate(allowKeep)` called in `shareStore.create`, `change`
   and `changeMany`.
6. **Per-IP and per-link counters (S).** `handshakes.startUpTo`
   (`session.go:291`) is generic, but the same counting is rewritten in
   `startDownload` (`share.go:1012`), `startForm` (`share_upload.go:400`),
   `openTTY`/`closeTTY` (`tty.go:270`) and `linkPartials.startingFor`. Failed
   logins (`login_limit.go:29`, `:163`) track any number of addresses and use
   `time.Now`; share-link misses (`share.go:443-490`) are capped, drop the
   oldest and use the injectable clock. Change: a lock-free `keyedSlots` and
   a `windowCounter{window, limit, maxKeys, clock}`.

### B. The remote browser's page lifecycle

Medium effort. Fixes the fullscreen, pop-up and paste-ask gaps.

1. **What a page leaving, a lost connection and a reconnect undo (M).**
   - Server: `leftPage` (`goprefetch.go:214`), `releaseDevices`
     (`godevice.go:426`) and `resume` (`gobrowser.go:1118-1146`) keep their
     own lists. `releaseDevices` repeats `leftPage`'s device reset and clears
     orientation directly (`:444`) instead of calling `orientationGone`.
     Missing from at least one: fullscreen, the pending notification
     permission ask (`notifying.ask`; new requests join it for up to 2
     minutes, `gonotify.go:131`, and the new connection never shows it), and
     `pasteAsks`.
   - Viewer: `go.js` clears different subsets at the generation change
     (`:1669-1675`), `socketClosed` (`:1693-1697`), `swapTo`
     (`:1787-1795`) and the resume timeout (`:1613-1615`).

   Change: each feature has `pageLeft()`, `connLost()` and `connBack()` on
   the server, and a `gone()` in the viewer, called only from those places.
   Add tests for fullscreen and the notification ask across a reconnect.
2. **Starting a generation (M).** `b.gen++` appears five times
   (`gobrowser.go:948, 975, 1205, 1534, 2485`), and only three call
   `leftPage`. The `go-loading` send plus `askAgain` is copied at `:1219` and
   `:1538`. `loadTimeout` is threaded through `navigate`, `event` (six
   `return loadTimeout, dialogTimeout`) and `certFailed`, while `readSoon`
   and `againSoon` are already fields. Change: `b.beginGen(url, by, loading)`
   with `loadTimeout` as a field; decide explicitly whether `stop` and the
   bad-URL case (`:948`, `:975`) call `leftPage`. Only `go-check.sh` covers
   `navigate` and `certFailed`.
3. **Pending requests to the person's browser (M).** `goPasteAsk`,
   `goOrientLock` (`goorientation.go:33`), `goPointerLock`, `goDevicePending`
   (`godevice.go:57`) and `goNotifyAsk` all carry `{gen, world, id/token,
   at}`, with four timeouts (`godevice` reuses `goPasteAskFor`, `:134`,
   `:205`) and four ways of dropping old ones (`goclipboard.go:206`,
   `goorientation.go:62`, `gopointerlock.go:55`, `godevice.go:205`).
   `popupAsks` (`gosites.go:841`) has no generation or time. `goPasteID` is
   the id check for seven features. Change: `goAsks[T]{max, wait}` with
   `add(gen, world, v) token`, `take(token, gen)`, `drop()` for paste,
   orientation and pop-up asks; rename to `goAskID`/`goAskWait`. Leave the
   single-slot asks alone.
4. **Viewer messages (S–M).** `run()`'s switch handles 28 messages
   (`gobrowser.go:940-1065`); the stale-page check is in `run()` for some,
   inside the handler for others (`paste`, `device-answer`, `notify-event`)
   and missing for `wakelock-lost` and `fullscreen-exit`. Change:
   `map[string]goOp{needGen, needShown bool; fn}`, about 120 lines out of
   `run()`.
5. **Dead checks in `go.js` (S, verified).** `message(m)` is only called
   right after `gen = m.gen` (`go.js:1676-1677`), so its 11 `m.gen === gen`
   / `!== gen` checks (e.g. `:2043`, `:2048`, `:2058`, `:2064`, `:2076`,
   `:2098`) never filter anything and hide the 9 real `shown` checks. Delete
   them; optionally move the feature cases of the 298-line switch
   (`:1858-2155`) into a table.
6. **Per-site settings (M).** Popups, media, ads, theme and notifications
   are each touched in about 9 places in `gosites.go` (field, file field,
   init, load, save, `set`'s limit and `-default` cases, normalisation at
   `:553`, `forget`, `report`, lookup). Nil checks differ: `themeFor`,
   `mediaFor`, `adsFor` check, `popup` and `notificationsFor` don't. Change:
   `goPerSite{prefix, values, m, ver}` entries that each step loops over.
   `gosites_test.go` covers `set` well.
7. **Host helpers (S).** `goPageHost` (`gocookies.go:802`) and
   `goCertHostOf` (`gobrowser.go:2494`) have identical bodies. `goHost`
   returns host:port (`goprefetch.go:286`). `goSite` keeps IPv6 brackets,
   hence seven `goSite(strings.Trim(…, "[]"))` calls. Change: strip brackets
   in `goSite`, merge the two, rename `goHost` to `goHostPort`.
8. **`goBrowser` sub-structs (M–L).** About 120 declaration lines. The
   per-page ask state (`fullscreen`, `wakeHeld`, `orientAsks`,
   `orientLocked`, `pointerLock`, `device`, `pip`, `locWatch`,
   `imagePaste`, `fs`, `pasteAsks`, `popupAsks`, `notifying`) could become
   `goPageAsks`, whose zero value means "page left", which makes most of B1
   mechanical. The certificate state could become `goCertState`.

### C. Plumbing between the page and the agent

Medium effort. Fixes the install chain and lost early requests.

1. **One function around the page scripts, with a shared prelude (M).**
   Repeated across the stand-ins: `reader()`, the topmost same-origin
   document (6 copies: `goclipboard` 17, `goeme` 16, `gofullscreen` 19,
   `gomedia` 216, `gonotify` 19, `govibrate` 12); `isTop` (4); id
   generation (5, plus 2 using `crypto`); the waiting Map, timeout and
   answer listener (5: `goclipboard` 46-70, `gofullscreen` 59-83 and
   121-128, `goorientation` 15-47, `gopointerlock` 22-74, `gowakelock`
   56-90); `on…` handler accessors (6); `define` helpers (3, which disagree
   on `enumerable`).
   - Prelude: `ask(type, detail, {timeout, onTimeout, target, error,
     unsolicited})`, `tell`, `topDoc`, `isTop`, `newID`, `defineMethod`,
     `onHandler`, with `dispatchEvent` and `CustomEvent` captured before the
     page runs (as `goshadow.js:40` does).
   - Wrap each file in `try {…} catch {}` too, which fixes the install-chain
     bug.
   - Feasible: all 16 files are top-level IIFEs, and `goGLPageJS`
     (`gobrowser.go:69`) already wraps four files; `test/gogl.test.mjs:14`
     and `:108-112` check that nothing leaks. `gonotify` and `godevice` are
     registered separately (`gonotify.go:401`, `godevice.go:364`). The
     `goeme` node tests would prepend the prelude.
   - Saves about 150 lines.
2. **One queue for every page-to-agent message (M).** Use the queue
   `gonotify.js:40-64` and `godevice.js:28-45` already use. The agent sends
   one `__tabtop_read` per batch, replacing `read_notify`, `read_device`,
   `read_eme` and `read_stream`. Keep each kind's per-batch caps, and the
   rule that cancelling the event means the agent took it. A request may
   wait up to one poll (≤250 ms). Fixes the lost early requests.
3. **An outbox for the agent's batch (S–M).** The batch's variables are
   declared at *(rq)* `goagent.js:91, 101, 116, 143, 149, 157, 173, 184,
   194`; `clipboardOut` (*(rq)* `:253-277`) builds the output in 10 lines
   and resets it in 13; `changes()` resets five more inline and has a
   9-term empty check. Change: `outbox(key, {max, latest})` with `push()`
   and `take(out)`, and `relay(type, box, validate)`; two registries, one
   for the page's own world and one for any world (`frameWorld`). A new
   feature is then one relay line and one answer.
4. **Input event fields (S).** The fields are listed in the frame's
   `send()` calls, `go.js:2340-2353` and the Go struct in `goinput.go`; a
   new field the frame sends is dropped unless `go.js` is edited too.
   Change: a declarative `EVENT_FIELDS` allowlist and a loop.
5. **Split the agent's `changes()` (M).** 260 lines (*(rq)* `:1707-1966`):
   phase functions for frames, shadow roots, sheets, children, attributes,
   media, values and canvases; `act()` (177 lines, `:2011-2187`) as a table
   by `kind`.
6. **Event-name test (S).** Every `__tabtop_*` event name is a literal in
   two or more files, so a typo silently does nothing. A node test can check
   that every dispatched name has a listener. There are no orphans today.

### D. Files UI

1. **One "which tool is open" state in the image editor (S–M).** About 15
   guards spell out the exclusion by hand, each with a different subset of
   `saving`, `cropping`, `backgroundEdit`, `inpainting`, `drawing`,
   `placing`, `scanning` and `resizePanel` (`image-view.js:599, 1077, 1149,
   1202, 1240, 1245, 1263, 1283, 1301, 1318, 1327, 1406, 1436, 1445, 1449`);
   `toolOpen()` exists (`:1202`) but is rarely used. Change: one `openTool`
   value and `canOpen(tool)`. Fixes the paste-during-scan bug.
2. **Preview frame replies (S).** `preview-frames.js` hand-writes the "stale
   loader, copy bytes, transfer" reply three times (`:115-121`,
   `:132-136`, `:213-219`). They diverge (the hanging media request above),
   and the per-picture caps differ: Markdown `20e6` (`FRAME_PICTURE_BYTES`),
   EPUB `20*1024*1024` (`:184`). Change: `replyFor(loader, current)` and one
   `readPicture(open, cap)`.
3. **Frame-side bridge (M).** `md-frame.js:44-75`, `pdf-frame.js:51-89` and
   `epub-frame.js:34-72` each repeat `ask`, `waiting`, the source check and
   dispatch; link click and auxclick handling is repeated in md (`:78-104`)
   and epub (`:329-356`); only md normalises links through
   `TabTopHTMLLinks.reference`. Change: a classic `frame-bridge.js` loaded
   with `<script src>`. Touches the three Go frame HTML constants,
   `build-full-client.mjs:354-356` (kept equal by `TestOfflineFrames`) and
   the embed list. Keep the `"*"` target origin: the frames have opaque
   origins. Stale comments: `md-frame.js:20` ends mid-sentence ("Once
   it's"), and the md and epub headers say the frame "can't fetch anything",
   but Direct mode loads from the web (`directFrameCSP`,
   `page_assets.go:97`).
4. **Worker client (M).** Eight hand-written clients: single-request
   `BackgroundRemover` (`image-background.js:97-152`), `Inpainter`
   (`image-inpaint.js:35-62`), `Segmenter.#ask` (`image-segment.js:102-125`);
   one-off `compute` in `text-diff-view.js:44-61` and
   `image-diff-view.js:67-88`; id-matched `model-decode.js:12-39`,
   `hex-view.js:345-377`, `kaitai-view.js:98-106`/`162-169`. The
   disassembler client has no timeout; only the three AI clients handle
   `onmessageerror`. Change: a `worker-client.js` module (every caller is an
   ES module) with one-shot, single-request and id-matched modes. On the
   worker side, `runtime()` and the offline preamble are identical in the
   three ONNX workers (`image-background-worker.js:33-60`,
   `image-segment-worker.js:7-29`, `image-inpaint-worker.js:4-26`); a shared
   `ort-worker.js` must be loaded with a literal `importScripts("…")` online
   (the offline build only follows literal names), goes through
   `tabtopImportScripts` offline, and needs adding to the `go:embed` list
   (`page_assets.go:35`).
5. **Preview kinds (M).** Each kind is listed in `limits`
   (`preview-model.js:40`), `loaders` (`preview-loaders.js:9-23`),
   `renderers` (`preview-renderers.js:68-`) and `file-types.json`; a kind
   missing from `limits` silently isn't previewable (`previewable`, `:87`).
   The alternate-view rules are spread across `setMode`, the toggle click
   and `draw` (`preview.js:276-311`, `:480-488`). Text names are kept in
   three shapes (`textExtensions`, `languages`, and regexes in `textModel`,
   `MODEL_THUMBNAIL` and `model-view.js:262`). Change: one `{limit, load,
   render}` table, a pure `alternateView(current)`, and text/model flags in
   `file-types.json`.
6. **Dialog shell (M).** About 10 dialogs build their own close button,
   cancel handling and focus restore (`preview.js:825-891`,
   `text-diff-view.js:138-155`, `image-diff-view.js:352-366`,
   `image-exif-view.js`, `search-view.js`, `versions-view.js`,
   `preview-editor.js`, `pdf-image-editor.js:235`). Three widen-button
   implementations with different labels (`preview.js:264`,
   `pdf-image-editor.js:167`, `maximizeButton` in `preview-dom.js:34`).
   Change: `modalShell({className, onClose, restoreFocus, widen})`, and the
   one `el()` from `preview-dom.js` instead of seven local copies.
7. **The "copied" notice (S).** `novnc.js:182-196` and `tty.js:221-235`
   differ only in the element id and wording: move it into a shared module.

Checked and fine: `saveBlob` (`requests.js:326`) is the only save path;
`preview-view.js` already unifies viewer lifecycle; no meaningful dead code.

### E. Tests, settings and scripts

1. **Flaky browser checks (S).**
   - **Verified:** `go-check.sh:94` and `:98` wait 5 s for the site and ads
     containers and go on without failing, although `up()` (`:66`) fails
     clearly. The ads site's first use is a bare `fetch(adSite + "seen")`
     (`go-check.mjs:3135`; also `:3167`, `:3945`, `:4428`), which hits
     undici's connect timeout: likely the "ads container connect timeout".
     Change: `up "http://$ads_ip/index.html" "the ads site" 30` (and the
     site), and a `fetchRetry` with `AbortSignal.timeout` in the `.mjs`.
   - `harness.mjs:90-96` `open()` never checks `Page.navigate`'s
     `errorText`, so a failed load surfaces 30 s later as "timed out waiting
     for the login form". `waitFor` (`:57-67`) ends at once when its
     expression throws (e.g. a context destroyed mid-navigation), and a hung
     one can use the whole budget. Change: throw on `errorText`, retry
     expression errors, cap each at the time left (`frameWait`,
     `go-check.mjs:1556`, already catches them).
   - Steps depend on earlier steps, which breaks `GO_ONLY`/`GO_FROM`: the
     local DNS step (`:4987`) needs the `fixture.home.arpa` record added in
     the Settings step (`:1921`); the ad-block step expects the title
     "Second" from an earlier step (`:3154`). Change: each step sets up its
     own state.
   - File drop: three copies of dragEnter, dragOver, `sleep(200)`, drop
     (`:3013-3015`, `:3025-3027`, `~:4133-4135`), measured without
     `pageShown()`/`dialogGone()`. Change: `frameDrop(sel, files)` that
     waits for the page and for its dragover signal.
2. **Settings drift (S).**
   - The debug flag (see Bugs).
   - `config.sh:56` refuses VNC, TTY and FS all off even with `WEB_GO=1`,
     but `newServer` accepts a `/go`-only setup.
   - `config.sh:59-61` forces `WEB_AUDIO`/`WEB_MIC` to `0` before their
     checks (`:150-157`), so invalid values pass when the desktop is off.
   - `WEB_TTY` is validated twice (`:49`, `:219`).
   - The "won't start if" list (`docs/environment.md:55-62`) leaves out
     `VNC_USER`, which `config.sh` rejects.
   - `Dockerfile:568-570` still says the connection to `VNC_ADDR` is
     unencrypted (stale since `VNC_X509`).
   - Clean: all 60 `main.go` flags are passed by `entrypoint.sh`, and every
     documented variable is used.
3. **Validation blocks (S).** 15 `0|1) ;;` blocks in `config.sh`, 13 of
   them identical (`:117-243`). Change: one `for VAR in …` loop.
   `test/startup-check.sh` and `test/features-check.sh` run in neither CI
   nor `mise.toml`: add them to the CI browser job.
4. **Shell and Go validation duplicated (M).** `config.sh` re-implements
   tabtopd's rules for the base path, session limits, bitrate, disasm and
   proxy count. Values only tabtopd checks (`WEB_TRUSTED_PROXIES`,
   `WEB_REMOTE_APPROVAL_URL`, `WEB_TTY_TMUX_*`, `WEB_FS_ROOTS` syntax,
   `roots.go:183`) fail only after the desktop has started, named by flag.
   Change: extend `-check-vnc-addr` into `tabtopd -check-config <flags>`,
   which runs `newServer`'s checks and exits; `config.sh` keeps only what
   needs the shell.
5. **Go test polling (S).** `eventually` (`audio_test.go:44`) allows 500 ms
   (11 uses); `waitFor` (`goroute_test.go:385`) 10 s; 24 inline deadline
   loops from 1 to 10 s (e.g. `remote_auth_test.go:77`,
   `goengine_test.go:356` at 1 s). Change: one `waitUntil(t, what, cond)`
   with a budget that can be scaled for `-race` and CI.
6. **`go-check.mjs` boilerplate (M–L).** The fresh-tab `window.__leaving`
   sequence (16 copies), `go_url` submit (29), `go_view` rect (27),
   `goTo(index)` (32), Settings close (9). About 22 of the 107 `sleep`s are
   "sleep, then assert nothing happened", which can pass falsely (e.g.
   `:3158`). Change: helpers (`freshTab`, `submitUrl`, `viewOrigin`,
   `closeSettings`), absence checks behind a sentinel event, then split into
   modules under `test/browser/`.
7. **Smaller (S).**
   - `totp()` is identical in `browser-check.mjs:67` and
     `go-check.mjs:1502`: move it into `harness.mjs`.
   - Cleanup traps and readiness polls repeat across five `.sh` scripts
     with budgets of 30, 60 and 120 s: a `test/lib.sh` with `up`,
     `wait_healthy`, `free_port`.
   - `newRootsServer` (`roots_test.go:46`) and `newTransferServer`
     (`copy_roots_test.go:18`) are the same shape; `newShareServer`,
     `newFetchServer` and `newGoServer` change the server after `newServer`
     (e.g. building `g.shares` by hand). Change:
     `newE2EServerWith(t, func(*serverConfig))`.
   - CI: the "load image from GHA cache" step appears four times and the
     two tag lists are identical: a composite action and a push matrix.
   - The vm worker harness (`self`, `ask`, `line`) repeats in five
     `scripts/disasm/check-*.mjs`: a `worker-harness.mjs`, added to the
     `COPY` at `Dockerfile:292`.

### F. Larger, for later

1. **Two resumable-upload systems (M–L).** The files page's
   (`upload_manager.go`) and share links' (`share_chunks.go`) duplicate the
   memory of finished uploads (`upload_manager.go:47` vs
   `share_chunks.go:80`), pausing while a folder is moved or deleted
   (`upload_manager.go:355-420` vs `share_chunks.go:481-557`, a holder count
   vs a busy flag), and the write loop (`share_upload.go:173-211` vs
   `share_chunks.go:413-469`). `holdWrites` (`delete.go:161`) calls both,
   and the space check sees only the files page's partials. Change: one
   store per root with a hook for share links, and one `receiveInto`.
2. **Sandbox every preview helper process (L, hardening).**
   `isolated_child.go` shares the runner, but only the HEIC child sets
   resource limits and a system-call filter (`heif.go:80-82`). The SQLite
   (`sqlite.go:924`), EPUB and Markdown children parse untrusted files with
   the server user's full rights, including read access to the users file.
   Change: a table replacing the five `if`s at `main.go:126-140`, and a
   shared startup step with limits and a generalised HEIC deny-list. SQLite
   may need care once file opening is denied.
3. **Optional asset bundles (M).** About 10 bundles are each wired in seven
   places: config field, flag, server field (`main.go:72-81`), two
   accessors in `page_assets.go`, a serve case (`page_assets.go:438-447`),
   the offline list (`offline_assets.go:55`, `:80`) and a startup warning
   (`main.go:312-339`, which covers only 4). Change: one table of bundles.
4. **Tunnel handler signature (S–M).** About 35 adapter functions in
   `tunnel_routes.go:136-187`, because handlers take tunnel, request,
   session, IP and responder in about 8 orders. Change: all take
   `*tunnelCall`; drop the unused `t` from `tunnelMkdir` and
   `tunnelCreate` (`upload.go:158`, `:181`); a `req.dir()` for the ~12
   places that trim and clean `req.Path` inconsistently.
5. **Split the largest closures (L).** `hexView` (1,313 lines; move the
   disassembly panel and instruction editing, `~:683-1128`, into a module),
   `imageView` (1,285, of which `startEditing` is 1,053; make crop, resize
   and background removal tools like `drawTool`/`placeTool`, after D1),
   `preview()` (866), `pdfImageEditor` (539), `goMedia` in `go-media.js`
   (one 1,183-line closure).
6. **Smaller.**
   - `by, ip, who, from, userAgent` travel together through nine
     signatures in `fetch.go` and `gostreammse.go` (`:505`, `:867`,
     `:956`): a `fetchOrigin` struct. `fetch.go:312-331`'s five `start*`
     wrappers with eight positional arguments: a `fetchSpec`.
   - Stale comments: `roots.go:56-58` (the folder-write tracker covers far
     more than share uploads and ZIP extraction); `main.go`'s header (only
     Downloads and TOTP); `go-media.js:137` and `:1125` name `go-player.js`
     (probably `video-player.js`).
   - Dead code: `ebmlIDLen` (`gowebm.go:216`) and `toBase64`
     (`go-device.js:304`).

## Suggested order

1. A1–A5 and E1–E2: a day's work that closes drift, much of it
   security-relevant, and the known flaky checks.
2. B and C together: they're the same lifecycle problem on the server and
   in the page, and fix most of the bugs above.
3. D.
4. F only alongside other work in those areas.

## How the review was done

- Clone detection: jscpd 4.0.5 (50 tokens) over git-tracked JS, MJS, CSS
  and shell outside `test/`; dupl 1.0.0 (40 tokens) over non-test Go in
  `tabtopd/`.
- Five reviewers read their areas in parallel: the remote browser's server
  Go, its client JS, the rest of the Go server, the rest of the browser JS,
  and tests and scripts. Their main claims were then checked against the
  code (marked Verified above).
- Not reviewed in depth: `go-media.js`, `mse-capture.js`,
  `video-player.js`, `go-sites.js`, `go-settings.js` (function sizes only),
  and most of `go-frame.js` beyond its message handling. The dead-code
  checks were by grep; the `deadcode` tool couldn't be run.
