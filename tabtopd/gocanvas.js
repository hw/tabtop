// Signals Canvas2D pixel changes to the isolated /go agent. The page keeps
// its real context; the agent asks for PNG readbacks only when needed.
(() => {
    const Canvas = globalThis.HTMLCanvasElement;
    const Context = globalThis.CanvasRenderingContext2D;
    if (!Canvas || !Context) return;

    const contexts = new WeakMap();
    const originalGetContext = Canvas.prototype.getContext;
    const originalToDataURL = Canvas.prototype.toDataURL;
    const dispatchEvent = EventTarget.prototype.dispatchEvent;
    const apply = Reflect.apply;
    const EventCtor = Event;
    const CustomEventCtor = CustomEvent;
    const maxPixels = 16 * 1024 * 1024;
    const maxPNG = 1 << 20; // base64 bytes, before the Go message limit
    const dirtyEvent = "__tabtop_canvas_dirty";

    Canvas.prototype.getContext = function (type, ...args) {
        const result = apply(originalGetContext, this, [type, ...args]);
        if (result && String(type).toLowerCase() === "2d" && result instanceof Context) {
            contexts.set(this, result);
        }
        return result;
    };

    // Told at once, then not again till a timer's turn, when it's told once
    // more if it was drawn on meanwhile: the agent only notes the canvas and
    // reads it after (a game's thousands of draws a frame, two events, not
    // thousands; its last draw always told).
    const drawing = new WeakMap(); // canvas -> drawn on since it was told
    const later = typeof globalThis.setTimeout === "function" ? globalThis.setTimeout.bind(globalThis) : null; // (none: each told)
    function dirty(canvas) {
        if (!(canvas instanceof Canvas) || !contexts.has(canvas)) return;
        if (later && drawing.has(canvas)) {
            drawing.set(canvas, true);
            return;
        }
        if (later) drawing.set(canvas, false);
        later?.(() => {
            const again = drawing.get(canvas);
            drawing.delete(canvas);
            if (again) dirty(canvas);
        }, 0);
        try { apply(dispatchEvent, canvas, [new EventCtor(dirtyEvent, { bubbles: true, composed: true })]); }
        catch { /* a replaced or detached canvas */ }
        // In a same-origin frame, told on its iframe too, where the page's
        // agent hears it (it doesn't hear the frame's own events in Moli),
        // as gogl.js does.
        try {
            const owner = globalThis.frameElement;
            if (owner && canvas.ownerDocument === document) {
                const index = Array.prototype.indexOf.call(document.querySelectorAll("canvas"), canvas);
                if (index >= 0) apply(dispatchEvent, owner, [new CustomEventCtor("__tabtop_frame_canvas_dirty", { bubbles: true, detail: JSON.stringify({ index }) })]);
            }
        } catch { /* another origin's frame, or gone */ }
    }

    // Only operations that can change pixels. Path and state setup alone do
    // not trigger a readback; the draw that follows does.
    for (const name of ["clearRect", "fillRect", "strokeRect", "fill", "stroke", "drawImage",
        "putImageData", "fillText", "strokeText", "drawFocusIfNeeded", "reset"]) {
        const descriptor = Object.getOwnPropertyDescriptor(Context.prototype, name);
        if (typeof descriptor?.value !== "function") continue;
        const original = descriptor.value;
        Object.defineProperty(Context.prototype, name, {
            ...descriptor,
            value: function (...args) {
                const result = apply(original, this, args);
                dirty(this.canvas);
                return result;
            },
        });
    }

    // On the window: a frame keeps it from its first (about:blank) document.
    globalThis.addEventListener("__tabtop_canvas_capture", (event) => {
        const canvas = (event.composedPath?.()[0] ?? event.target);  // (in a shadow root too)
        if (!(canvas instanceof Canvas)) return;
        let result;
        if (!contexts.has(canvas)) {
            result = { e: "unsupported" };
        } else if (!canvas.width || !canvas.height || canvas.width * canvas.height > maxPixels) {
            result = { e: "large" };
        } else {
            try {
                const url = apply(originalToDataURL, canvas, ["image/png"]);
                const prefix = "data:image/png;base64,";
                if (!url.startsWith(prefix)) result = { e: "unsupported" };
                else {
                    const p = url.slice(prefix.length);
                    result = p.length <= maxPNG ? { p } : { e: "large" };
                }
            } catch {
                // A cross-origin image can taint a canvas. The viewer never
                // receives external URLs or executes the page's scripts.
                result = { e: "tainted" };
            }
        }
        try {
            apply(dispatchEvent, canvas, [new CustomEventCtor("__tabtop_canvas_pixels", {
                bubbles: true, composed: true, detail: JSON.stringify(result),
            })]);
        } catch { /* detached canvas */ }
    }, true);
})();
