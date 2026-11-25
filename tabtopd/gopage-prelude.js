// What the page-world stand-ins share. goPageSource (gobrowser.go) puts
// this first, in the one function they all run in, each guarded on its own
// (one that throws as it's set up takes none of the others with it): so
// these names are theirs, never the page's.

// tabtopTop is the topmost window of this page's origin: its own, or, in
// an embedded page of the same origin, the one it's in.
const tabtopTop = () => {
    let w = window;
    try {
        while (w.parent !== w) {
            void w.parent.document;  // (another origin's: throws)
            w = w.parent;
        }
    } catch { /* this origin's topmost */ }
    return w;
};

// tabtopIsTop is whether this is the page itself, not an embedded page.
const tabtopIsTop = (() => { try { return window.top === window; } catch { return false; } })();

// tabtopID is a new id for a request, as the agent takes them (goAskID).
const tabtopID = () => Math.random().toString(36).slice(2) + Date.now().toString(36);

// tabtopAsker is the requests of one kind, answered by the server through
// the agent on answerType: ask(send, timeout, onTimeout) makes one, its id
// sent by send(id) (what send gives back is kept with it), and is settled
// by answered(d, resolve, reject, kept) when its answer d comes, or by
// onTimeout(resolve, reject, kept) if none does within timeout. An answer
// with no request's id (a lock lost, or left) goes to unsolicited(d).
const tabtopAsker = (answerType, answered, unsolicited) => {
    const waiting = new Map();  // id -> {resolve, reject, timer, kept}
    let listening = false;
    return (send, timeout, onTimeout) => {
        if (!listening) {
            listening = true;
            document.addEventListener(answerType, (e) => {
                let d;
                try { d = JSON.parse(e.detail); } catch { return; }
                const w = typeof d?.id === "string" && waiting.get(d.id);
                if (!w) {
                    unsolicited?.(d);
                    return;
                }
                waiting.delete(d.id);
                clearTimeout(w.timer);
                answered(d, w.resolve, w.reject, w.kept);
            });
        }
        return new Promise((resolve, reject) => {
            const id = tabtopID();
            const w = { resolve, reject };
            w.timer = setTimeout(() => { waiting.delete(id); onTimeout(resolve, reject, w.kept); }, timeout);
            waiting.set(id, w);
            w.kept = send(id);
        });
    };
};

// tabtopTell tells the agent (in its own world) type, with detail as
// JSON, on doc: kept till the agent next reads the page (__tabtop_read,
// with each batch), so what's said as the page loads, before the agent's
// there to hear it, isn't lost. (What's said on an element, its target
// the agent's to know, is dispatched there at once instead.)
const tabtopOutbox = new WeakMap();  // doc -> [[type, detail]]
const tabtopTell = (doc, type, detail) => {
    let box = tabtopOutbox.get(doc);
    if (!box) {
        box = [];
        tabtopOutbox.set(doc, box);
        doc.addEventListener("__tabtop_read", () => {
            for (const [t, d] of box.splice(0)) {
                try { doc.dispatchEvent(new CustomEvent(t, { detail: d })); } catch { /* told nothing */ }
            }
        });
    }
    if (box.length < 64) box.push([type, JSON.stringify(detail)]);
};
