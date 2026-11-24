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

    function shareData(data) {
        if (!data || data.files?.length) throw new TypeError("Only text and links can be shared");
        const out = {};
        for (const key of ["title", "text", "url"]) {
            if (data[key] !== undefined) out[key] = String(data[key]);
        }
        if (!Object.keys(out).length) throw new TypeError("No share data");
        if (out.url !== undefined) {
            const url = new URL(out.url, document.baseURI);
            if (!["http:", "https:"].includes(url.protocol)) throw new TypeError("Unsupported share URL");
            out.url = url.href;
        }
        if (JSON.stringify(out).length > 8192) throw new TypeError("Share data is too large");
        return out;
    }
    if (isSecureContext && capabilities.share) {
        method(navigator, "canShare", data => {
            try { shareData(data); return true; } catch { return false; }
        });
        method(navigator, "share", async data => { await request("share", { data: shareData(data) }); });
    }

    if (isSecureContext && capabilities.location && navigator.geolocation) {
        method(navigator.geolocation, "getCurrentPosition", function (success, failure, options = {}) {
            if (typeof success !== "function" || (failure != null && typeof failure !== "function")) throw new TypeError("Invalid position callback");
            const duration = value => Math.trunc(Math.max(0, Math.min(0xffffffff, Number(value) || 0)));
            const opts = { enableHighAccuracy: !!options?.enableHighAccuracy, maximumAge: duration(options?.maximumAge),
                timeout: duration(options?.timeout ?? 0xffffffff) };
            request("location", { options: opts }).then(({ position }) => {
                Object.defineProperty(position.coords, "toJSON", { value: () => ({ ...position.coords }) });
                Object.defineProperty(position, "toJSON", { value: () => ({ coords: position.coords.toJSON(), timestamp: position.timestamp }) });
                success(position);
            }, err => {
                const code = err.name === "NotAllowedError" ? 1 : err.name === "TimeoutError" ? 3 : 2;
                failure?.({ code, message: err.message, PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 });
            });
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
