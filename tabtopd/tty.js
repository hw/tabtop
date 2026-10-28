// Browser terminal, served by tabtopd (see tty.go). Terminal
// bytes travel as binary WebSocket messages; resizes go up as JSON text
// messages.

import { Terminal } from "./xterm.mjs";
import { FitAddon } from "./addon-fit.mjs";
import { ClipboardAddon, BrowserClipboardProvider } from "./addon-clipboard.mjs";

// OSC 52 lets programs in the terminal (tmux's copy mode, ssh-yank.sh) copy
// to the browser's clipboard. Requests to read it get nothing back, so they
// can't see what the viewer copied elsewhere.
class WriteOnlyClipboard extends BrowserClipboardProvider {
    readText() {
        return "";
    }

    // tmux leaves the selection empty, meaning the default one, which the
    // add-on would otherwise ignore.
    writeText(selection, text) {
        return super.writeText(selection || "c", text);
    }
}

const fontSize = 14;
// Powerline Symbols only has the status-line arrows, so the browser draws
// those with it and everything else with DejaVu or the default monospace. Load it before the
// terminal draws, so the arrows don't start out as boxes.
await document.fonts.load(`${fontSize}px "Powerline Symbols"`).catch(() => {});

const term = new Terminal({
    cursorBlink: true,
    fontFamily: '"DejaVu Sans Mono", "Powerline Symbols", monospace',
    fontSize,
});
const fit = new FitAddon();
term.loadAddon(fit);
term.loadAddon(new ClipboardAddon(undefined, new WriteOnlyClipboard()));
term.open(document.getElementById("terminal"));
fit.fit();
term.focus();

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
    const url = new URL("ws", location.href);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    ws.onopen = sendSize;
    ws.onmessage = (e) => term.write(new Uint8Array(e.data));
    ws.onclose = (e) => {
        ws = null;
        if (e.reason === "logged out") {
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
// Some mouse reports are raw bytes, not text.
term.onBinary((data) => send(Uint8Array.from(data, (c) => c.charCodeAt(0))));
term.onResize(sendSize);
term.onTitleChange((title) => {
    document.title = title || "Terminal";
});

let resizePending = false;
window.addEventListener("resize", () => {
    if (!resizePending) {
        resizePending = true;
        requestAnimationFrame(() => {
            resizePending = false;
            fit.fit();
        });
    }
});

connect();
