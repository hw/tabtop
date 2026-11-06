// Browser terminal, served by tabtopd (see tty.go), drawn by ghostty-web.
// Terminal bytes travel as data messages through the encrypted tunnel;
// resizes go up as JSON text messages. The tunnel shows its login form
// when there's no session. Ctrl + and Ctrl − change the font size, and the
// "Aa" menu the font and size, kept in this browser; on touch screens, a strip of keys phones'
// keyboards lack (Esc, Tab, Ctrl, Alt, the arrows...) sits below the
// terminal. If the connection is lost, the page tries again by itself (see
// reconnect.js), and tmux, which the server runs the shell in, picks up
// where it was (unless the server runs its own command instead,
// WEB_TTY_COMMAND, as ssh to another machine). Files and folders dropped
// on the page are uploaded into ~/Downloads, as on the files page (see
// drop.js), and their paths typed at the cursor. Ctrl+click (⌘+click on a
// Mac) opens a web address shown in the terminal, and Ctrl+Shift+F
// searches tmux's history (see Search), when there's tmux. A bell, or a
// program's notification, while the tab isn't in front marks its title,
// and shows a browser notification if they're turned on (see Notices).

import { glyphs, iconSVG } from "../tabtop/glyphs.js";
import { Osc } from "../tabtop/osc.js";
import { init, Terminal, FitAddon } from "./ghostty-web.js";
import { forgetSession, storedSession, TunnelSocket } from "../tabtop/tunnel.js";
import { nameTab, navBar } from "../tabtop/nav.js";
import { reconnect } from "../tabtop/reconnect.js";
import { warnExpiry } from "../tabtop/expiry.js";
import { dropUploads } from "../tabtop/drop.js";
import { folderInfo, makeFolder, setLoginTitle, shellPath, uploadFile } from "../tabtop/requests.js";

// Links to the desktop and the files page, Search, notifications, and Log
// out, all icons, in a bar above the terminal.
nameTab("terminal");
document.body.prepend(navBar("terminal", { logOutIcon: true }));
warnExpiry();

// ghostty-web opens links in the terminal, on Ctrl+click, with
// window.open: only web addresses, since a program can show a link (OSC 8)
// to anything, as a javascript: one that would run on this site; and with
// noopener and noreferrer, so the page opened can't reach back to this one
// through window.opener (and send it elsewhere), nor learn its address.
const openWindow = window.open.bind(window);
window.open = (url, target, features) => (/^(https?|ftp):\/\//i.test(String(url))
    ? openWindow(url, target || "_blank", [features, "noopener", "noreferrer"].filter(Boolean).join(","))
    : null);

// MouseReporter sends mouse events to programs that ask for them (tmux with
// "mouse on"), which ghostty-web doesn't: clicks (mode 1000), drags (1002)
// and all motion (1003), in the SGR encoding (1006) or the original one,
// and the wheel as buttons 64 and 65. Holding Shift leaves the mouse to the
// page, to select text in it instead.
class MouseReporter {
    constructor(term, send) {
        this.term = term;
        this.send = send;
        this.pressed = null;  // the button held down, if the press was reported
        this.last = "";       // the cell of the last motion report
        const inTerminal = (e) => term.element?.contains(e.target);
        // Capturing on the document runs before ghostty-web's own handlers,
        // so a reported press doesn't also start a selection.
        document.addEventListener("mousedown", (e) => {
            if (inTerminal(e) && this.active(e)) {
                this.stop(e);
                term.focus();
                this.pressed = e.button;
                this.report(this.button(e.button, e), e, false);
            }
        }, true);
        document.addEventListener("mousemove", (e) => {
            if (!this.active(e) || !(this.pressed !== null ? this.mode(1002) || this.mode(1003) : this.mode(1003) && inTerminal(e))) {
                return;
            }
            const cell = this.cell(e);
            if (cell.join() !== this.last) {
                this.last = cell.join();
                this.report(32 + (this.pressed !== null ? this.button(this.pressed, e) : this.mods(e) + 3), e, false);
            }
        }, true);
        document.addEventListener("mouseup", (e) => {
            if (this.pressed !== null) {
                this.stop(e);
                this.report(this.button(this.pressed, e), e, true);
                this.pressed = null;
            }
        }, true);
        document.addEventListener("contextmenu", (e) => {
            if (inTerminal(e) && this.active(e)) {
                e.preventDefault();
            }
        }, true);
        term.attachCustomWheelEventHandler((e) => {
            if (!this.active(e)) {
                return false;  // ghostty-web scrolls (or sends arrow keys)
            }
            const lines = e.deltaMode === WheelEvent.DOM_DELTA_PIXEL ? Math.round(Math.abs(e.deltaY) / 40) : Math.abs(e.deltaY);
            for (let i = 0; i < Math.min(Math.max(lines, 1), 5); i++) {
                this.report((e.deltaY < 0 ? 64 : 65) + this.mods(e), e, false);
            }
            return true;
        });
    }

