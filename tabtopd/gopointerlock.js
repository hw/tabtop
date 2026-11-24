// The page's pointer lock (requestPointerLock, document.pointerLockElement,
// exitPointerLock), in its own world, for an engine whose lock is only its
// own (Moli 1.1.27, measured: requestPointerLock refused without its own
// activation; nothing of the person's pointer could reach it locked). Asked
// for, it's asked of the server through the agent (gopointerlock.go: the
// top page's, after the person's input there), and the person's browser
// locks its pointer to the copy (go-frame.js): once it has, the page's told
// (pointerlockchange, its promise kept), and the pointer's moves come as
// movementX/movementY on the locked element (goagent.js), its buttons and
// wheel there too. Left (Esc, the window left, the page's exitPointerLock),
// it's left in both, the page told.
//
// An embedded page's is refused (pointerlockerror).
(() => {
    if (!("requestPointerLock" in Element.prototype)) return;
    const isTop = (() => { try { return window.top === window; } catch { return false; } })();
    let current = null;
    const waiting = new Map();  // id -> {el, resolve, reject, timer}
    const fire = (type, at = document) => setTimeout(() => at.dispatchEvent(new Event(type, { bubbles: true, composed: true })), 0);
    const refused = (why) => {
        fire("pointerlockerror");
        return Promise.reject(new DOMException(why, "NotAllowedError"));
    };
    let listening = false;
    const listen = () => {
        if (listening) return;
        listening = true;
        document.addEventListener("__tabtop_pointerlock_answer", (e) => {
            let d;
            try { d = JSON.parse(e.detail); } catch { return; }
            if (d?.exit) {
                if (!current) return;
                current = null;
                fire("pointerlockchange");
                return;
            }
            const w = d && waiting.get(d.id);
            if (!w) return;
            waiting.delete(d.id);
            clearTimeout(w.timer);
            if (!d.ok || !w.el.isConnected) {
                fire("pointerlockerror");
                return w.reject(new DOMException("The user has exited the lock before this request was completed.", "NotAllowedError"));
            }
            current = w.el;
            fire("pointerlockchange");
            w.resolve();
        });
    };
    // The element leaving the document leaves the lock, as a browser's.
    const gone = new MutationObserver(() => {
        if (current && !current.isConnected) document.exitPointerLock();
    });
    let watching = null;
    Object.defineProperty(Element.prototype, "requestPointerLock", {
        configurable: true, writable: true, enumerable: true,
        value: { requestPointerLock(options) {
            const el = this;
            if (!(el instanceof Element) || !el.isConnected) return refused("The element is not connected.");
            if (!isTop) return refused("Pointer lock isn't available in an embedded page here.");
            listen();
            if (watching !== document) {
                watching = document;
                gone.observe(document, { childList: true, subtree: true });
            }
            if (current === el) return Promise.resolve();
            return new Promise((resolve, reject) => {
                const id = Math.random().toString(36).slice(2) + Date.now().toString(36);
                const timer = setTimeout(() => {
                    waiting.delete(id);
                    fire("pointerlockerror");
                    reject(new DOMException("Pointer lock requires transient user activation.", "NotAllowedError"));
                }, 10_000);
                waiting.set(id, { el, resolve, reject, timer });
                try {
                    el.dispatchEvent(new CustomEvent("__tabtop_pointerlock", { bubbles: true, composed: true, detail: JSON.stringify({ on: true, id, raw: !!options?.unadjustedMovement }) }));
                } catch { /* asked nothing */ }
            });
        } }.requestPointerLock,
    });
    Object.defineProperty(Document.prototype, "pointerLockElement", {
        configurable: true, enumerable: true,
        get() { return this === document && current?.isConnected ? current : null; },
    });
    Object.defineProperty(Document.prototype, "exitPointerLock", {
        configurable: true, writable: true, enumerable: true,
        value: { exitPointerLock() {
            if (this !== document || !current) return;
            current = null;
            try { document.dispatchEvent(new CustomEvent("__tabtop_pointerlock", { detail: JSON.stringify({ on: false }) })); } catch { /* told nothing */ }
            fire("pointerlockchange");
        } }.exitPointerLock,
    });
})();
