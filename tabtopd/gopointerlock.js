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
    let current = null;
    const fire = (type, at = document) => setTimeout(() => at.dispatchEvent(new Event(type, { bubbles: true, composed: true })), 0);
    const refused = (why) => {
        fire("pointerlockerror");
        return Promise.reject(new DOMException(why, "NotAllowedError"));
    };
    // The server's answer to a request ({id, ok}: the element asked for
    // kept with it), or the lock left ({exit: true}).
    const ask = tabtopAsker("__tabtop_pointerlock_answer", (d, resolve, reject, el) => {
        if (!d.ok || !el.isConnected) {
            fire("pointerlockerror");
            return reject(new DOMException("The user has exited the lock before this request was completed.", "NotAllowedError"));
        }
        current = el;
        fire("pointerlockchange");
        resolve();
    }, (d) => {
        if (!d?.exit || !current) return;
        current = null;
        fire("pointerlockchange");
    });
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
            if (!tabtopIsTop) return refused("Pointer lock isn't available in an embedded page here.");
            if (watching !== document) {
                watching = document;
                gone.observe(document, { childList: true, subtree: true });
            }
            if (current === el) return Promise.resolve();
            return ask((id) => {
                try {
                    el.dispatchEvent(new CustomEvent("__tabtop_pointerlock", { bubbles: true, composed: true, detail: JSON.stringify({ on: true, id, raw: !!options?.unadjustedMovement }) }));
                } catch { /* asked nothing */ }
                return el;
            }, 10_000, (resolve, reject) => {
                fire("pointerlockerror");
                reject(new DOMException("Pointer lock requires transient user activation.", "NotAllowedError"));
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