    mode(n) {
        return this.term.getMode(n);
    }

    // Shift leaves the mouse to the page to select text, and Ctrl or ⌘ to
    // open links.
    active(e) {
        return !e.shiftKey && !e.ctrlKey && !e.metaKey && this.term.hasMouseTracking();
    }

    stop(e) {
        e.preventDefault();
        e.stopPropagation();
    }

    mods(e) {
        return (e.altKey || e.metaKey ? 8 : 0) + (e.ctrlKey ? 16 : 0);
    }

    // Left, middle and right are 0, 1 and 2, as the DOM numbers them.
    button(b, e) {
        return Math.min(b, 2) + this.mods(e);
    }

    // cell is the 1-based column and row under the pointer.
    cell(e) {
        const r = this.term.element.querySelector("canvas").getBoundingClientRect();
        const m = this.term.renderer.getMetrics();
        const clamp = (v, max) => Math.min(Math.max(v, 1), max);
        return [clamp(Math.floor((e.clientX - r.left) / m.width) + 1, this.term.cols),
            clamp(Math.floor((e.clientY - r.top) / m.height) + 1, this.term.rows)];
    }

    report(code, e, release) {
        const [col, row] = this.cell(e);
        if (this.mode(1006)) {
            this.send(new TextEncoder().encode(`\x1b[<${code};${col};${row}${release ? "m" : "M"}`));
        } else if (col <= 223 && row <= 223) {
            // The original encoding has no release per button, and bytes
            // only up to 255.
            this.send(Uint8Array.of(0x1b, 0x5b, 0x4d, 32 + (release ? 3 : code), 32 + col, 32 + row));
        }
    }
}

// The font size: Ctrl + and Ctrl − change it, and Ctrl 0 goes back to
// the default, instead of zooming the page; it's kept in this browser.
const FONT_KEY = "tabtop-tty-font-size";
const defaultFontSize = 14;
let fontSize = defaultFontSize;
try {
    const saved = Number(localStorage.getItem(FONT_KEY));
    if (saved >= 8 && saved <= 32) {
        fontSize = saved;
    }
} catch {
    // The default, then.
}
// The font: TabTop's own, JetBrains Mono Nerd Font, served with the page
// (see tty.html), or one on this computer picked from the font menu (see
// Fonts), kept in this browser. TabTop's comes after a picked one, so the
// Nerd Font icons prompts and tools draw (and tmux's status-line arrows)
// show whatever the font.
const OWN_FONT = "TabTop JetBrains Mono";
const FAMILY_KEY = "tabtop-tty-font-family";
let fontName = "";  // "" for TabTop's own
try {
    fontName = cleanFontName(localStorage.getItem(FAMILY_KEY) ?? "");
} catch {
    // TabTop's, then.
}

