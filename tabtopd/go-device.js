// Native actions run in the viewer. The visible origin comes from the server's
// navigation state. Each approval and result belongs to one connection/document.
export function viewerCapabilities() {
    return { share: typeof navigator.share === "function", location: !!navigator.geolocation,
        pip: !!document.pictureInPictureEnabled && typeof HTMLVideoElement.prototype.requestPictureInPicture === "function" };
}

export function viewerDevices(box, current, getVideo) {
    const text = box.querySelector("p"), allow = box.querySelector(".allow");
    let pending, timer, activePiP;
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
                    const coords = {};
                    for (const name of ["latitude", "longitude", "accuracy", "altitude", "altitudeAccuracy", "heading", "speed"]) {
                        coords[name] = position.coords[name] ?? null;
                    }
                    finish(r, { accept: true, value: JSON.stringify({ coords, timestamp: position.timestamp }) });
                    break;
                }
                case "share":
                    if (!navigator.share || (navigator.canShare && !navigator.canShare(r.data))) throw new DOMException("Unavailable", "NotSupportedError");
                    await navigator.share(r.data);
                    finish(r, { accept: true });
                    break;
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
            finish(r, { value: r.kind === "location" && locationErrors[err?.code] || err?.name || "NotAllowedError" });
        }
    }
    function left(session) {
        if (activePiP !== session) return;
        session.win.removeEventListener("resize", session.resize);
        activePiP = null;
        send(session.request, { kind: "pip-left" });
    }
    function reset() {
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
        if (r.kind === "pip-exit") return void run(r);
        if (r.kind === "pip" && !getVideo(r.node)) return finish(r, { value: "InvalidStateError" });
        const labels = {
            share: ["wants to open your share sheet.", "Share"],
            location: ["wants your current location.", "Share location"],
            pip: ["wants to show its video in picture-in-picture.", "Open video"],
        };
        const label = labels[r.kind];
        if (!label) return finish(r, { value: "NotSupportedError" });
        text.textContent = r.origin + " " + label[0];
        allow.textContent = label[1];
        box.hidden = false;
        (r.kind === "location" ? box.querySelector(".refuse") : allow).focus();
    }
    allow.addEventListener("click", () => run(pending));
    function cancel() { if (pending) finish(pending, { value: pending.kind === "location" ? "NotAllowedError" : "AbortError" }); }
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
