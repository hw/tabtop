// The page's alert, confirm and prompt, in its own world, for an engine that
// answers them itself, at once, and says nothing of them (Obscura: alert
// returns, confirm is false, prompt null; see goAdapter.noDialogs): what
// was asked is told to the agent (goagent.js), which sends it with the
// document's changes, and the person is shown it. The page can't be made to
// wait for their answer (the engine has no way to stop it, nor synchronous
// XMLHttpRequest), so it gets the engine's as before.
//
// It's the page's to see and change, like anything in its world: what it
// says it asked is what it could have asked.
(() => {
    const SEND = "__tabtop_dialog";
    for (const kind of ["alert", "confirm", "prompt"]) {
        const own = window[kind];
        if (typeof own !== "function") continue;
        window[kind] = function (message, value) {
            try {
                const text = message === undefined ? "" : String(message);
                document.dispatchEvent(new CustomEvent(SEND, { detail: JSON.stringify({ kind, message: text.slice(0, 2000) }) }));
            } catch { /* told nothing */ }
            return own.apply(this, arguments);
        };
    }
})();
