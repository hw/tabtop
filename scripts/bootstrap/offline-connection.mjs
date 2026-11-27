// The offline launcher embeds this class in the sealed page. Keep its
// dependencies in the constructor or on the class so it can run from disk.
export class OfflineConnection {
    static UPGRADE_WAIT = 4000;
    static #BATCH_RESPONSE_LIMIT = 384 * 1024; // 256 KiB of payload plus base64 and JSON
    static #LEGACY_RESPONSE_LIMIT = 24 * 1024 * 1024;
    static #LEGACY_FRAME_LIMIT = 16 * 1024 * 1024 + 17;
    static #FRAGMENT_LIMIT = 64 * 1024;
    static #MESSAGE_LIMIT = 64 * 1024 * 1024;
    static #FRAGMENT_COUNT = 1024;
    static #BATCH_COUNT = 256;

    readyState = 0;
    binaryType = "arraybuffer";
    onopen = null;
    onmessage = null;
    onclose = null;
    onerror = null;

    #socket;
    #controller = new AbortController();
    #websocketURL;
    #bridgeURL;
    #fetch;
    #onUpgradeLost;
    #tunnel;
    #token;
    #active;
    #standby;
    #retired;
    #after = 0;
    #fragments = [];
    #fragmentBytes = 0;
    #fragmentedReplies = false;
    #sent = 0;
    #pending = [];
    #pendingBytes = 0;
    #flushing = false;
    #ordered = Promise.resolve();
    #readController;
    #timer;
    #rotateInterval;
    #closing = false;

