// Public browser API: protocol exports plus the WebSocket-compatible UI adapter.
import { Tunnel } from "./tunnel-protocol.js";
import { session, storedSession, forgetSession } from "./session.js";
export { Tunnel, TunnelError, login, tunnelURL, request } from "./tunnel-protocol.js";
export { elligator2, cpaceGenerator, cryptoBackend } from "./tunnel-crypto.js";
export { SESSION_KEY, storedSession, forgetSession, session, renewSession } from "./session.js";

// TunnelSocket looks enough like a WebSocket for noVNC (as its "channel"),
// the terminal and the audio player: it's open once the server has
// accepted the request, and delivers text as strings and data as
// ArrayBuffers. With a title, it shows the login form when there's no
// session, and logs in again when the session is over. Its close event
// has login if the session is over, and lost if the connection failed or
// was lost without the server saying why, as when the network goes. Its
// session is the one it used, and its reply the server's acceptance.
export class TunnelSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSED = 3;

    constructor(req, { title } = {}) {
        this.readyState = TunnelSocket.CONNECTING;
        this.binaryType = "arraybuffer";
        this.protocol = "";
        this.onopen = this.onmessage = this.onerror = this.onclose = null;
        this._start(req, title);
    }

    async _start(req, title) {
        for (;;) {
            if (this.readyState === TunnelSocket.CLOSED) { return; }
            try {
                this.session = title ? await session(title) : storedSession();
                if (this.readyState === TunnelSocket.CLOSED) { return; }
                this._t = await Tunnel.open(req, this.session);
                break;
            } catch (e) {
                if (this.readyState === TunnelSocket.CLOSED) { return; }
                if (e.login && title) {
                    forgetSession(this.session);
                    continue;
                }
                this._finish(e.message, e.login, e.lost);
                return;
            }
        }
        if (this.readyState === TunnelSocket.CLOSED) {
            this._t.close();  // closed while connecting
            return;
        }
        this.readyState = TunnelSocket.OPEN;
        this.reply = this._t.reply;
        this._opened = true;
        this.onopen?.(new Event("open"));
        for (let m; (m = await this._t.next());) {
            if (this.readyState === TunnelSocket.CLOSED) { return; }
            this.onmessage?.({ data: m.text ?? m.data });
        }
        if (this.readyState === TunnelSocket.CLOSED) { return; }
        this._finish(this._t.closeReason, this._t.closeLogin, !this._t.closeReason && !this._t.closeLogin);
    }

    _finish(reason, login = false, lost = false) {
        if (this._done) {
            return;
        }
        this._done = true;
        this.readyState = TunnelSocket.CLOSED;
        if (!this._opened && !this._closedByCaller) {
            // A WebSocket that fails to connect reports an error first.
            this.onerror?.(new Event("error"));
        }
        this.onclose?.({ code: 1000, reason, login, lost, wasClean: true });
    }

    send(data) {
        if (this.readyState !== TunnelSocket.OPEN) {
            return;
        }
        if (typeof data === "string") {
            this._t.sendText(data);
        } else {
            this._t.sendData(data);
        }
    }

    close() {
        if (this.readyState === TunnelSocket.CLOSED) { return; }
        this._closedByCaller = true;
        this.readyState = TunnelSocket.CLOSED;
        this._t?.close();
        // Like WebSocket, notify asynchronously, including when opening has
        // not finished. A late open is still closed by _start above.
        queueMicrotask(() => this._finish(""));
    }
}