// cleanFontName keeps a font's name to what can go in quotes in CSS.
function cleanFontName(name) {
    return String(name).replace(/["'\\\x00-\x1f\x7f;{}]/g, "").trim().slice(0, 64);
}

function fontFamily(name) {
    return name ? `"${name}", "${OWN_FONT}", monospace` : `"${OWN_FONT}", monospace`;
}

// loadFonts loads the faces the terminal draws with before it measures
// them: drawn on a canvas, text in a font not loaded yet would stay in
// the fallback until something redraws it. Bold too, for the same reason.
function loadFonts(name) {
    const faces = [OWN_FONT, ...(name ? [name] : [])].flatMap((f) => [`${fontSize}px "${f}"`, `bold ${fontSize}px "${f}"`]);
    return Promise.all(faces.map((f) => document.fonts.load(f).catch(() => {})));
}

await loadFonts(fontName);
await init();

const term = new Terminal({
    cursorBlink: true,
    // Black like the page around it (ghostty-web's default is dark grey).
    theme: { background: "#000000" },
    fontFamily: fontFamily(fontName),
    fontSize,
});
const fit = new FitAddon();
term.loadAddon(fit);
term.open(document.getElementById("terminal"));
fit.fit();
fit.observeResize();
term.focus();

const fontChanged = [];  // called after the font or its size changes

function setFontSize(n) {
    fontSize = Math.min(Math.max(n, 8), 32);
    term.options.fontSize = fontSize;
    fit.fit();
    try {
        fontSize === defaultFontSize ? localStorage.removeItem(FONT_KEY) : localStorage.setItem(FONT_KEY, String(fontSize));
    } catch {
        // Only for this visit, then.
    }
    fontChanged.forEach((f) => f());
}

// setFont draws the terminal in the font named, "" for TabTop's own.
async function setFont(name) {
    fontName = cleanFontName(name);
    await loadFonts(fontName);
    term.options.fontFamily = fontFamily(fontName);
    fit.fit();
    try {
        fontName ? localStorage.setItem(FAMILY_KEY, fontName) : localStorage.removeItem(FAMILY_KEY);
    } catch {
        // Only for this visit, then.
    }
    fontChanged.forEach((f) => f());
}

// copied says, for a few seconds, that a program in the terminal copied
// text to the clipboard (see Osc), showing how it starts.
const copiedNote = Object.assign(document.createElement("div"), { id: "tty_copied", hidden: true });
copiedNote.setAttribute("role", "status");
document.body.append(copiedNote);
let copiedTimer = 0;
function copied(text) {
    const line = text.replace(/[\x00-\x1f\x7f]+/g, " ").trim();
    const start = line.length > 80 ? `${line.slice(0, 80)}…` : line;
    copiedNote.textContent = `The terminal copied ${text.length} character${text.length === 1 ? "" : "s"} to your clipboard`
        + (start ? `: “${start}”` : ".");
    copiedNote.hidden = false;
    clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => (copiedNote.hidden = true), 5000);
}

// Before ghostty-web sees the keys, and the browser zooms.
document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.altKey && ["=", "+", "-", "0"].includes(e.key)) {
        e.preventDefault();
        e.stopPropagation();
        setFontSize(e.key === "0" ? defaultFontSize : fontSize + (e.key === "-" ? -1 : 1));
    }
}, true);
const osc = new Osc(() => notices.bell(), (title, text) => notices.notify(title, text), (text) => {
    navigator.clipboard?.writeText(text).then(() => copied(text), () => {});
});
new MouseReporter(term, (bytes) => send(bytes));

const encoder = new TextEncoder();
let ws = null;          // the terminal's tunnel, while it's open
let connecting = false;

function send(data) {
    if (ws?.readyState === WebSocket.OPEN) {
        ws.send(data);
    }
}

function sendSize() {
    send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
}