    constructor(url, { fetch, preferPolling, onUpgradeLost = () => {} }) {
        this.#websocketURL = url;
        this.#bridgeURL = new URL(url);
        this.#bridgeURL.protocol = this.#bridgeURL.protocol === "wss:" ? "https:" : "http:";
        this.#bridgeURL.pathname += "/poll";
        this.#fetch = fetch;
        this.#onUpgradeLost = onUpgradeLost;
        this.#connect(preferPolling).catch(() => {
            if (!this.#closing) {
                this.onerror?.(new Event("error"));
                this.#finish(1006);
            }
        });
    }

    async #connect(preferPolling) {
        if (!preferPolling) {
            try {
                await this.#upgrade();
                return;
            } catch {
                this.#controller.signal.throwIfAborted();
            }
        }
        const opened = await this.#request("?fragments=1", {
            method: "POST",
            json: { requestId: crypto.randomUUID() },
            timeout: 4500,
        });
        if (!opened?.token || !opened.tunnelId || !opened.connectionId || !Number.isSafeInteger(opened.rotateAfterMs) ||
            opened.rotateAfterMs <= 0 || opened.rotateAfterMs > 2147483647) {
            throw new Error("Invalid bridge response");
        }
        this.#token = opened.token;
        this.#tunnel = encodeURIComponent(opened.tunnelId);
        this.#active = opened.connectionId;
        this.#rotateInterval = opened.rotateAfterMs;
        this.#fragmentedReplies = opened.fragments === true;
        if (this.#closing) {
            this.#release(this.#active);
            return;
        }
        this.readyState = 1;
        this.onopen?.(new Event("open"));
        this.#startReading();
        this.#scheduleRotation();
    }

    #upgrade() {
        return new Promise((resolve, reject) => {
            const socket = new WebSocket(this.#websocketURL);
            this.#socket = socket;
            socket.binaryType = this.binaryType;
            const signal = this.#controller.signal;
            const abort = () => failed();
            const timer = setTimeout(() => failed(), this.constructor.UPGRADE_WAIT);
            const cleanup = () => {
                clearTimeout(timer);
                signal.removeEventListener("abort", abort);
            };
            const failed = () => {
                cleanup();
                socket.onopen = socket.onclose = socket.onerror = null;
                this.#socket = undefined;
                socket.close();
                reject(new Error("WebSocket upgrade failed"));
            };
            signal.addEventListener("abort", abort, { once: true });
            socket.onerror = socket.onclose = failed;
            socket.onopen = (event) => {
                cleanup();
                socket.onmessage = (message) => this.onmessage?.(message);
                socket.onerror = (error) => this.onerror?.(error);
                socket.onclose = (closed) => {
                    if (!this.#closing && closed.code === 1006) this.#onUpgradeLost();
                    this.#finish(closed.code, closed.reason, closed.wasClean);
                };
                this.readyState = 1;
                resolve();
                this.onopen?.(event);
            };
        });
    }

    #route(id, suffix = "") {
        return "/" + this.#tunnel + "/connections/" + encodeURIComponent(id) + suffix;
    }

    async #request(path, {
        method = "GET", json, body, signal = this.#controller.signal, timeout = 6000,
        busyTimeout = method === "GET" ? 40000 : 0, responseLimit = 4096,
    } = {}) {
        const headers = {};
        if (this.#token) headers.Authorization = "Bearer " + this.#token;
        if (json !== undefined) {
            headers["Content-Type"] = "application/json";
            body = JSON.stringify(json);
        }
        const url = this.#bridgeURL.href + path;
        let failures = 0, busyUntil = 0, busyError;
        for (;;) {
            signal.throwIfAborted();
            const remaining = busyUntil ? busyUntil - Date.now() : timeout;
            if (remaining <= 0) throw busyError;
            try {
                const response = await this.#fetch(url, {
                    method, headers, body, signal: AbortSignal.any([signal, AbortSignal.timeout(Math.min(timeout, remaining))]),
                });
                if (response.status === 204) return null;
                if (!response.ok) {
                    response.body?.cancel().catch(() => {});
                    const error = new Error("Bridge returned HTTP " + response.status);
                    error.status = response.status;
                    throw error;
                }
                return await this.#readJSON(response, responseLimit);
            } catch (error) {
                if (signal.aborted || error instanceof RangeError) throw error;
                if (busyTimeout && error.status === 429) {
                    // The original request may still be active upstream.
                    busyError = error;
                    busyUntil ||= Date.now() + busyTimeout;
                    const delay = Math.min(1000, busyUntil - Date.now());
                    if (delay <= 0) throw error;
                    await new Promise((resolve) => setTimeout(resolve, delay));
                    continue;
                }
                if (failures >= 2 || (error.status && ![408, 429, 502, 503, 504].includes(error.status))) throw error;
                failures++;
            }
            await new Promise((resolve) => setTimeout(resolve, 150 * failures));
        }
    }

    async #readJSON(response, limit) {
        const tooLarge = () => new RangeError("Polling response is too large");
        if (Number(response.headers.get("Content-Length")) > limit) {
            response.body?.cancel().catch(() => {});
            throw tooLarge();
        }
        if (!response.body) throw new Error("Missing polling response body");

        const reader = response.body.getReader();
        let data = new Uint8Array(0), size = 0;
        try {
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                const end = size + value.byteLength;
                if (end > limit) throw tooLarge();
                if (end > data.length) {
                    const next = new Uint8Array(Math.min(limit, Math.max(end, 1024, data.length * 2)));
                    next.set(data.subarray(0, size));
                    data = next;
                }
                data.set(value, size);
                size = end;
            }
        } catch (error) {
            reader.cancel().catch(() => {});
            throw error;
        } finally {
            reader.releaseLock();
        }
        return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data.subarray(0, size)));
    }

    #startReading() {
        this.#readController?.abort();
        const controller = new AbortController();
        this.#readController = controller;
        this.#read(this.#active, controller.signal).catch(() => {
            if (!controller.signal.aborted && !this.#closing) this.#finish(1006);
        });
    }

    async #read(id, signal) {
        const responseLimit = this.#fragmentedReplies ? OfflineConnection.#BATCH_RESPONSE_LIMIT : OfflineConnection.#LEGACY_RESPONSE_LIMIT;
        while (!signal.aborted && !this.#closing) {
            const batch = await this.#request(this.#route(id, "?after=" + this.#after), { signal, timeout: 28000, responseLimit });
            if (signal.aborted || this.#closing || batch?.switched) return;
            this.#confirmActive(id);
            if (batch?.close) {
                if (this.#fragments.length && batch.close.code === 1000) {
                    this.#finish(1006);
                    return;
                }
                this.#finish(batch.close.code, batch.close.reason, batch.close.code !== 1006);
                return;
            }
            if (!batch?.messages) continue;
            if (batch.first !== this.#after + 1) throw new Error("Unexpected receive sequence");
            if (!Array.isArray(batch.messages) || !batch.messages.length || batch.messages.length > OfflineConnection.#BATCH_COUNT ||
                (batch.more !== undefined && (!Array.isArray(batch.more) || batch.more.length !== batch.messages.length ||
                    batch.more.some((more) => typeof more !== "boolean")))) {
                throw new Error("Invalid polling message batch");
            }
            for (const [index, message] of batch.messages.entries()) {
                if (this.#closing) return;
                const more = batch.more?.[index] === true;
                const frameLimit = this.#fragmentedReplies || more || this.#fragments.length
                    ? OfflineConnection.#FRAGMENT_LIMIT : OfflineConnection.#LEGACY_FRAME_LIMIT;
                if (typeof message !== "string" || message.length > 4 * Math.ceil(frameLimit / 3)) {
                    throw new RangeError("Polling frame is too large");
                }
                const decoded = atob(message);
                if (decoded.length > frameLimit || (more && decoded.length === 0)) throw new RangeError("Invalid polling fragment size");
                const bytes = new Uint8Array(decoded.length);
                for (let i = 0; i < decoded.length; i++) bytes[i] = decoded.charCodeAt(i);
                this.#after++;
                this.#deliver(bytes, more);
            }
        }
    }

    #deliver(bytes, more) {
        const size = this.#fragmentBytes + bytes.length;
        const count = this.#fragments.length + 1;
        if (size > OfflineConnection.#MESSAGE_LIMIT || count > OfflineConnection.#FRAGMENT_COUNT ||
            (more && count === OfflineConnection.#FRAGMENT_COUNT)) {
            throw new RangeError("Reassembled polling message is too large");
        }
        if (more) {
            this.#fragments.push(bytes);
            this.#fragmentBytes = size;
            return;
        }
        if (this.#fragments.length) {
            const message = new Uint8Array(size);
            let offset = 0;
            for (const fragment of this.#fragments) {
                message.set(fragment, offset);
                offset += fragment.length;
            }
            message.set(bytes, offset);
            this.#fragments = [];
            this.#fragmentBytes = 0;
            bytes = message;
        }
        this.onmessage?.({ data: bytes.buffer });
    }

    send(data) {
        if (this.#socket) {
            this.#socket.send(data);
            return;
        }
        if (this.readyState === 0) throw new DOMException("The connection is opening", "InvalidStateError");
        if (this.readyState !== 1) return;
        const frame = ArrayBuffer.isView(data)
            ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice()
            : new Uint8Array(data.slice(0));
        this.#pending.push(frame);
        this.#pendingBytes += frame.length + 4;
        if (this.#pendingBytes > 32 * 1024 * 1024 || this.#pending.length > 4096) {
            this.#finish(1006);
            return;
        }
        this.#flush();
    }

    #enqueue(fn) {
        const next = this.#ordered.then(fn);
        this.#ordered = next.catch(() => {});
        return next;
    }

    #flush() {
        if (this.#flushing || !this.#pending.length || this.#closing) return;
        this.#flushing = true;
        this.#enqueue(async () => {
            if (this.#closing) return;
            let count = 1, size = this.#pending[0].length + 4;
            while (count < this.#pending.length && count < 64 && size + this.#pending[count].length + 4 <= 256 * 1024) {
                size += this.#pending[count++].length + 4;
            }
            const frames = this.#pending.splice(0, count);
            this.#pendingBytes -= size;
            const body = new Uint8Array(size);
            const view = new DataView(body.buffer);
            let offset = 0;
            for (const frame of frames) {
                view.setUint32(offset, frame.length);
                body.set(frame, offset + 4);
                offset += frame.length + 4;
            }
            const seq = this.#sent + 1;
            // Allow time for the HTTP body and then the bridge's upstream write.
            const timeout = 20000 + 1000 * Math.ceil(body.length / (256 * 1024));
            const sent = await this.#request(this.#route(this.#active, "/send?seq=" + seq), {
                method: "POST", body, timeout, busyTimeout: Math.max(40000, timeout + 5000),
            });
            if (sent?.accepted !== this.#sent + count) throw new Error("Unexpected send acknowledgement");
            this.#sent = sent.accepted;
        }).catch((error) => {
            if (error.status === 410) {
                // The receive loop delivers the upstream close code, including
                // errors that have special meaning to the login flow.
                this.#pending = [];
                this.#pendingBytes = 0;
                return;
            }
            if (!this.#closing) this.#finish(1006);
        }).finally(() => {
            this.#flushing = false;
            this.#flush();
        });
    }

    #scheduleRotation() {
        if (this.#closing) return;
        this.#timer = setTimeout(() => {
            this.#rotate().catch(() => {
                if (!this.#closing) this.#finish(1006);
            }).finally(() => this.#scheduleRotation());
        }, this.#rotateInterval);
    }

    #rotate() {
        return this.#enqueue(() => this.#switchConnection());
    }

    async #switchConnection() {
        if (this.#closing || this.#retired) return;
        const old = this.#active;
        let prepared;
        try {
            prepared = await this.#request("/" + this.#tunnel + "/connections", {
                method: "POST", json: { connectionId: old },
            });
        } catch {
            // The active connection can keep working if preparation fails.
            return;
        }
        const next = prepared?.connectionId;
        if (!next || next === old) throw new Error("Invalid standby connection");
        if (this.#closing) {
            this.#release(next);
            return;
        }
        this.#standby = next;
        const pending = new AbortController();
        const confirmActive = () => this.#request(this.#route(next, "?wait=active"), {
            signal: AbortSignal.any([pending.signal, this.#controller.signal]), timeout: 26000,
        }).catch(() => null);
        const confirm = confirmActive();
        try {
            let confirmed = false;
            try {
                const switched = await this.#request(this.#route(old, "/switch"), {
                    method: "POST", json: { connectionId: next },
                });
                if (switched?.connectionId !== next) throw new Error("Invalid switch response");
            } catch (error) {
                if (error.status === 409 || this.#closing) return;
                // A standby poll can return 204 before promotion. Check the
                // new route again if the switch response was lost.
                confirmed = (await confirm)?.active || (await confirmActive())?.active;
                if (!confirmed) throw error;
            }
            if (this.#closing) return;
            this.#retired = old;
            this.#active = next;
            this.#standby = undefined;
            this.#startReading();
            if (confirmed) this.#confirmActive(next);
            confirm.then((reply) => {
                if (reply?.active) this.#confirmActive(next);
            });
        } finally {
            if (this.#active !== next) {
                pending.abort();
                this.#standby = undefined;
                this.#release(next);
            }
        }
    }

    #confirmActive(id) {
        if (id !== this.#active || !this.#retired) return;
        this.#release(this.#retired);
        this.#retired = undefined;
    }

    #release(id) {
        if (!id) return;
        this.#fetch(this.#bridgeURL.href + this.#route(id), {
            method: "DELETE", headers: { Authorization: "Bearer " + this.#token },
            keepalive: true,
        }).catch(() => {});
    }

    close() {
        if (this.#closing) return;
        if (this.#socket && this.readyState === 1) {
            this.#closing = true;
            this.readyState = 2;
            this.#socket.close();
            return;
        }
        this.#finish(1000, "", true);
    }

    #finish(code, reason = "", wasClean = false) {
        if (this.readyState === 3) return;
        this.#closing = true;
        this.readyState = 3;
        this.#controller.abort();
        this.#readController?.abort();
        clearTimeout(this.#timer);
        this.#pending = [];
        this.#pendingBytes = 0;
        this.#fragments = [];
        this.#fragmentBytes = 0;
        this.#release(this.#active);
        this.#release(this.#standby);
        this.#release(this.#retired);
        queueMicrotask(() => this.onclose?.({ code, reason, wasClean }));
    }
}
