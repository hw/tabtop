// The bridge between a sandboxed preview frame (md-frame.js, epub-frame.js,
// pdf-frame.js) and the page that made it (preview-frames.js), loaded by
// each frame's page before its own script: TabTopFrameBridge(page,
// handle) gives ask, which sends the page a message and is settled by its
// answer (its id's); what else the page sends goes to handle. Only the
// page's messages are taken (event.source); the frame's origin is opaque,
// so "*" is the only target origin it can name.
window.TabTopFrameBridge = (page, handle) => {
    const waiting = new Map();
    let lastId = 0;
    window.addEventListener("message", (e) => {
        if (e.source !== page || !e.data || typeof e.data !== "object") {
            return;
        }
        const m = e.data;
        if (m.id && waiting.has(m.id)) {
            waiting.get(m.id)(m);
            waiting.delete(m.id);
        } else {
            handle(m);
        }
    });
    return (message) => new Promise((resolve) => {
        const id = ++lastId;
        waiting.set(id, resolve);
        page.postMessage({ ...message, id }, "*");
    });
};