// connect opens the terminal. It resolves to false if the server couldn't
// be reached, so it's worth trying again, else true. Once it's open,
// losing it starts trying again; the server closing it, as when the shell
// exits, waits for Enter.
function connect() {
    connecting = true;
    return new Promise((resolve) => {
        const s = new TunnelSocket({ type: "tty" }, { title: "Terminal" });
        s.binaryType = "arraybuffer";
        s.onopen = () => {
            connecting = false;
            ws = s;
            search.offer(s.reply?.search !== false);
            sendSize();
            resolve(true);
        };
        s.onmessage = (e) => {
            const bytes = new Uint8Array(e.data);
            osc.scan(bytes);
            term.write(bytes);
        };
        s.onclose = (e) => {
            connecting = false;
            const was = ws === s;
            ws = null;
            if (e.login) {
                // Logged in again since, in this tab or another: the new
                // login carries on. Otherwise, reloading shows the form.
                forgetSession(s.session);
                storedSession() ? connect().then((ok) => ok || reconnect("Can't reach the server.", connect)) : location.reload();
            } else if (e.lost) {
                if (was) {
                    term.write("\r\n\x1b[2m[Connection lost. Reconnecting…]\x1b[0m\r\n");
                    reconnect("The terminal lost its connection.", connect);
                }
            } else {
                term.write(`\r\n\x1b[2m[${e.reason || "Disconnected"}. Press Enter to reconnect.]\x1b[0m\r\n`);
            }
            resolve(!e.lost);
        };
    });
}

// Touch keys -------------------------------------------------------------

// Ctrl and Alt on the strip apply to the next key typed.
const held = { ctrl: null, alt: null };  // their buttons, while on

// modified applies the held Ctrl and Alt to data, a key typed, and lets
// them go.
function modified(data) {
    if (held.ctrl && data.length === 1) {
        const c = data.toUpperCase().charCodeAt(0);
        if (c >= 0x40 && c <= 0x5f) {
            data = String.fromCharCode(c & 0x1f);  // Ctrl+A is 1, Ctrl+[ is Esc...
        } else if (data === " ") {
            data = "\x00";
        } else if (data === "?") {
            data = "\x7f";
        }
    }
    if (held.alt) {
        data = "\x1b" + data;
    }
    for (const k of ["ctrl", "alt"]) {
        held[k]?.setAttribute("aria-pressed", "false");
        held[k] = null;
    }
    return data;
}

// touchKeys adds the strip of keys below the terminal.
function touchKeys() {
    // The arrows as the program asks for them: application cursor keys
    // (DECCKM) or not.
    const arrow = (c) => () => (term.getMode(1) ? "\x1bO" : "\x1b[") + c;
    const keys = [
        ["Esc", "\x1b"], ["Tab", "\t"], ["Ctrl", "ctrl"], ["Alt", "alt"],
        [glyphs.left, arrow("D")], [glyphs.up, arrow("A")], [glyphs.down, arrow("B")], [glyphs.right, arrow("C")],
        ["|", "|"], ["~", "~"], ["/", "/"], ["-", "-"],
        [glyphs.fontSmaller, () => setFontSize(fontSize - 1)], [glyphs.fontLarger, () => setFontSize(fontSize + 1)],
        ["Find", () => search.open()],
    ];
    const strip = document.createElement("div");
    strip.id = "touch_keys";
    for (const [label, key] of keys) {
        const b = Object.assign(document.createElement("button"), { type: "button", textContent: label });
        if (key === "ctrl" || key === "alt") {
            b.setAttribute("aria-pressed", "false");
        }
        if (label === "Find") {
            b.className = "find";  // hidden without tmux (see search.offer)
        }
        // Not taking the focus from the terminal, which would close the
        // on-screen keyboard.
        b.addEventListener("pointerdown", (e) => e.preventDefault());
        b.addEventListener("click", () => {
            term.focus();
            if (key === "ctrl" || key === "alt") {
                const on = held[key] !== b;
                held[key] = on ? b : null;
                b.setAttribute("aria-pressed", String(on));
                return;
            }
            const data = typeof key === "function" ? key() : key;
            if (typeof data === "string") {
                send(encoder.encode(modified(data)));
            }
        });
        strip.append(b);
    }
    document.body.append(strip);
    document.body.classList.add("touch-keys");
    fit.fit();
}
if (matchMedia("(pointer: coarse)").matches) {
    touchKeys();
}

