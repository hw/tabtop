// TabTop's own video player: the remote browser's (see
// docs/browser-plan.md, section 6; go-media.js), and the files page's
// preview's (preview-renderers.js). A video taken into it, over the whole
// screen, from its box (the same player, moved: what it's buffered, and a site's stream fed
// to it, go on), with controls of its own: play and pause, back and on 10
// seconds, where it is, its speed, Skip, Turn (the other way: portrait or
// landscape), full screen, and closing it (back
// to its box), and saving it (a file's: Download). Its proportions kept (the screen's black around it). Full
// screen on a phone, the screen's turned to the video's way: a tall video
// upright, a wide one sideways, however the phone's held (where the
// browser lets a page turn it: Android's, not an iPhone's).

const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
const STEP = 10;  // seconds back or on
const IDLE = 3000;  // the controls hidden, playing, after so long untouched

const ICONS = {
    play: '<path d="M8 5v14l11-7z" fill="currentColor" stroke="none"/>',
    pause: '<path d="M7 5h4v14H7zM13 5h4v14h-4z" fill="currentColor" stroke="none"/>',
    // Back and on: a turn the clock's way back, or on, 10 in it.
    back: '<path d="M3.5 12a8.5 8.5 0 1 0 2.5-6"/><path d="M3.5 3.5V8h4.5"/><text x="12.5" y="15.5" font-size="7.5" font-weight="700" text-anchor="middle" fill="currentColor" stroke="none" font-family="system-ui, sans-serif">10</text>',
    on: '<path d="M20.5 12a8.5 8.5 0 1 1-2.5-6"/><path d="M20.5 3.5V8H16"/><text x="11.5" y="15.5" font-size="7.5" font-weight="700" text-anchor="middle" fill="currentColor" stroke="none" font-family="system-ui, sans-serif">10</text>',
    skip: '<path d="M5 5l9 7-9 7z M16 5h3v14h-3z" fill="currentColor" stroke="none"/>',
    download: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
    // Turn: two arrows around, the other way to watch it.
    turn: '<path d="M4 12a8 8 0 0 1 13.7-5.6M20 3.5V8h-4.5"/><path d="M20 12a8 8 0 0 1-13.7 5.6M4 20.5V16h4.5"/>',
    full: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
    unfull: '<path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/>',
    close: '<path d="M6 6l12 12M18 6L6 18"/>',
    // Saving: a stop square in a ring, the ring filled as it goes (--done,
    // a percent; unknown, a quarter turning).
    saving: '<circle class="ring-track" cx="12" cy="12" r="10"/><circle class="ring" cx="12" cy="12" r="10" pathLength="100"/><rect x="8.5" y="8.5" width="7" height="7" rx="1" fill="currentColor" stroke="none"/>',
};
// Its look, put in the page once: the pages it's on allow inline styles,
// not stylesheets of the site's.
const STYLE = `
/* The player: over everything, the
   video kept to its proportions; at its top what it is and closing it, in
   its middle back, play and on, at its bottom where it is and the rest:
   all hidden together while it plays untouched, as video apps' are. Its
   glyphs as the menu's. */
#video_player { position: fixed; inset: 0; z-index: 50; background: #000; outline: none; color: #fff; font: 14px system-ui, sans-serif; user-select: none; -webkit-user-select: none;
    -webkit-tap-highlight-color: transparent; }
/* The video has the whole screen (a notch's too); its controls over it
   keep clear of the screen's edges (safe-area insets). */
#video_player .stage { position: absolute; inset: 0; }
/* No frame about it: not a tap's highlight, a focus ring, nor the menu's
   outline of it (its row pointed at). */
#video_player video { width: 100%; height: 100%; object-fit: contain; background: #000; display: block; border: 0; outline: none !important; box-shadow: none; }
/* Turned (Turn, where the screen can't be turned instead): the video a
   quarter turn round, its width the screen's height. */
#video_player.turned video { position: absolute; top: 50%; left: 50%; width: 100vh; width: 100dvh; height: 100vw; transform: translate(-50%, -50%) rotate(90deg); }
#video_player .glyph[aria-pressed="true"] { background: rgba(138, 180, 248, .3); }
#video_player .top, #video_player .middle, #video_player .bar { transition: opacity .2s; }
#video_player:is(.controls-hidden, :not(.awake):not(.paused)) :is(.top, .middle, .bar) { opacity: 0; pointer-events: none; }
/* (Their buttons too, which take taps of their own when shown: hidden, a
   tap's the video's, to show them, not an unseen button's.) */
#video_player:is(.controls-hidden, :not(.awake):not(.paused)) :is(.top, .middle, .bar) * { pointer-events: none !important; }
#video_player:is(.controls-hidden, :not(.awake):not(.paused)) { cursor: none; }
#video_player .download-progress { position: absolute; inset: auto 0 0; height: 2px; overflow: hidden; pointer-events: none; }
#video_player .download-progress[hidden] { display: none; }
#video_player .download-progress::after { content: ""; display: block; height: 100%; width: var(--download-width, 0%); background: #fff; }
#video_player .download-progress:not([aria-valuenow])::after { width: 25%; animation: video-download 1.2s linear infinite; }
@keyframes video-download { from { transform: translateX(-100%); } to { transform: translateX(400%); } }
@media (prefers-reduced-motion: reduce) { #video_player .download-progress:not([aria-valuenow])::after { animation: none; } }
/* Download, saving: its ring filled as it goes; Cancel by a tap. */
#video_player .glyph.saving .ring-track { stroke: rgba(255, 255, 255, .3); }
#video_player .glyph.saving .ring { stroke: #8ab4f8; stroke-dasharray: var(--done, 25) 100; transform: rotate(-90deg); transform-origin: 12px 12px; }
#video_player .glyph.saving:not([data-done]) .ring { animation: video-saving 1.2s linear infinite; }
@keyframes video-saving { to { transform: rotate(270deg); } }
@media (prefers-reduced-motion: reduce) { #video_player .glyph.saving .ring { animation: none; } }
#video_player .glyph:disabled { opacity: .5; cursor: default; }
#video_player .glyph:disabled:hover { background: none; }
#video_player .top { position: absolute; top: 0; left: 0; right: 0; display: flex; align-items: flex-start; gap: 8px;
    padding: calc(6px + env(safe-area-inset-top, 0)) calc(6px + env(safe-area-inset-right, 0)) 28px calc(16px + env(safe-area-inset-left, 0));
    background: linear-gradient(rgba(0, 0, 0, .75), transparent); }
#video_player .about { flex: 1; min-width: 0; padding-top: 11px; }
#video_player .title { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
#video_player .note { display: block; margin-top: 2px; font-size: 12px; color: #d0d0d4; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#video_player .note:empty { display: none; }
#video_player .middle { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; gap: 36px; pointer-events: none; }
#video_player .middle .glyph { pointer-events: auto; background: rgba(0, 0, 0, .4); }
#video_player .bar { position: absolute; left: 0; right: 0; bottom: 0;
    padding: 28px calc(10px + env(safe-area-inset-right, 0)) calc(6px + env(safe-area-inset-bottom, 0)) calc(10px + env(safe-area-inset-left, 0));
    background: linear-gradient(transparent, rgba(0, 0, 0, .8)); }
#video_player .seek { width: 100%; margin: 0 0 2px; height: 24px; appearance: none; background: transparent;
    --seek-track: linear-gradient(to right, #8ab4f8 var(--played, 0%), transparent 0%), var(--buffered, none); }
#video_player .seek::-webkit-slider-runnable-track { height: 5px; border-radius: 3px; background: var(--seek-track) #45454b; }
#video_player .seek::-moz-range-track { height: 5px; border-radius: 3px; background: var(--seek-track) #45454b; }
#video_player .seek::-webkit-slider-thumb { appearance: none; width: 15px; height: 15px; margin-top: -5px;
    border: 0; border-radius: 50%; background: #8ab4f8; }
#video_player .seek::-moz-range-thumb { width: 15px; height: 15px; border: 0; border-radius: 50%; background: #8ab4f8; }
#video_player .row { display: flex; align-items: center; gap: 2px; }
#video_player .spacer { flex: 1; }
#video_player .time { margin-left: 6px; font-variant-numeric: tabular-nums; white-space: nowrap; font-size: 13px; }
#video_player .glyph { display: inline-flex; align-items: center; justify-content: center; width: 44px; height: 44px; padding: 0; border: 0;
    border-radius: 50%; background: none; color: #fff; cursor: pointer; }
#video_player .glyph.mid { width: 56px; height: 56px; }
#video_player .glyph.mid svg { width: 30px; height: 30px; }
#video_player .glyph.big { width: 72px; height: 72px; }
#video_player .glyph.big svg { width: 40px; height: 40px; }
#video_player .glyph:hover { background: rgba(255, 255, 255, .18); }
#video_player .glyph:focus-visible, #video_player .speed:focus-visible, #video_player .seek:focus-visible { outline: 2px solid #8ab4f8; outline-offset: 1px; }
/* Its speed: a label as the glyphs are (no box), its choices the browser's. */
#video_player .speed { -webkit-appearance: none; appearance: none; height: 44px; min-width: 44px; margin: 0; padding: 0 8px; border: 0; border-radius: 22px;
    background: none; color: #fff; font: 700 14px system-ui, sans-serif; text-align: center; text-align-last: center; cursor: pointer; }
#video_player .stream-picker { max-width: 30vw; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#video_player .speed:hover { background: rgba(255, 255, 255, .18); }
#video_player .speed option { color: #000; }
#video_player .flash { position: absolute; top: 50%; transform: translateY(-50%); padding: 10px 18px; border-radius: 24px; background: rgba(0, 0, 0, .6);
    font-weight: 600; opacity: 0; transition: opacity .15s; pointer-events: none; }
#video_player .flash.left { left: 10%; }
#video_player .flash.right { right: 10%; }
#video_player .flash.shown { opacity: 1; }
@media (max-width: 420px) { #video_player .middle { gap: 24px; } #video_player .glyph { width: 40px; height: 40px; } #video_player .time { font-size: 12px; } }
@media (prefers-reduced-motion: reduce) { #video_player :is(.top, .middle, .bar, .flash) { transition: none; } }
`;
function styled() {
    if (document.getElementById("video_player_style")) return;
    document.head.append(Object.assign(document.createElement("style"), { id: "video_player_style", textContent: STYLE }));
}

