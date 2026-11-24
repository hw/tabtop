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
