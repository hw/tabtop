// Trying again once the connection to the server is lost, for the
// terminal and the files page, served by tabtopd. (noVNC does the same for
// the desktop, with its own "Reconnecting...": see entrypoint.sh.) A
// banner at the top says so and counts down to the next try, with a
// button to try at once. Tries come a second apart at first, then further
// apart, up to half a minute, and at once when the browser comes back
// online or the tab is shown again.

const delays = [1, 2, 4, 8, 15, 30];  // seconds before each try; the last repeats

let current = null;
let finish = null;  // ends the one going, as connected

// reconnect shows the banner, saying message, and calls attempt() after
// each wait until it resolves to true, then removes the banner. attempt
// resolving to false, or throwing, means it's still lost. While one is
// going, other calls join it; it resolves once connected again.
export function reconnect(message, attempt) {
    current ??= keepTrying(message, attempt).finally(() => (current = null));
    return current;
}

// reconnected ends the tries, if any are going, since the page has
// reached the server some other way.
export function reconnected() {
    finish?.();
}

function keepTrying(message, attempt) {
    return new Promise((resolve) => {
        const text = document.createElement("span");
        const now = Object.assign(document.createElement("button"), { type: "button", textContent: "Try now" });
        Object.assign(now.style, { font: "inherit", marginLeft: ".75rem" });
        const box = document.createElement("div");
        box.id = "tabtop_reconnect";
        box.setAttribute("role", "status");
        Object.assign(box.style, {
            // Above the page and its bar of links, below the login form.
            position: "fixed", top: "2.25rem", left: "50%", transform: "translateX(-50%)", zIndex: "999",
            maxWidth: "calc(100vw - 2rem)", boxSizing: "border-box", padding: ".5rem 1rem", borderRadius: "8px",
            font: "14px/1.5 system-ui, sans-serif", color: "#e8e8ea", background: "#5c1d1a",
            boxShadow: "0 2px 12px rgba(0,0,0,.4)",
        });
        box.append(text, now);
        document.body.append(box);

        let tries = 0;
        let timer = 0;
        let tick = 0;
        let trying = false;
        let over = false;
        const go = async () => {
            if (trying || over) {
                return;
            }
            clearTimeout(timer);
            clearInterval(tick);
            trying = true;
            now.disabled = true;
            text.textContent = `${message} Reconnecting…`;
            let ok = false;
            try {
                ok = await attempt();
            } catch {
                // Still lost.
            }
            trying = false;
            now.disabled = false;
            if (!over) {
                ok ? done() : wait();
            }
        };
        const wait = () => {
            const at = Date.now() + delays[Math.min(tries++, delays.length - 1)] * 1000;
            const count = () => {
                text.textContent = `${message} Trying again in ${Math.max(1, Math.ceil((at - Date.now()) / 1000))} s.`;
            };
            count();
            tick = setInterval(count, 1000);
            timer = setTimeout(go, at - Date.now());
        };
        const shown = () => document.visibilityState === "visible" && go();
        const done = () => {
            over = true;
            finish = null;
            clearTimeout(timer);
            clearInterval(tick);
            removeEventListener("online", go);
            document.removeEventListener("visibilitychange", shown);
            box.remove();
            resolve();
        };
        finish = done;
        now.addEventListener("click", go);
        addEventListener("online", go);
        document.addEventListener("visibilitychange", shown);
        wait();
    });
}