const icon = (name) => `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;

function clock(t) {
    if (!Number.isFinite(t) || t < 0) return "–:––";
    t = Math.floor(t);
    const h = Math.floor(t / 3600), m = Math.floor(t / 60) % 60, s = t % 60;
    return (h ? `${h}:${String(m).padStart(2, "0")}` : String(m)) + ":" + String(s).padStart(2, "0");
}

// openPlayer takes media (a video element, the page's player's) into the
// player, full screen; skip (if given) skips it (the page told it played
// to its end); download (if given) saves it, saying how it goes, by
// downloadTitle; closed is called, the element given back, as it's
// closed. It's put in into (the page's body; in a modal dialog, which is
// over everything else, the dialog). It returns close.
export function openPlayer(media, { title = "", skip, download, streams = [], downloadTitle = "Download it into Downloads", closed, into = document.body } = {}) {
    styled();
    const box = document.createElement("div");
    box.id = "video_player";
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-modal", "true");
    box.setAttribute("aria-label", title ? `Video: ${title}` : "Video");
    box.tabIndex = -1;
    const stage = Object.assign(document.createElement("div"), { className: "stage" });
    const bar = Object.assign(document.createElement("div"), { className: "bar" });
    const button = (name, label, act, className = "glyph") => {
        const b = Object.assign(document.createElement("button"), { type: "button", className, title: label });
        b.setAttribute("aria-label", label.replace(/ \(.*\)$/, ""));
        b.innerHTML = icon(name);
        b.addEventListener("click", (e) => { e.stopPropagation(); act(); awake(); });
        return b;
    };
    const seek = Object.assign(document.createElement("input"), { type: "range", min: "0", max: "0", step: "0.1", value: "0", className: "seek" });
    seek.setAttribute("aria-label", "Where in the video");
    const time = Object.assign(document.createElement("span"), { className: "time" });
    const play = button("play", "Play (Space)", () => (media.paused || media.ended ? media.play().catch(() => {}) : media.pause()), "glyph big");
    const back = button("back", `Back ${STEP} seconds (←, or a double tap at the left)`, () => by(-STEP), "glyph mid");
    const on = button("on", `On ${STEP} seconds (→, or a double tap at the right)`, () => by(STEP), "glyph mid");
    const speed = document.createElement("select");
    speed.className = "speed";
    speed.setAttribute("aria-label", "Speed");
    speed.title = "Speed (< and >)";
    for (const s of SPEEDS) speed.append(Object.assign(document.createElement("option"), { value: String(s), textContent: `${s}×`, selected: s === media.playbackRate }));
    if (!SPEEDS.includes(media.playbackRate)) speed.value = "1";
    speed.addEventListener("change", () => { media.playbackRate = Number(speed.value); awake(); });
    speed.addEventListener("click", (e) => e.stopPropagation());
    const note = Object.assign(document.createElement("span"), { className: "note" });
    note.setAttribute("role", "status");
    const downloadProgress = Object.assign(document.createElement("div"), { className: "download-progress", hidden: true });
    downloadProgress.setAttribute("role", "progressbar");
    downloadProgress.setAttribute("aria-label", "Video download");
    let streamPicker;
    if (streams.length > 1) {
        streamPicker = Object.assign(document.createElement("select"), { className: "speed stream-picker" });
        streamPicker.setAttribute("aria-label", "Stream to save from this page");
        for (const stream of streams) streamPicker.add(new Option(stream.label));
    }
    if (streams.length) download = (say, opts) => streams[streamPicker?.selectedIndex ?? 0].save(say, opts);
    let cancelDownload;
    const saved = download ? button("download", downloadTitle, () => {
        if (cancelDownload) cancelDownload();
        else download(updateDownload);
    }) : null;
    // updateDownload shows what the download says: text, and, while it
    // saves, fraction (a number, or null: not known how far) and cancel
    // (none while it's cancelling). Saving, Download's a ring that fills,
    // a tap cancelling it, and the text (its percent too) under the title;
    // done, the text alone, the controls shown for it.
    let wasActive = false, live = false;  // (live: opened, not closed)
    function updateDownload(text, fraction, cancel) {
        const active = fraction !== undefined;
        const percent = typeof fraction === "number" ? Math.floor(fraction * 100) : null;
        downloadProgress.hidden = !active;
        cancelDownload = active && cancel;
        saved.disabled = active && !cancel;
        saved.classList.toggle("saving", active);
        const label = !active ? downloadTitle : cancel ? `Cancel download${percent !== null ? ` (${percent}%)` : ""}` : "Cancelling download";
        saved.title = label;
        saved.setAttribute("aria-label", label);
        if (saved.dataset.icon !== (active ? "saving" : "download")) {
            saved.dataset.icon = active ? "saving" : "download";
            saved.innerHTML = icon(saved.dataset.icon);
        }
        note.textContent = active && percent !== null ? `${text.replace(/…$/, "")} · ${percent}%` : text || "";
        if (percent !== null) {
            saved.dataset.done = "";
            saved.style.setProperty("--done", String(Math.max(percent, 1)));
            downloadProgress.style.setProperty("--download-width", `${percent}%`);
            downloadProgress.setAttribute("aria-valuenow", String(percent));
        } else {
            delete saved.dataset.done;
            saved.style.removeProperty("--done");
            downloadProgress.removeAttribute("aria-valuenow");
        }
        // Started, or ended: shown, not missed under controls hidden.
        if (active !== wasActive && text && live) awake();
        wasActive = active;
    }
    // A download of it going on (the player closed and opened again while
    // it saves): shown, its Cancel too, not offered again. Another stream
    // picked: its download, if one's going on; else Download, for it (not
    // Cancel, for the one picked before).
    if (download) download(updateDownload, { attach: true });
    streamPicker?.addEventListener("change", () => {
        download(updateDownload, { detach: true });
        updateDownload("", undefined);
        download(updateDownload, { attach: true });
    });
    const skipped = skip ? button("skip", "Skip to its end (Shift+N)", () => { skip(); close(); }) : null;
    const turn = button("turn", "Turn it the other way (R)", () => { turned = !turned; turn.setAttribute("aria-pressed", String(turned)); turnScreen(); });
    turn.setAttribute("aria-pressed", "false");
    const full = button("full", "Full screen (F)", () => toggleFull());
    const shut = button("close", "Close the player (Esc)", () => close());
    // At its top, what it is and closing it; in its middle, back, play and
    // on; at its bottom, where it is, its speed, and the rest. All hidden
    // together while it plays untouched (awake).
    const top = Object.assign(document.createElement("div"), { className: "top" });
    const about = Object.assign(document.createElement("div"), { className: "about" });
    about.append(Object.assign(document.createElement("span"), { className: "title", textContent: title }), note);
    top.append(about, shut);
    const middle = Object.assign(document.createElement("div"), { className: "middle" });
    middle.append(back, play, on);
    const row = Object.assign(document.createElement("div"), { className: "row" });
    const spacer = Object.assign(document.createElement("span"), { className: "spacer" });
    row.append(time, spacer, speed, ...(streamPicker ? [streamPicker] : []), ...(saved ? [saved] : []), ...(skipped ? [skipped] : []), turn, full);
    bar.append(seek, row);
    // A double tap's mark: back or on, where it was.
    const flash = Object.assign(document.createElement("div"), { className: "flash" });
    flash.setAttribute("aria-hidden", "true");
    box.append(stage, top, middle, bar, flash, downloadProgress);

    // The video, taken from its box: its own controls off (these instead),
    // as it was given back.
    const was = { parent: media.parentNode, next: media.nextSibling, style: media.getAttribute("style"), controls: media.controls, tabIndex: media.getAttribute("tabindex") };
    media.controls = false;
    media.removeAttribute("style");
    media.tabIndex = -1;  // (focused by a click: no ring of its own)
    media.dataset.player = "";  // (in the player: go-media.js passes its box's scrolling on, not this)
    stage.append(media);
    into.append(box);

    const showBuffered = () => {
        const duration = media.duration;
        const stops = [];
        if (Number.isFinite(duration) && duration > 0) {
            const ranges = media.buffered;
            for (let i = 0; i < ranges.length; i++) {
                const start = Math.max(0, ranges.start(i));
                const end = Math.min(duration, ranges.end(i));
                if (end <= start) continue;
                const from = `${100 * start / duration}%`, to = `${100 * end / duration}%`;
                stops.push(`transparent ${from}, #929299 ${from} ${to}, transparent ${to}`);
            }
        }
        seek.style.setProperty("--buffered", stops.length ? `linear-gradient(to right, ${stops.join(", ")})` : "none");
    };
    const showPlayed = () => {
        seek.style.setProperty("--played", `${seek.max > 0 ? 100 * seek.value / seek.max : 0}%`);
    };
    // Poll as well as listening for progress: Media Source buffers can
    // change while playback is paused without a media element event.
    const bufferEvents = ["progress", "durationchange", "emptied"];
    for (const type of bufferEvents) media.addEventListener(type, showBuffered);
    const bufferTimer = setInterval(showBuffered, 500);

    // Its state shown, as it plays.
    const shown = () => {
        const d = Number.isFinite(media.duration) ? media.duration : 0;
        seek.max = String(d || 0);
        if (!seeking) seek.value = String(media.currentTime || 0);
        showPlayed();
        seek.disabled = !d;
        time.textContent = `${clock(media.currentTime)} / ${clock(d)}`;
        const paused = media.paused || media.ended;
        play.innerHTML = icon(paused ? "play" : "pause");
        play.title = paused ? "Play (Space)" : "Pause (Space)";
        play.setAttribute("aria-label", paused ? "Play" : "Pause");
        box.classList.toggle("paused", paused);
    };
    const events = ["timeupdate", "durationchange", "loadedmetadata", "play", "pause", "ended", "ratechange", "seeked"];
    for (const type of events) media.addEventListener(type, shown);
    media.addEventListener("ratechange", () => { speed.value = String(media.playbackRate); });
    let seeking = false;
    seek.addEventListener("input", () => { seeking = true; showPlayed(); time.textContent = `${clock(Number(seek.value))} / ${clock(media.duration)}`; awake(); });
    seek.addEventListener("change", () => { seeking = false; media.currentTime = Number(seek.value); });
    const by = (s) => {
        const d = Number.isFinite(media.duration) ? media.duration : Infinity;
        media.currentTime = Math.min(Math.max(0, (media.currentTime || 0) + s), d);
    };

    // The controls: hidden while it plays untouched, shown as it's touched.
    let idle = 0;
    function awake() {
        box.classList.remove("controls-hidden");
        box.classList.add("awake");
        clearTimeout(idle);
        idle = setTimeout(() => { if (!media.paused && !bar.querySelector(":focus-visible")) box.classList.remove("awake"); }, IDLE);
    }
    box.addEventListener("focusin", (e) => {
        if (e.target.matches("button:focus-visible, select:focus-visible, input:focus-visible")) awake();
    });
    box.addEventListener("pointermove", awake);
    // A tap on the video: the controls shown (or, shown, hidden), a moment
    // after (a second tap may follow); a double tap at its left or right
    // half: back or on 10 s, as video apps do, marked where it was (more
    // taps, more: each another 10 s).
    let lastTap = 0, tapTimer = 0, flashTimer = 0;
    const show = () => {
        if (box.classList.contains("controls-hidden") || !box.classList.contains("awake") && !media.paused) {
            awake();
        } else {
            box.focus();
            box.classList.add("controls-hidden");
        }
    };
    box.addEventListener("click", (e) => {
        if (e.target.closest("button, select, input")) return;
        const now = performance.now(), r = box.getBoundingClientRect(), right = e.clientX - r.left > r.width / 2;
        if (now - lastTap < 350) {
            clearTimeout(tapTimer);
            by(right ? STEP : -STEP);
            flash.textContent = right ? `${STEP} s ⏩` : `⏪ ${STEP} s`;
            flash.className = "flash shown " + (right ? "right" : "left");
            clearTimeout(flashTimer);
            flashTimer = setTimeout(() => { flash.className = "flash"; }, 600);
            lastTap = now;  // (and a third tap, another)
            return;
        }
        lastTap = now;
        tapTimer = setTimeout(show, 250);
    });
    box.addEventListener("keydown", (e) => {
        if (e.target.tagName === "SELECT" || e.target === seek && /^Arrow/.test(e.key)) return;
        const key = e.key;
        if (key === "Escape") {
            if (!document.fullscreenElement) { e.preventDefault(); close(); }
            return;
        }
        const acts = {
            " ": () => (media.paused || media.ended ? media.play().catch(() => {}) : media.pause()),
            k: () => (media.paused ? media.play().catch(() => {}) : media.pause()),
            ArrowLeft: () => by(-STEP), j: () => by(-STEP),
            ArrowRight: () => by(STEP), l: () => by(STEP),
            f: () => toggleFull(),
            r: () => turn.click(),
            "<": () => rate(-1), ">": () => rate(1),
            N: () => skip && (skip(), close()),
        };
        if (e.target.tagName === "BUTTON" && (key === " " || key === "Enter")) return;  // the button's own
        const act = acts[key];
        if (!act || e.ctrlKey || e.metaKey || e.altKey) return;
        e.preventDefault();
        act();
        awake();
    });
    const rate = (step) => {
        const i = Math.max(0, SPEEDS.indexOf(media.playbackRate));
        media.playbackRate = SPEEDS[Math.min(SPEEDS.length - 1, Math.max(0, (SPEEDS.includes(media.playbackRate) ? i : 3) + step))];
    };

    // Full screen: the player's; on a phone, the screen turned the video's
    // way, where the browser lets it be. Turn (turned) overrides that: the
    // screen turned the other way; where it can't be (not full screen, an
    // iPhone, a desktop), the video itself turned a quarter round.
    let turned = false;
    async function turnScreen() {
        let byScreen = false;
        if (document.fullscreenElement === box && navigator.maxTouchPoints > 0 && screen.orientation?.lock) {
            const w = media.videoWidth, h = media.videoHeight;
            if (!w || !h) {
                media.addEventListener("loadedmetadata", turnScreen, { once: true });
                box.classList.toggle("turned", turned);
                return;
            }
            try {
                await screen.orientation.lock((h > w) !== turned ? "portrait" : "landscape");
                byScreen = true;
            } catch { /* not here: the video turned instead */ }
        }
        if (!done) box.classList.toggle("turned", turned && !byScreen);
    }
    async function toggleFull() {
        try {
            if (document.fullscreenElement === box) await document.exitFullscreen();
            else {
                await box.requestFullscreen({ navigationUI: "hide" });
                turnScreen();
            }
        } catch { /* not here: the window's all it has */ }
    }
    const fullChanged = () => {
        const isFull = document.fullscreenElement === box;
        full.innerHTML = icon(isFull ? "unfull" : "full");
        full.setAttribute("aria-label", isFull ? "Leave full screen" : "Full screen");
        full.title = isFull ? "Leave full screen (F)" : "Full screen (F)";
        if (!isFull) {
            screen.orientation?.unlock?.();
            if (turned) turnScreen();  // (turned by the screen no more: the video, then)
        }
    };
    document.addEventListener("fullscreenchange", fullChanged);

    let done = false;
    function close() {
        if (done) return;
        done = true;
        live = false;
        clearTimeout(idle);
        clearTimeout(tapTimer);
        clearTimeout(flashTimer);
        document.removeEventListener("fullscreenchange", fullChanged);
        for (const type of events) media.removeEventListener(type, shown);
        for (const type of bufferEvents) media.removeEventListener(type, showBuffered);
        clearInterval(bufferTimer);
        if (document.fullscreenElement === box) document.exitFullscreen().catch(() => {});
        screen.orientation?.unlock?.();
        // Given back to its box, as it was.
        media.controls = was.controls;
        if (was.style !== null) media.setAttribute("style", was.style);
        if (was.tabIndex === null) media.removeAttribute("tabindex");
        else media.setAttribute("tabindex", was.tabIndex);
        delete media.dataset.player;
        // What its download says goes to the page now, not to it, gone.
        download?.(updateDownload, { detach: true });
        if (was.parent?.isConnected) was.parent.insertBefore(media, was.next?.parentNode === was.parent ? was.next : null);
        box.remove();
        closed?.();
    }

    shown();
    showBuffered();
    live = true;
    awake();
    box.focus();
    toggleFull();  // (asked as it's opened: the person's click, in the menu)
    return close;
}
