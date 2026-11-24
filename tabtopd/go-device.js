// Native actions run in the viewer. The visible origin comes from the server's
// navigation state. Each approval and result belongs to one connection/document.
export function viewerCapabilities() {
    let shareFiles = false;
    try { shareFiles = typeof navigator.canShare === "function" && navigator.canShare({ files: [new File(["x"], "x.txt", { type: "text/plain" })] }); } catch { /* none */ }
    return { share: typeof navigator.share === "function", shareFiles, location: !!navigator.geolocation,
        pip: !!document.pictureInPictureEnabled && typeof HTMLVideoElement.prototype.requestPictureInPicture === "function" };
}

export function viewerDevices(box, current, getVideo, getFile = async () => null) {
    const text = box.querySelector("p"), allow = box.querySelector(".allow");
    let pending, timer, activePiP, activeWatch;
    // A position followed: said while it is (the origin, Stop), as a
    // browser's location icon says it.
    const bar = globalThis.document?.getElementById("go_location") ?? null;
    bar?.querySelector(".stop")?.addEventListener("click", () => {
        const w = activeWatch;
        if (!w) return;
        unwatch();
        send(w.request, { kind: "location-ended" });
    });
    // update sends a followed position, every 250 ms at most: one sooner
    // waits, the newest sent when it may be (none lost: the last is where
    // the person is).
    function update(w, value) {
        w.next = value;
        if (w.timer) return;
        const wait = Math.max(0, (w.sentAt ?? 0) + 250 - performance.now());
        w.timer = setTimeout(() => {
            w.timer = null;
            if (activeWatch !== w || w.next === null || !valid(w.request)) return;
            w.sentAt = performance.now();
            send(w.request, { kind: "location-update", value: w.next });
            w.next = null;
        }, wait);
    }
    function unwatch() {
        if (!activeWatch) return;
        clearTimeout(activeWatch.timer);
        navigator.geolocation.clearWatch(activeWatch.id);
        activeWatch = null;
        if (bar) bar.hidden = true;
    }
    const coordsOf = (position) => {
        const coords = {};
        for (const name of ["latitude", "longitude", "accuracy", "altitude", "altitudeAccuracy", "heading", "speed"]) {
            coords[name] = position.coords[name] ?? null;
        }
        return JSON.stringify({ coords, timestamp: position.timestamp });
    };
    function valid(r) {
        const { socket, gen } = current();
        return r.socket === socket && r.gen === gen;
    }
    function send(r, values) {
        if (valid(r)) r.socket.send(JSON.stringify({ op: "device-answer", gen: r.gen, text: r.ask, ...values }));
    }
    function finish(r, values) {
        if (pending !== r) return;
        clearTimeout(timer);
        pending = null;
        box.hidden = true;
        send(r, values);
    }
    async function run(r) {
        if (!r || !valid(r) || r.running) return;
        r.running = true;
        box.hidden = true;
        try {
            switch (r.kind) {
                case "location": {
                    const position = await new Promise((resolve, reject) => navigator.geolocation.getCurrentPosition(resolve, reject, r.options));
                    finish(r, { accept: true, value: coordsOf(position) });
                    break;
                }
                case "location-watch": {
                    // Its first position answers; those after it go as they
                    // come, its errors too, till it's stopped.
                    unwatch();
                    const errors = ["", "NotAllowedError", "PositionUnavailableError", "TimeoutError"];
                    await new Promise((resolve, reject) => {
                        let first = true;
                        const id = navigator.geolocation.watchPosition((position) => {
                            if (first) {
                                first = false;
                                if (pending !== r || !valid(r)) { navigator.geolocation.clearWatch(id); return reject(new DOMException("Gone", "AbortError")); }
                                activeWatch = { request: r, id, sentAt: performance.now(), next: null, timer: null };
                                if (bar) {
                                    bar.querySelector(".what").textContent = `${r.origin} is following your location.`;
                                    bar.hidden = false;
                                }
                                finish(r, { accept: true, value: coordsOf(position) });
                                return resolve();
                            }
                            if (activeWatch?.id === id && valid(r)) update(activeWatch, coordsOf(position));
                        }, (err) => {
                            if (first) {
                                navigator.geolocation.clearWatch(id);
                                return reject(err);
                            }
                            if (activeWatch?.id === id && valid(r)) {
                                send(r, { kind: "location-error", value: errors[err?.code] || "PositionUnavailableError" });
                                if (err?.code === 1) unwatch();
                            }
                        }, r.options);
                    });
                    break;
                }
                case "location-stop":
                    unwatch();
                    finish(r, { accept: true });
                    break;
                case "share": {
                    // (Its files gathered before it was asked: ask.)
                    const data = r.shared?.length ? { ...r.data, files: r.shared } : r.data;
                    if (!navigator.share || (navigator.canShare && !navigator.canShare(data))) throw new DOMException("Unavailable", "NotSupportedError");
                    await navigator.share(data);
                    finish(r, { accept: true });
                    break;
                }
                case "pip": {
                    const video = getVideo(r.node);
                    if (!video) throw new DOMException("Player unavailable", "InvalidStateError");
                    const win = await video.requestPictureInPicture();
                    if (pending !== r || !valid(r)) {
                        if (document.pictureInPictureElement === video) await document.exitPictureInPicture();
                        return;
                    }
                    if (activePiP) left(activePiP);
                    activePiP = { request: r, video, win, resize: () => send(r, { kind: "pip-resize", fx: win.width, fy: win.height }) };
                    win.addEventListener("resize", activePiP.resize);
                    const session = activePiP;
                    video.addEventListener("leavepictureinpicture", () => left(session), { once: true });
                    finish(r, { accept: true, fx: win.width, fy: win.height });
                    break;
                }
                case "pip-exit":
                    if (activePiP && document.pictureInPictureElement === activePiP.video) await document.exitPictureInPicture();
                    finish(r, { accept: true });
                    break;
            }
        } catch (err) {
            const locationErrors = ["", "NotAllowedError", "PositionUnavailableError", "TimeoutError"];
            finish(r, { value: (r.kind === "location" || r.kind === "location-watch") && locationErrors[err?.code] || err?.name || "NotAllowedError" });
        }
    }
    function left(session) {
        if (activePiP !== session) return;
        session.win.removeEventListener("resize", session.resize);
        activePiP = null;
        send(session.request, { kind: "pip-left" });
    }
    function reset() {
        unwatch();
        clearTimeout(timer);
        pending = null;
        box.hidden = true;
        const video = activePiP?.video;
        if (activePiP) left(activePiP);
        if (video && document.pictureInPictureElement === video) document.exitPictureInPicture().catch(() => {});
    }
    function ask(m) {
        const r = { ...m, socket: current().socket };
        if (pending || !valid(r)) return send(r, { value: "InvalidStateError" });
        pending = r;
        timer = setTimeout(() => finish(r, { value: "TimeoutError" }), 115000);
        if (r.kind === "pip-exit" || r.kind === "location-stop") return void run(r);
        if (r.kind === "pip" && !getVideo(r.node)) return finish(r, { value: "InvalidStateError" });
        const labels = {
            share: ["wants to open your share sheet.", "Share"],
            location: ["wants your current location.", "Share location"],
            "location-watch": ["wants to follow your location (until you stop it, or leave the page).", "Share location"],
            pip: ["wants to show its video in picture-in-picture.", "Open video"],
        };
        const label = labels[r.kind];
        if (!label) return finish(r, { value: "NotSupportedError" });
        const files = r.kind === "share" && Array.isArray(r.files) ? r.files.slice(0, 10) : [];
        const show = () => {
            text.textContent = r.origin + " " + (files.length ? `wants to open your share sheet with ${files.length === 1 ? files[0].name : `${files.length} files`}.` : label[0]);
            allow.textContent = label[1];
            box.hidden = false;
        };
        if (files.length) {
            // Its files first, all of them (the press that shares them is
            // the person's, a gesture their share sheet takes, only if
            // nothing's waited for after it).
            Promise.all(files.map((f) => getFile(f.stream, f.type))).then((got) => {
                if (pending !== r) return;
                if (got.some((f) => !f)) return finish(r, { value: "DataError" });
                r.shared = got.map((file, i) => new File([file], files[i].name, { type: file.type }));  // (as the server named it)
                show();
                (r.kind === "location" || r.kind === "location-watch" ? box.querySelector(".refuse") : allow).focus();
            });
            return;
        }
        show();
        (r.kind === "location" || r.kind === "location-watch" ? box.querySelector(".refuse") : allow).focus();
    }
    allow.addEventListener("click", () => run(pending));
    function cancel() { if (pending) finish(pending, { value: pending.kind === "location" || pending.kind === "location-watch" ? "NotAllowedError" : "AbortError" }); }
    box.querySelector(".refuse").addEventListener("click", cancel);
    box.addEventListener("keydown", e => { if (e.key === "Escape") cancel(); });
    return { ask, reset };
}

export async function sendPasteImage(m, current, warn) {
    const socket = current().socket;
    if (!socket || !(m.png instanceof Blob) || m.png.type !== "image/png" || !m.png.size) return;
    if (m.png.size > 8 << 20) return warn("Pasted images can be up to 8 MiB.");
    const bytes = new Uint8Array(await m.png.arrayBuffer());
    if (current().socket !== socket || current().gen !== m.gen) return;
    const text = Array.from(crypto.getRandomValues(new Uint32Array(3)), n => n.toString(36)).join("");
    const send = fields => socket.send(JSON.stringify({ op: "paste-image", gen: m.gen, text, ...fields }));
    send({ type: "start", count: bytes.length, id: m.id, frame: m.frame, fdoc: m.fdoc, route: m.route, docs: m.docs, sel: m.sel });
    // Multiples of three keep base64 padding in the final chunk only.
    const chunk = 24 * 1024;
    for (let at = 0; at < bytes.length; at += chunk) {
        send({ type: "chunk", value: btoa(String.fromCharCode(...bytes.subarray(at, at + chunk))) });
    }
    send({ type: "end" });
}