term.onData((data) => {
    if (ws) {
        send(encoder.encode(modified(data)));
    } else if (data.includes("\r") && !connecting && !document.getElementById("tabtop_reconnect")) {
        // Reloading also shows the login form if the session has ended.
        location.reload();
    }
});
term.onResize(sendSize);
term.onTitleChange((title) => notices.title(title || "Terminal"));

// Search -----------------------------------------------------------------

// The history is tmux's, not the page's (tmux draws on the alternate
// screen), so the server searches it with tmux's copy mode (see tty.go),
// which marks the match on the screen and shows how many there are (at
// the terminal's top right). The Search button in the bar at the top
// opens out in place into the box that takes the text: Enter (or ↑) finds
// it, then older matches, Shift+Enter (or ↓) newer ones, and Esc (or ✕)
// folds it back into the button and leaves copy mode. Without tmux, when
// the server runs its own command instead, there's nothing to search, so
// it isn't offered (see offer).
const search = (() => {
    const button = (text, label, onClick) => {
        const b = Object.assign(document.createElement("button"), { type: "button", textContent: text, title: label });
        b.setAttribute("aria-label", label);
        b.addEventListener("click", onClick);
        return b;
    };
    const input = Object.assign(document.createElement("input"), { type: "search", placeholder: "Search the history",
        autocomplete: "off", spellcheck: false });
    input.setAttribute("aria-label", "Search the terminal's history");
    let found = null;  // the text last searched for, while in copy mode
    const ask = (what) => send(JSON.stringify({ type: "search", do: what, text: input.value }));
    const go = (older) => {
        const text = input.value;
        if (!text) {
            return;
        }
        if (text !== found) {
            found = text;
            ask("find");
        } else {
            ask(older ? "older" : "newer");
        }
        input.focus();
    };
    const close = () => {
        bar.classList.remove("open");
        if (found !== null) {
            found = null;
            ask("stop");
        }
        term.focus();
    };
    const bar = document.createElement("span");
    bar.id = "tty_search";
    const step = (text, label, onClick) => Object.assign(button(text, label, onClick), { className: "step" });
    bar.append(input, step(glyphs.up, "Older (Enter)", () => go(true)), step(glyphs.down, "Newer (Shift+Enter)", () => go(false)),
        step(glyphs.close, "Close (Esc)", close));
    input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
            e.preventDefault();
            go(!e.shiftKey);
        } else if (e.key === "Escape") {
            e.preventDefault();
            close();
        }
    });
    const open = () => {
        bar.classList.add("open");
        input.focus();
        input.select();
    };
    const find = button("", "Search the history (Ctrl+Shift+F)", open);
    find.className = "search";
    find.innerHTML = iconSVG("search");
    bar.prepend(find);
    document.querySelector(".tabtop-nav > button")?.before(bar);
    // Before ghostty-web sees it, as the font size keys.
    document.addEventListener("keydown", (e) => {
        if (api.on && (e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && e.code === "KeyF") {
            e.preventDefault();
            e.stopPropagation();
            open();
        }
    }, true);
    const api = {
        on: true,
        open,
        // offer shows Search, its touch key and its keys, or hides them.
        offer(on) {
            api.on = on;
            bar.hidden = !on;
            const key = document.querySelector("#touch_keys .find");
            if (key) {
                key.hidden = !on;
            }
            if (!on) {
                bar.classList.remove("open");
                found = null;
            }
        },
    };
    return api;
})();

// Notices ----------------------------------------------------------------

