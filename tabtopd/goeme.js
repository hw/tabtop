// Page-world EME objects. The viewer owns the native objects and returns
// the CDM's opaque messages to the site's own license client.
(() => {
    if (window !== top || location.protocol !== "https:") return;
    const pending = new Map(), sessions = new Map(), attached = new WeakMap();
    const queue = [];
    let next = 0;
    const unsupported = (message) => new DOMException(message, "NotSupportedError");
    function encode(input) {
        const bytes = ArrayBuffer.isView(input) ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength) : new Uint8Array(input);
        if (bytes.length > 32768) throw new RangeError("EME message too large");
        return btoa(String.fromCharCode(...bytes));
    }
    const decode = (data) => Uint8Array.from(atob(data), c => c.charCodeAt(0)).buffer;
    function call(op, fields, element) {
        return new Promise((resolve, reject) => {
            const request = ++next;
            const command = { request, op, ...fields };
            // Format probes (decodingInfo, with or without a key system: only
            // the viewer can say what plays, the engine having no media) are
            // asked many at once by players (Promise.all over their variants):
            // queued, not refused, up to 256; the rest 32.
            // (Each kind counted on its own: probes in flight don't use up
            // the room for the player's other calls.)
            const probe = op === "decoding", most = probe ? 256 : 32;
            const outstanding = [...pending.values()].filter((p) => p.probe === probe).length;
            const queued = queue.filter((q) => (q.command.op === "decoding") === probe).length;
            if (outstanding >= most || queued >= most || JSON.stringify(command).length > 49152) throw new RangeError("EME request limit");
            const timer = setTimeout(() => {
                pending.delete(request);
                reject(new DOMException("The viewer did not answer", "TimeoutError"));
            }, 30000);
            pending.set(request, { resolve, reject, timer, probe });
            queue.push({ command, element });
        });
    }
    document.addEventListener("__tabtop_read_eme", () => {
        for (const { command, element } of queue.splice(0, 4)) {
            if (!pending.has(command.request)) continue;
            if (element) {
                // relatedTarget identifies even a detached video across the two JS worlds.
                document.dispatchEvent(new MouseEvent("__tabtop_eme_element", { relatedTarget: element }));
            }
            document.dispatchEvent(new CustomEvent("__tabtop_eme_command", { detail: JSON.stringify(command) }));
        }
    });
    // MediaKeyStatusMap compares the bytes of a key ID, including typed
    // array views. JavaScript Map compares the identity of the buffer.
    class MediaKeyStatusMap {
        #statuses = new Map();
        get size() { return this.#statuses.size; }
        has(id) { return this.#statuses.has(encode(id)); }
        get(id) { return this.#statuses.get(encode(id)); }
        *entries() { for (const [id, value] of this.#statuses) yield [decode(id), value]; }
        *keys() { for (const [id] of this.entries()) yield id; }
        values() { return this.#statuses.values(); }
        [Symbol.iterator]() { return this.entries(); }
        forEach(callback, self) { for (const [id, value] of this) callback.call(self, value, id, this); }
        replace(entries) { this.#statuses = new Map(entries); }
    }
    class MediaEncryptedEvent extends Event {
        constructor(type, init = {}) {
            super(type, init);
            this.initDataType = init.initDataType ?? "";
            this.initData = init.initData ?? null;
        }
    }
    class MediaKeyMessageEvent extends Event {
        constructor(type, init) {
            super(type, init);
            this.messageType = init.messageType;
            this.message = init.message;
        }
    }
    globalThis.MediaEncryptedEvent ??= MediaEncryptedEvent;
    globalThis.MediaKeyMessageEvent ??= MediaKeyMessageEvent;
    if (!("onencrypted" in HTMLMediaElement.prototype)) {
        const handlers = new WeakMap();
        Object.defineProperty(HTMLMediaElement.prototype, "onencrypted", {
            configurable: true,
            get() { return handlers.get(this) ?? null; },
            set(fn) {
                if (handlers.has(this)) this.removeEventListener("encrypted", handlers.get(this));
                handlers.delete(this);
                if (typeof fn === "function") {
                    handlers.set(this, fn);
                    this.addEventListener("encrypted", fn);
                }
            },
        });
    }
    document.addEventListener("__tabtop_eme_reply", (event) => {
        const r = JSON.parse(event.detail);
        if (r.request) {
            const p = pending.get(r.request);
            if (!p) return;
            clearTimeout(p.timer);
            pending.delete(r.request);
            if (r.error) p.reject(new DOMException(r.error, r.name));
            else p.resolve(r.value);
        } else if (r.event === "encrypted" && event.target instanceof HTMLMediaElement) {
            event.target.dispatchEvent(new globalThis.MediaEncryptedEvent("encrypted", { initDataType: r.type, initData: decode(r.data) }));
        } else {
            const s = sessions.get(r.session);
            if (!s) return;
            s.sessionId = r.sessionId;
            s.expiration = r.expiration ?? NaN;
            if (r.event === "closed") {
                sessions.delete(r.session);
                s.finish(r.reason);
                return;
            }
            const e = r.event === "message"
                ? new globalThis.MediaKeyMessageEvent("message", { messageType: r.type, message: decode(r.data) })
                : new Event(r.event);
            if (r.event === "keystatuseschange") {
                s.keyStatuses.replace(r.statuses);
            }
            s.dispatchEvent(e);
            if (typeof s["on" + e.type] === "function") s["on" + e.type](e);
        }
    }, true);
    class MediaKeySession extends EventTarget {
        sessionId = "";
        expiration = NaN;
        keyStatuses = new MediaKeyStatusMap();
        closed = new Promise(resolve => { this.finish = resolve; });
        constructor(keys) {
            super();
            this.handle = ++next;
            sessions.set(this.handle, this);
            this.ready = call("session", { keys, session: this.handle }).catch(error => {
                sessions.delete(this.handle);
                throw error;
            });
            this.ready.catch(() => {});
        }
        async generateRequest(type, bytes) {
            await this.ready;
            this.sessionId = await call("generate", { session: this.handle, type, data: encode(bytes) });
        }
        async update(bytes) { await this.ready; await call("update", { session: this.handle, data: encode(bytes) }); }
        async close() { await this.ready; await call("close", { session: this.handle }); }
        async remove() { await this.ready; await call("remove", { session: this.handle }); }
        async load() { throw unsupported("Only temporary sessions are available"); }
    }
    class MediaKeys {
        constructor(handle) { this.handle = handle; }
        createSession(type = "temporary") {
            if (type !== "temporary") throw unsupported("Only temporary sessions are available");
            return new MediaKeySession(this.handle);
        }
        async setServerCertificate(bytes) { return call("certificate", { keys: this.handle, data: encode(bytes) }); }
        async getStatusForPolicy(policy) { return call("policy", { keys: this.handle, policy }); }
    }
    class MediaKeySystemAccess {
        constructor(system, handle, config) { this.keySystem = system; this.handle = handle; this.config = config; }
        getConfiguration() { return JSON.parse(JSON.stringify(this.config)); }
        async createMediaKeys() { return new MediaKeys(await call("keys", { access: this.handle })); }
    }
    Object.assign(globalThis, { MediaKeySystemAccess, MediaKeys, MediaKeySession, MediaKeyStatusMap });
    Object.defineProperty(navigator, "requestMediaKeySystemAccess", { configurable: true, writable: true, value: async (system, configs) => {
        const { handle, config } = await call("access", { system, configs });
        return new MediaKeySystemAccess(system, handle, config);
    } });
    const capabilities = navigator.mediaCapabilities ?? {};
    if (!navigator.mediaCapabilities) Object.defineProperty(navigator, "mediaCapabilities", { configurable: true, value: capabilities });
    Object.defineProperty(capabilities, "decodingInfo", { configurable: true, writable: true, value: async configuration => {
        const { access, ...result } = await call("decoding", { config: configuration });
        return { ...result, configuration, keySystemAccess: access && new MediaKeySystemAccess(access.system, access.handle, access.config) };
    } });
    Object.defineProperties(HTMLMediaElement.prototype, {
        mediaKeys: { configurable: true, get() { return attached.get(this) ?? null; } },
        setMediaKeys: { configurable: true, async value(keys) {
            if (keys !== null && !(keys instanceof MediaKeys)) throw new TypeError("Invalid MediaKeys");
            await call("attach", { keys: keys?.handle ?? null, kind: this.localName }, this);
            attached.set(this, keys);
        } },
    });
})();
