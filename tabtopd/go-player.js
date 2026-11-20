// The remote browser's own video player (see docs/browser-plan.md, section
// 6): a video of the page taken into it, over the whole screen, from its
// box (the same player, moved: what it's buffered, and a site's stream fed
// to it, go on), with controls of its own: play and pause, back and on 10
// seconds, where it is, its speed, Skip, full screen, and closing it (back
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
    full: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
    unfull: '<path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/>',
    close: '<path d="M6 6l12 12M18 6L6 18"/>',
};
const icon = (name) => `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;

function clock(t) {
    if (!Number.isFinite(t) || t < 0) return "–:––";
    t = Math.floor(t);
    const h = Math.floor(t / 3600), m = Math.floor(t / 60) % 60, s = t % 60;
    return (h ? `${h}:${String(m).padStart(2, "0")}` : String(m)) + ":" + String(s).padStart(2, "0");
}

// openPlayer takes media (a video element, the page's player's) into the
// player, full screen; skip (if given) skips it (the page told it played
// to its end); closed is called, the element given back, as it's closed.
// It returns close.
export function openPlayer(media, { title = "", skip, download, closed } = {}) {
    const box = document.createElement("div");
    box.id = "go_player";
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
    // Download: saved into Downloads (the server's: Files), how it goes said
    // under its title.
    const note = Object.assign(document.createElement("span"), { className: "note" });
    note.setAttribute("role", "status");
    const saved = download ? button("download", "Download it into Downloads", () => download((text) => { note.textContent = text; awake(); })) : null;
    const skipped = skip ? button("skip", "Skip to its end (Shift+N)", () => { skip(); close(); }) : null;
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
    row.append(time, spacer, speed, ...(saved ? [saved] : []), ...(skipped ? [skipped] : []), full);
    bar.append(seek, row);
    // A double tap's mark: back or on, where it was.
    const flash = Object.assign(document.createElement("div"), { className: "flash" });
    flash.setAttribute("aria-hidden", "true");
    box.append(stage, top, middle, bar, flash);

    // The video, taken from its box: its own controls off (these instead),
    // as it was given back.
    const was = { parent: media.parentNode, next: media.nextSibling, style: media.getAttribute("style"), controls: media.controls };
    media.controls = false;
    media.removeAttribute("style");
    media.dataset.player = "";  // (its box's scrolling isn't passed on: go-media.js)
    stage.append(media);
    document.body.append(box);

    // Its state shown, as it plays.
    const shown = () => {
        const d = Number.isFinite(media.duration) ? media.duration : 0;
        seek.max = String(d || 0);
        if (!seeking) seek.value = String(media.currentTime || 0);
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
    seek.addEventListener("input", () => { seeking = true; time.textContent = `${clock(Number(seek.value))} / ${clock(media.duration)}`; awake(); });
    seek.addEventListener("change", () => { seeking = false; media.currentTime = Number(seek.value); });
    const by = (s) => {
        const d = Number.isFinite(media.duration) ? media.duration : Infinity;
        media.currentTime = Math.min(Math.max(0, (media.currentTime || 0) + s), d);
    };

    // The controls: hidden while it plays untouched, shown as it's touched.
    let idle = 0;
    function awake() {
        box.classList.add("awake");
        clearTimeout(idle);
        idle = setTimeout(() => { if (!media.paused && !bar.contains(document.activeElement)) box.classList.remove("awake"); }, IDLE);
    }
    box.addEventListener("pointermove", awake);
    // A tap on the video: the controls shown (or, shown, hidden), a moment
    // after (a second tap may follow); a double tap at its left or right
    // half: back or on 10 s, as video apps do, marked where it was (more
    // taps, more: each another 10 s).
    let lastTap = 0, tapTimer = 0, flashTimer = 0;
    const show = () => {
        if (box.classList.contains("awake") && !media.paused) box.classList.remove("awake");
        else awake();
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
        if (e.target === speed || e.target === seek && /^Arrow/.test(e.key)) return;
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
    // way, where the browser lets it be.
    function turnScreen() {
        if (navigator.maxTouchPoints <= 0 || !screen.orientation?.lock) return;
        const w = media.videoWidth, h = media.videoHeight;
        if (!w || !h) {
            media.addEventListener("loadedmetadata", turnScreen, { once: true });
            return;
        }
        screen.orientation.lock(h > w ? "portrait" : "landscape").catch(() => {});
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
        if (!isFull) screen.orientation?.unlock?.();
    };
    document.addEventListener("fullscreenchange", fullChanged);

    let done = false;
    function close() {
        if (done) return;
        done = true;
        clearTimeout(idle);
        clearTimeout(tapTimer);
        clearTimeout(flashTimer);
        document.removeEventListener("fullscreenchange", fullChanged);
        for (const type of events) media.removeEventListener(type, shown);
        if (document.fullscreenElement === box) document.exitFullscreen().catch(() => {});
        screen.orientation?.unlock?.();
        // Given back to its box, as it was.
        media.controls = was.controls;
        if (was.style !== null) media.setAttribute("style", was.style);
        delete media.dataset.player;
        if (was.parent?.isConnected) was.parent.insertBefore(media, was.next?.parentNode === was.parent ? was.next : null);
        box.remove();
        closed?.();
    }

    shown();
    awake();
    box.focus();
    toggleFull();  // (asked as it's opened: the person's click, in the menu)
    return close;
}
