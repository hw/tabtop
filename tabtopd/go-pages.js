// What the browser's own pages share: Site controls (go/sites, go-sites.js)
// and Settings (go/settings, go-settings.js).
import { call } from "../tabtop/requests.js";

export const $ = (id) => document.getElementById(id);

// In the browser's lightbox (go.js): its own header not shown (the
// lightbox's is), and its link back closes the lightbox.
if (window.parent !== window) {
    document.documentElement.classList.add("framed");
    $("back").addEventListener("click", (event) => {
        event.preventDefault();
        parent.postMessage({ goSettings: "close" }, location.origin);
    });
}

// told tells the browser's page a setting changed that its tab acts on.
export function told(what) {
    if (window.parent !== window) parent.postMessage({ goSettings: what }, location.origin);
}

export function say(text, error = false) {
    $("done").textContent = text;
    $("done").classList.toggle("error", error);
}

export async function ask(req) {
    const t = await call(req);
    t.close();
    return t.reply;
}

// runner gives a page's run: one action at a time, render before and
// after (its controls disabled while busy), what it did or why it failed
// said.
export function runner(render) {
    const state = { busy: false };
    state.run = async (action, done) => {
        if (state.busy) return false;
        state.busy = true;
        say("");
        render();
        try {
            await action();
            if (done) say(done);
            return true;
        } catch (err) {
            say(err.message, true);
            return false;
        } finally {
            state.busy = false;
            render();
        }
    };
    return state;
}