// A bell, or a program's notification (see Osc), while the tab isn't in
// front marks its title with 🔔 until it is. With notifications turned on
// (the bell in the bar, kept in this browser), it's also shown as one,
// bells at most one every few seconds. They need HTTPS or localhost, and
// the browser's permission, asked for when they're turned on; without
// those, the button isn't shown, and only the title says so.
const notices = (() => {
    const KEY = "tabtop-tty-notify";
    const supported = window.isSecureContext && "Notification" in window;
    let base = "Terminal";
    let marked = false;
    let lastBell = 0;
    let on = false;
    try {
        on = supported && localStorage.getItem(KEY) === "1";
    } catch {
        // Off, then.
    }
    const away = () => document.visibilityState !== "visible" || !document.hasFocus();
    const draw = () => {
        document.title = marked ? `${glyphs.notification} ${base}` : base;
    };
    const back = () => {
        if (marked && !away()) {
            marked = false;
            draw();
        }
    };
    document.addEventListener("visibilitychange", back);
    addEventListener("focus", back);
    const show = (title, text) => {
        if (!away()) {
            return;
        }
        marked = true;
        draw();
        if (!on || Notification.permission !== "granted") {
            return;
        }
        try {
            const n = new Notification(title || base, { body: text, tag: "tabtop-terminal" });
            n.addEventListener("click", () => {
                window.focus();
                term.focus();
                n.close();
            });
        } catch {
            // The browser wouldn't (some only allow them from a service worker).
        }
    };

    const button = Object.assign(document.createElement("button"), { type: "button", className: "notify" });
    const look = () => {
        const denied = supported && Notification.permission === "denied";
        button.innerHTML = iconSVG(on && !denied ? "bell" : "bell-off");
        button.setAttribute("aria-pressed", String(on && !denied));
        button.title = denied ? "Notifications are blocked for this site in the browser's settings"
            : on ? "Notifications for bells and the notify command: on" : "Notifications for bells and the notify command: off";
        button.setAttribute("aria-label", button.title);
    };
    button.addEventListener("click", async () => {
        if (!on && Notification.permission === "default") {
            await Notification.requestPermission().catch(() => {});
        }
        on = !on && Notification.permission === "granted";
        try {
            localStorage.setItem(KEY, on ? "1" : "0");
        } catch {
            // Just for this visit, then.
        }
        look();
    });
    if (supported) {
        look();
        document.querySelector(".tabtop-nav > button")?.before(button);
    }
    return {
        bell: () => {
            const now = Date.now();
            if (now - lastBell > 5000) {
                lastBell = now;
                show("", "The terminal rang its bell.");
            }
        },
        notify: (title, text) => show(title, text.slice(0, 500)),
        title: (t) => {
            base = t;
            draw();
        },
    };
})();

// Fonts ------------------------------------------------------------------

