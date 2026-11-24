// Installed before site scripts. Requests wait for the isolated agent to poll,
// including requests made before the first snapshot of the document.
(capabilities => {
    if (window !== top) return;
    let pending, queued, currentVideo, pipWindow;
    function eventHandler(target, type) {
        if ("on" + type in target) return;
        const listeners = new WeakMap();
        Object.defineProperty(target, "on" + type, {
            configurable: true,
            get() { return listeners.get(this) ?? null; },
            set(handler) {
                if (listeners.has(this)) this.removeEventListener(type, listeners.get(this));
                listeners.delete(this);
                if (typeof handler === "function") {
                    listeners.set(this, handler);
                    this.addEventListener(type, handler);
                }
            },
        });
    }
    const error = (name) => new DOMException(name, name);
    const method = (obj, key, value) => Object.defineProperty(obj, key, { configurable: true, writable: true, value });
    const getter = (obj, key, get) => Object.defineProperty(obj, key, { configurable: true, get });

    function request(kind, fields, target = document) {
        if (pending) return Promise.reject(error("InvalidStateError"));
        return new Promise((resolve, reject) => {
            const id = Array.from(crypto.getRandomValues(new Uint32Array(3)), n => n.toString(36)).join("");
            const timer = setTimeout(() => {
                pending = queued = null;
                reject(error("TimeoutError"));
            }, 120000);
            pending = { id, resolve, reject, timer };
            queued = { target, detail: JSON.stringify({ id, kind, ...fields }) };
        });
    }
    document.addEventListener("__tabtop_read_device", () => {
        if (!queued) return;
        const { target, detail } = queued;
        queued = null;
        target.dispatchEvent(new CustomEvent("__tabtop_device", { detail, bubbles: true, composed: true }));
    });
    document.addEventListener("__tabtop_device_reply", e => {
        let r;
        try { r = JSON.parse(e.detail); } catch { return; }
        // A position followed (watchPosition), or its end.
        if (r.watch) return watched(r);
        if (r.resize && pipWindow) {
            Object.assign(pipWindow, { width: r.width, height: r.height });
            pipWindow.dispatchEvent(new Event("resize"));
        }
        if (r.left && currentVideo) {
            const previous = currentVideo, win = pipWindow;
            currentVideo = pipWindow = null;
            pipEvent(previous, "leavepictureinpicture", win);
        }
        if (!pending || pending.id !== r.id) return;
        const p = pending;
        pending = null;
        clearTimeout(p.timer);
        if (r.error) p.reject(error(r.error));
        else p.resolve(r);
    });

    // Text and links, and files (where the person's browser shares them:
    // 10, 100 MB in all, at most), each a File.
    function shareData(data) {
        if (!data) throw new TypeError("No share data");
        const out = {};
        for (const key of ["title", "text", "url"]) {
            if (data[key] !== undefined) out[key] = String(data[key]);
        }
        const files = data.files === undefined ? [] : Array.from(data.files);
        if (files.some(f => !(f instanceof File))) throw new TypeError("Only files can be shared as files");
        if (files.length && !capabilities.shareFiles) throw error("NotAllowedError");
        if (files.length > 10 || files.reduce((n, f) => n + f.size, 0) > 100 << 20) throw error("NotAllowedError");
        if (!Object.keys(out).length && !files.length) throw new TypeError("No share data");
        if (out.url !== undefined) {
            const url = new URL(out.url, document.baseURI);
            if (!["http:", "https:"].includes(url.protocol)) throw new TypeError("Unsupported share URL");
            out.url = url.href;
        }
        if (JSON.stringify(out).length > 8192) throw new TypeError("Share data is too large");
        return { out, files };
    }
    // A file's bytes to the person's browser, by the page's media relay
    // (gomedia.js, in this world): its stream's number.
    function shareFile(file) {
        const detail = { file, name: file.name };
        window.dispatchEvent(new CustomEvent("__tabtop_share_file", { detail }));
        if (!Number.isSafeInteger(detail.stream)) throw error("NotAllowedError");
        return { stream: detail.stream, name: file.name, type: file.type, size: file.size };
    }
    if (isSecureContext && capabilities.share) {
        method(navigator, "canShare", data => {
            try { shareData(data); return true; } catch { return false; }
        });
        method(navigator, "share", async data => {
            const { out, files } = shareData(data);
            if (pending) throw error("InvalidStateError");
            await request("share", files.length ? { data: out, files: files.map(shareFile) } : { data: out });
        });
    }

    // File System Access handles are proxies to handles retained by the
    // person's browser. Bytes cross the tunnel in small, sequential pieces.
    const fsChunk = 24 << 10;
    const randomFSID = () => Array.from(crypto.getRandomValues(new Uint32Array(3)), n => n.toString(36)).join("");
    let fsQueue = Promise.resolve();
    const fsFiles = new Map();
    // A file staged for getFile (gofs.go: deliverFSFile): in a hidden input
    // the agent made, named by its id; taken from it here.
    document.addEventListener("__tabtop_fs_file", event => {
        let value;
        try { value = JSON.parse(event.detail); } catch { return; }
        if (typeof value?.id !== "string" || typeof value.input !== "string" || !value.input.startsWith("__tabtop_fs_")) return;
        const input = document.getElementById(value.input);
        const file = input?.files?.[0];
        input?.remove();
        const waiter = fsFiles.get(value.id);
        if (waiter && file instanceof File) { fsFiles.delete(value.id); waiter.resolve(file); }
    });
    document.addEventListener("__tabtop_fs_error", event => {
        let value;
        try { value = JSON.parse(event.detail); } catch { return; }
        const waiter = fsFiles.get(value?.id);
        if (waiter) { fsFiles.delete(value.id); waiter.reject(error(value.error || "NotReadableError")); }
    });
    const fsCall = (kind, fields) => {
        const call = () => request(kind, fields).then(r => {
        if (typeof r.value === "string" && r.value) {
            try { return JSON.parse(r.value); } catch { return r.value; }
        }
        return r;
        });
        const result = fsQueue.then(call);
        fsQueue = result.catch(() => {});
        return result;
    };
    // A saved file's pieces (fs-write) aren't one request each, waited
    // for in turn (request's one at a time): up to fsWindow in flight,
    // each answered by its id, so a save isn't a round trip a piece. Those
    // the agent didn't take this read (it cancels those it takes) wait
    // for its next.
    const fsWindow = 32;
    const fsWrites = new Map();  // id -> {resolve, reject, timer}
    let fsWriteQueue = [];  // [{id, detail}], not yet taken by the agent
    const fsWriteSend = fields => new Promise((resolve, reject) => {
        const id = randomFSID();
        const timer = setTimeout(() => {
            fsWrites.delete(id);
            fsWriteQueue = fsWriteQueue.filter(q => q.id !== id);
            reject(error("TimeoutError"));
        }, 120000);
        fsWrites.set(id, { resolve, reject, timer });
        fsWriteQueue.push({ id, detail: JSON.stringify({ id, kind: "fs-write", ...fields }) });
    });
    document.addEventListener("__tabtop_read_device", () => {
        while (fsWriteQueue.length) {
            const event = new CustomEvent("__tabtop_device", { detail: fsWriteQueue[0].detail, bubbles: true, composed: true, cancelable: true });
            if (document.dispatchEvent(event)) break;  // (not taken: the agent's had its fill)
            fsWriteQueue.shift();
        }
    });
    document.addEventListener("__tabtop_device_reply", e => {
        let r;
        try { r = JSON.parse(e.detail); } catch { return; }
        const w = fsWrites.get(r?.id);
        if (!w) return;
        fsWrites.delete(r.id);
        clearTimeout(w.timer);
        if (r.error) w.reject(error(r.error));
        else w.resolve(r);
    });
    const fsB64 = bytes => {
        let binary = "";
        for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        return btoa(binary);
    };
    const fsBytes = async value => {
        if (typeof value === "string") return new TextEncoder().encode(value);
        if (value instanceof ArrayBuffer) return new Uint8Array(value);
        if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
        throw new TypeError("Expected a string, Blob, or byte buffer");
    };
    class RemoteFileHandle {
        constructor(meta) { Object.assign(this, meta); }
        get kind() { return "file"; }
        async isSameEntry(other) { return other === this; }
        // An opened file's handle reads only (as the person chose it to
        // be); a save destination's writes too. Not raised: there's no
        // asking the person for more here.
        async queryPermission(d) { return d?.mode === "readwrite" && !this._write ? "prompt" : "granted"; }
        async requestPermission(d) { return d?.mode === "readwrite" && !this._write ? "denied" : "granted"; }
        async getFile() {
            const fileId = randomFSID();
            const file = new Promise((resolve, reject) => fsFiles.set(fileId, { resolve, reject }));
            try {
                const result = await fsCall("fs-read", { handle: this._remote, fileId, value: "" });
                if (!result?.staged) throw error("DataError");
                const got = await file;
                this.size = got.size;
                this.lastModified = got.lastModified;
                return got;
            } catch (err) {
                fsFiles.delete(fileId);
                throw err;
            }
        }
        async createWritable(options = {}) {
            if (!this._write) throw error("NotAllowedError");
            const remote = this._remote, fileHandle = this;
            await fsCall("fs-begin", { handle: remote, value: options.keepExistingData ? "keep" : "" });
            let at = options.keepExistingData ? this.size : 0, closed = false, failed = null;
            if (!options.keepExistingData) fileHandle.size = 0;
            const ensure = () => { if (failed) throw failed; if (closed) throw error("InvalidStateError"); };
            // Its pieces sent fsWindow at a time; all answered before the
            // write is (a failed one fails the writable: later calls too).
            const writeBytes = async (bytes, position) => {
                const length = bytes.size ?? bytes.length;
                const flying = new Set();
                let first = null;
                for (let i = 0; i < length && !first; i += fsChunk) {
                    const end = Math.min(i + fsChunk, length);
                    const part = bytes instanceof Blob
                        ? new Uint8Array(await bytes.slice(i, end).arrayBuffer())
                        : bytes.subarray(i, end);
                    const sent = fsWriteSend({ handle: remote, offset: position + i, value: fsB64(part) })
                        .catch(err => { first ??= err; })
                        .finally(() => flying.delete(sent));
                    flying.add(sent);
                    if (flying.size >= fsWindow) await Promise.race(flying);
                }
                await Promise.all(flying);
                if (first) throw (failed = first);
                fileHandle.size = Math.max(fileHandle.size, position + length);
                return length;
            };
            // Its calls one after another, as they were made (a write's
            // position is where the one before it left off).
            let ops = Promise.resolve();
            const inTurn = f => (...args) => {
                const run = ops.then(() => f(...args));
                ops = run.catch(() => {});
                return run;
            };
            const write = inTurn(async data => {
                    ensure();
                    if (data && typeof data === "object" && !(data instanceof Blob) && !(data instanceof ArrayBuffer) && !ArrayBuffer.isView(data)) {
                        switch (data.type) {
                            case "write": {
                                const bytes = data.data instanceof Blob ? data.data : await fsBytes(data.data);
                                const position = Number.isSafeInteger(data.position) && data.position >= 0 ? data.position : at;
                                const length = await writeBytes(bytes, position); at = position + length; return;
                            }
                            case "seek": if (!Number.isSafeInteger(data.position) || data.position < 0) throw error("TypeError"); at = data.position; return;
                            case "truncate": if (!Number.isSafeInteger(data.size) || data.size < 0) throw error("TypeError"); await fsCall("fs-truncate", { handle: remote, size: data.size, value: "" }); at = Math.min(at, data.size); fileHandle.size = data.size; return;
                            default: throw error("TypeError");
                        }
                    }
                    const bytes = data instanceof Blob ? data : await fsBytes(data);
                    at += await writeBytes(bytes, at);
            });
            const truncate = inTurn(async size => { ensure(); if (!Number.isSafeInteger(size) || size < 0) throw error("TypeError"); await fsCall("fs-truncate", { handle: remote, size, value: "" }); at = Math.min(at, size); fileHandle.size = size; });
            const close = inTurn(async () => { ensure(); await fsCall("fs-close", { handle: remote, value: "" }); closed = true; });
            // (Aborted even once a write's failed: the destination let go.)
            const abort = inTurn(async () => { if (closed) throw error("InvalidStateError"); await fsCall("fs-abort", { handle: remote, value: "" }); closed = true; });
            const stream = new WritableStream({ write, close, abort });
            Object.defineProperties(stream, {
                write: { value: write },
                seek: { value: inTurn(async position => { ensure(); if (!Number.isSafeInteger(position) || position < 0) throw error("TypeError"); at = position; }) },
                truncate: { value: truncate }, close: { value: close }, abort: { value: abort },
            });
            return stream;
        }
    }
    if (isSecureContext && capabilities.fileSystem) {
        method(window, "showOpenFilePicker", async options => {
            if (options?.id !== undefined && typeof options.id !== "string") throw new TypeError("Invalid picker id");
            if (options?.startIn !== undefined) throw error("NotSupportedError");
            const pickerOptions = { multiple: !!options?.multiple, excludeAcceptAllOption: !!options?.excludeAcceptAllOption };
            if (options?.types !== undefined) pickerOptions.types = options.types;
            const result = await fsCall("fs-open", { pickerOptions });
            if (!Array.isArray(result?.files)) throw error("DataError");
            return result.files.map(meta => new RemoteFileHandle({ ...meta, _remote: meta.handle, _write: false }));
        });
        method(window, "showSaveFilePicker", async options => {
            if (options?.id !== undefined && typeof options.id !== "string") throw new TypeError("Invalid picker id");
            if (options?.startIn !== undefined) throw error("NotSupportedError");
            const pickerOptions = { suggestedName: String(options?.suggestedName ?? "untitled"), excludeAcceptAllOption: !!options?.excludeAcceptAllOption };
            if (options?.types !== undefined) pickerOptions.types = options.types;
            const meta = await fsCall("fs-save", { name: pickerOptions.suggestedName, pickerOptions });
            if (!meta?.handle) throw error("DataError");
            return new RemoteFileHandle({ ...meta, _remote: meta.handle, _write: true });
        });
    }

    // Positions followed (watchPosition): one watch in the person's browser
    // for all the page's watchers (high accuracy if any asks it), its
    // positions each handed to every one; ended once the last is cleared.
    const watchers = new Map();  // id -> {success, failure}
    let nextWatch = 0, watching = null, lastPosition = null;  // watching: "asking" | "on" | "stopping"
    const asPosition = (position) => {
        Object.defineProperty(position.coords, "toJSON", { value: () => ({ ...position.coords }) });
        Object.defineProperty(position, "toJSON", { value: () => ({ coords: position.coords.toJSON(), timestamp: position.timestamp }) });
        return position;
    };
    const positionError = (name, message = name) => {
        const code = name === "NotAllowedError" ? 1 : name === "TimeoutError" ? 3 : 2;
        return { code, message, PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 };
    };
    const duration = value => Math.trunc(Math.max(0, Math.min(0xffffffff, Number(value) || 0)));
    const locationOptions = (options) => ({ enableHighAccuracy: !!options?.enableHighAccuracy, maximumAge: duration(options?.maximumAge),
        timeout: duration(options?.timeout ?? 0xffffffff) });
    function toEach(f) {
        for (const w of [...watchers.values()]) {
            try { f(w); } catch (err) { setTimeout(() => { throw err; }); }
        }
    }
    function watched(r) {
        if (watching !== "on") return;
        if (r.position) {
            lastPosition = r.position;
            toEach((w) => w.success(asPosition(structuredClone(r.position))));
        } else if (r.error) {
            // The person's browser's error: the page's watchers told; one
            // that ends it (refused) ends them.
            toEach((w) => w.failure?.(positionError(r.error)));
            if (r.error === "NotAllowedError" || r.ended) { watchers.clear(); watching = null; }
        } else if (r.ended) {
            watchers.clear();
            watching = null;
        }
    }
    // (A request at once may be refused, another being asked: tried again.)
    function stopWatching() {
        if (watching !== "on" || watchers.size) return;
        watching = "stopping";
        request("location-stop", {}).then(() => {
            const again = watching !== "stopping" && watchers.size;
            watching = null;
            if (again) startWatch();  // (watched again while it was stopped)
        }, (err) => {
            // Not stopped: on still (watched again meanwhile, it's wanted).
            const again = watching === "restart";
            if (watching !== "stopping" && !again) return;
            watching = "on";
            if (!again && err.name === "InvalidStateError") setTimeout(stopWatching, 1000);
        });
    }
    function startWatch() {
        watching = "asking";
        const highAccuracy = [...watchers.values()].some((w) => w.options.enableHighAccuracy);
        const options = { ...[...watchers.values()].at(-1).options, enableHighAccuracy: highAccuracy };
        request("location-watch", { options }).then(({ position }) => {
            if (watching !== "asking") return;
            watching = "on";
            lastPosition = position;
            toEach((w) => w.success(asPosition(structuredClone(position))));
            stopWatching();  // (all cleared while it was asked)
        }, (err) => {
            if (watching !== "asking") return;
            watching = null;
            toEach((w) => w.failure?.(positionError(err.name, err.message)));
            watchers.clear();
        });
    }
    if (isSecureContext && capabilities.location && navigator.geolocation) {
        method(navigator.geolocation, "getCurrentPosition", function (success, failure, options = {}) {
            if (typeof success !== "function" || (failure != null && typeof failure !== "function")) throw new TypeError("Invalid position callback");
            request("location", { options: locationOptions(options) }).then(({ position }) => success(asPosition(position)),
                err => failure?.(positionError(err.name, err.message)));
        });
        method(navigator.geolocation, "watchPosition", function (success, failure, options = {}) {
            if (typeof success !== "function" || (failure != null && typeof failure !== "function")) throw new TypeError("Invalid position callback");
            const id = ++nextWatch;
            watchers.set(id, { success, failure: failure ?? null, options: locationOptions(options) });
            if (watching === "on" && lastPosition) {
                const position = structuredClone(lastPosition);
                setTimeout(() => { if (watchers.has(id)) success(asPosition(position)); }, 0);
            } else if (watching === "stopping") {
                watching = "restart";  // (started again once its stop's answered)
            } else if (!watching) {
                startWatch();
            }
            return id;
        });
        method(navigator.geolocation, "clearWatch", function (id) {
            watchers.delete(Number(id));
            stopWatching();
        });
    }

    function pipEvent(el, type, win) {
        const event = new Event(type);
        Object.defineProperty(event, "pictureInPictureWindow", { value: win });
        el.dispatchEvent(event);
    }
    if (capabilities.pip && globalThis.HTMLVideoElement) {
        getter(document, "pictureInPictureEnabled", () => true);
        getter(document, "pictureInPictureElement", () => currentVideo ?? null);
        method(HTMLVideoElement.prototype, "requestPictureInPicture", async function () {
            if (!this.isConnected || this.disablePictureInPicture) throw error("InvalidStateError");
            if (currentVideo === this) return pipWindow;
            const r = await request("pip", {}, this);
            currentVideo = this;
            pipWindow = Object.assign(new EventTarget(), { width: r.width, height: r.height });
            eventHandler(pipWindow, "resize");
            pipEvent(this, "enterpictureinpicture", pipWindow);
            return pipWindow;
        });
        method(document, "exitPictureInPicture", async () => {
            if (!currentVideo) throw error("InvalidStateError");
            await request("pip-exit", {});
        });
    }
})
