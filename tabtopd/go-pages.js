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

// say says what was done, or (error) why it wasn't, in a toast kept in
// sight as the page scrolls (the status line), with an action if given
// ({label, run}: Reload page, say). What was done goes after a while;
// an error stays till the next thing's done.
let sayTimer = 0;
export function say(text, error = false, action = null) {
    const done = $("done");
    let button = $("done_action");
    if (!button) {
        // (Its own element, not in the status line: what's said is its text.)
        const toast = Object.assign(document.createElement("div"), { className: "toast", id: "toast" });
        done.replaceWith(toast);
        button = Object.assign(document.createElement("button"), { type: "button", id: "done_action", hidden: true });
        toast.append(done, button);
    }
    done.textContent = text;
    done.classList.toggle("error", error);
    button.hidden = !action;
    button.textContent = action?.label ?? "";
    button.onclick = action ? () => { say(""); action.run(); } : null;
    $("toast").classList.toggle("shown", !!text);
    clearTimeout(sayTimer);
    if (text && !error) sayTimer = setTimeout(() => $("toast").classList.remove("shown"), action ? 10000 : 5000);
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
            // (done: what's said, or {text, action} with an action by it.)
            if (done) typeof done === "string" ? say(done) : say(done.text, false, done.action);
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
