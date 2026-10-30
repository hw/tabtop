// Browser terminal, served by tabtopd (see tty.go), drawn by ghostty-web.
// Terminal bytes travel as binary WebSocket messages; resizes go up as JSON
// text messages. With WEB_E2E=1, the same messages go through the encrypted
// tunnel instead, which shows its login form when there's no session.

import { init, Terminal, FitAddon } from "./ghostty-web.js";
import * as e2e from "../tabtop/e2e.js";

// The most a program may copy at once, in base64 bytes.
const maxCopy = 1 << 20;

// Osc52 lets programs in the terminal (tmux's copy mode, ssh-yank.sh) copy
// to the browser's clipboard with OSC 52, which ghostty-web doesn't
// implement: it watches the output for ESC ] 52 ; <selection> ; <base64>,
// ended by BEL or ESC \, across message boundaries. Requests to read the
// clipboard ("?") get nothing back, so programs can't see what the viewer
// copied elsewhere.
class Osc52 {
    constructor() {
        this.state = 0;  // 0 text, 1 after ESC, 2 in an OSC, 3 ESC in an OSC
        this.buf = [];
    }

    scan(bytes) {
        for (const b of bytes) {
            switch (this.state) {
            case 0:
                if (b === 0x1b) {
                    this.state = 1;
                }
                break;
            case 1:
                this.state = b === 0x5d ? 2 : b === 0x1b ? 1 : 0;  // "]"
                this.buf = [];
                break;
            case 2:
                if (b === 0x07) {
                    this.end();
                } else if (b === 0x1b) {
                    this.state = 3;
                } else if (this.buf.length > maxCopy + 16) {
                    this.state = 0;  // too long: drop it
                } else {
                    this.buf.push(b);
                }
                break;
            case 3:
                if (b === 0x5c) {  // backslash
                    this.end();
                } else {
                    this.state = b === 0x5d ? 2 : b === 0x1b ? 1 : 0;
                    this.buf = [];
                }
                break;
            }
        }
    }

    end() {
        this.state = 0;
        // 52;<selection>;<data>, in ASCII.
        if (this.buf[0] !== 0x35 || this.buf[1] !== 0x32 || this.buf[2] !== 0x3b) {
            return;
        }
        const s = new TextDecoder("latin1").decode(Uint8Array.from(this.buf));
        const data = s.slice(s.indexOf(";", 3) + 1);
        if (data === "?" || data.length > maxCopy) {
            return;
        }
        try {
            const text = new TextDecoder().decode(Uint8Array.from(atob(data), (c) => c.charCodeAt(0)));
            navigator.clipboard?.writeText(text).catch(() => {});
        } catch {
            // Not base64: ignore it.
        }
    }
}

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

    active(e) {
        return !e.shiftKey && this.term.hasMouseTracking();
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

const fontSize = 14;
// Powerline Symbols only has the status-line arrows, so the browser draws
// those with it and everything else with DejaVu or the default monospace.
// Load it before the terminal measures its font and draws, so the arrows
// don't start out as boxes.
await document.fonts.load(`${fontSize}px "Powerline Symbols"`).catch(() => {});
await init();

const term = new Terminal({
    cursorBlink: true,
    // Black like the page around it (ghostty-web's default is dark grey).
    theme: { background: "#000000" },
    fontFamily: '"DejaVu Sans Mono", "Powerline Symbols", monospace',
    fontSize,
});
const fit = new FitAddon();
term.loadAddon(fit);
term.open(document.getElementById("terminal"));
fit.fit();
fit.observeResize();
term.focus();
const osc52 = new Osc52();
new MouseReporter(term, (bytes) => send(bytes));

const encoder = new TextEncoder();
let ws = null;

function send(data) {
    if (ws?.readyState === WebSocket.OPEN) {
        ws.send(data);
    }
}

function sendSize() {
    send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
}

function connect() {
    if (e2e.enabled) {
        ws = new e2e.TunnelSocket({ type: "tty" }, { title: "Terminal" });
    } else {
        const url = new URL("ws", location.href);
        url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
        ws = new WebSocket(url);
    }
    ws.binaryType = "arraybuffer";
    ws.onopen = sendSize;
    ws.onmessage = (e) => {
        const bytes = new Uint8Array(e.data);
        osc52.scan(bytes);
        term.write(bytes);
    };
    ws.onclose = (e) => {
        ws = null;
        if (e.reason === "logged out" || e.login) {
            if (e2e.enabled) {
                e2e.forgetSession();
            }
            location.reload();  // shows the login form
            return;
        }
        term.write(`\r\n\x1b[2m[${e.reason || "Disconnected"}. Press Enter to reconnect.]\x1b[0m\r\n`);
    };
}

term.onData((data) => {
    if (ws) {
        send(encoder.encode(data));
    } else if (data.includes("\r")) {
        // Reloading also shows the login form if the session has ended.
        location.reload();
    }
});
term.onResize(sendSize);
term.onTitleChange((title) => {
    document.title = title || "Terminal";
});

connect();