// The font menu, "Aa" in the bar at the top: TabTop's own font, or one of
// the usual monospace fonts this computer has (or any other, by name), and
// the size, as Ctrl + and Ctrl − change it.
(() => {
    const CANDIDATES = ["DejaVu Sans Mono", "Menlo", "Monaco", "SF Mono", "Consolas", "Cascadia Mono", "Cascadia Code",
        "JetBrains Mono", "Fira Code", "Fira Mono", "Source Code Pro", "Hack", "IBM Plex Mono", "Ubuntu Mono",
        "Roboto Mono", "Noto Sans Mono", "Liberation Mono", "Inconsolata", "Courier New"];
    const OTHER = "\u0000other";

    // installed tells whether this computer has a font, the only way a page
    // can: text in it measures differently from text in the fallbacks.
    const canvas = document.createElement("canvas").getContext("2d");
    const width = (font) => {
        canvas.font = font;
        return canvas.measureText("mmmmmmmmmmlli1WQ@#").width;
    };
    const installed = (name) => ["monospace", "serif", "sans-serif"].some((f) => width(`72px "${name}", ${f}`) !== width(`72px ${f}`));

    const el = (tag, props = {}, ...children) => {
        const e = Object.assign(document.createElement(tag), props);
        e.append(...children);
        return e;
    };
    const button = el("button", { type: "button", className: "font", textContent: glyphs.font, title: "Font and size" });
    button.setAttribute("aria-haspopup", "true");
    button.setAttribute("aria-expanded", "false");
    const select = el("select", { id: "tty_font_family" });
    const other = el("input", { type: "text", placeholder: "A font on this computer", maxLength: 64, hidden: true });
    other.setAttribute("aria-label", "Font name");
    const size = el("output", { id: "tty_font_size" });
    const sizeButton = (text, label, onClick) => {
        const b = el("button", { type: "button", textContent: text, title: label });
        b.setAttribute("aria-label", label);
        b.addEventListener("click", onClick);
        return b;
    };
    const missing = el("p", { className: "note", hidden: true });
    const menu = el("div", { id: "tty_font_menu", hidden: true },
        el("label", { htmlFor: "tty_font_family", textContent: "Font" }), select, other, missing,
        el("div", { className: "size" },
            el("span", { textContent: "Size" }),
            sizeButton(glyphs.minus, "Smaller (Ctrl −)", () => setFontSize(fontSize - 1)), size,
            sizeButton(glyphs.plus, "Bigger (Ctrl +)", () => setFontSize(fontSize + 1)),
            sizeButton("Reset", "Back to the usual size (Ctrl 0)", () => setFontSize(defaultFontSize))),
        el("p", { className: "note", textContent: "Icons and symbols come from JetBrains Mono Nerd Font whatever the font." }));
    menu.setAttribute("role", "dialog");
    menu.setAttribute("aria-label", "Font and size");

    // The fonts to offer, looked for once the menu first opens.
    let filled = false;
    const fill = () => {
        const found = CANDIDATES.filter(installed);
        if (fontName && !found.includes(fontName)) {
            found.unshift(fontName);
        }
        select.replaceChildren(
            el("option", { value: "", textContent: "JetBrains Mono Nerd Font (TabTop's)" }),
            ...found.map((f) => el("option", { value: f, textContent: f })),
            el("option", { value: OTHER, textContent: "Another font…" }));
        filled = true;
    };
    const show = () => {
        size.textContent = `${fontSize} px`;
        if (filled) {
            select.value = fontName;
        }
        missing.hidden = !fontName || installed(fontName);
        missing.textContent = `This computer doesn't seem to have ${fontName}, so TabTop's font is used instead.`;
    };
    fontChanged.push(show);

    select.addEventListener("change", () => {
        if (select.value === OTHER) {
            other.hidden = false;
            other.value = "";
            other.focus();
            return;
        }
        other.hidden = true;
        setFont(select.value);
    });
    other.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && cleanFontName(other.value)) {
            e.preventDefault();
            const name = cleanFontName(other.value);
            if (![...select.options].some((o) => o.value === name)) {
                select.lastElementChild.before(el("option", { value: name, textContent: name }));
            }
            other.hidden = true;
            setFont(name);
        }
    });

    const close = (refocus = true) => {
        menu.hidden = true;
        other.hidden = true;
        button.setAttribute("aria-expanded", "false");
        if (refocus) {
            term.focus();
        }
    };
    button.addEventListener("click", () => {
        if (!menu.hidden) {
            close();
            return;
        }
        if (!filled) {
            fill();
        }
        show();
        menu.hidden = false;
        button.setAttribute("aria-expanded", "true");
        select.focus();
    });
    menu.addEventListener("keydown", (e) => {
        if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            close();
        }
    });
    document.addEventListener("pointerdown", (e) => {
        if (!menu.hidden && !menu.contains(e.target) && !button.contains(e.target)) {
            close(false);
        }
    });

    document.querySelector(".tabtop-nav > button")?.before(button);
    document.body.append(menu);
})();

// Dropped files ----------------------------------------------------------

// The transfers panel and the overlay shown while files are dragged over
// the page are styled as on the desktop.
document.head.append(Object.assign(document.createElement("link"), { rel: "stylesheet", href: new URL("../tabtop/desktop.css", import.meta.url).href }));
setLoginTitle("Terminal");
// Once uploaded, their paths are pasted at the cursor, as text pasted is,
// so a shell doesn't run the line.
dropUploads(uploadFile, makeFolder, (names, dir) => {
    if (ws) {
        term.paste(names.map((n) => shellPath(dir ? `${dir}/${n}` : n)).join(" ") + " ");
        term.focus();
    }
}, () => "", "(~/Downloads), then type their paths here", folderInfo);

if (!(await connect())) {
    reconnect("Can't reach the server.", connect);
}
