import { login } from "./tunnel-protocol.js";
import { saveSession } from "./session-state.js";

export function loginForm(title, cancellable = false) {
    const box = document.createElement("div");
    Object.assign(box.style, {
        position: "fixed", inset: "0", zIndex: "1000", overflow: "auto", padding: "2rem 1rem",
        font: "15px/1.5 system-ui, sans-serif", color: "#e8e8ea", background: "#1c1c1e",
    });
    const form = document.createElement("form");
    form.id = "tabtop_login";
    form.style.maxWidth = "56rem";
    form.style.margin = "0 auto";
    const h1 = document.createElement("h1");
    h1.textContent = title;
    Object.assign(h1.style, { fontSize: "1.25rem", fontWeight: "600" });
    const error = document.createElement("p");
    error.style.color = "#f28b82";
    const input = document.createElement("input");
    Object.assign(input, { type: "password", id: "tabtop_login_code", autocomplete: "off", required: true });
    Object.assign(input.style, { font: "inherit", fontSize: "1.25rem", width: "16em", minWidth: "0", flex: "0 1 16em" });
    const label = document.createElement("label");
    label.htmlFor = input.id;
    label.textContent = "Password + authenticator code";
    // Its own look for the buttons, not the page's (the files page's are
    // drawn for its light or dark theme; this form is always dark).
    const look = (b, main) => Object.assign(b.style, {
        all: "revert", font: "inherit", padding: "0 1rem", borderRadius: "6px", cursor: "pointer", whiteSpace: "nowrap",
        flexShrink: "0",
        ...(main ? { color: "#1c1c1e", background: "#8ab4f8", border: "1px solid #8ab4f8" }
            : { color: "#e8e8ea", background: "transparent", border: "1px solid #5f6368" }),
    });
    const button = document.createElement("button");
    button.textContent = "Log in";
    look(button, true);
    // The buttons on the same line as the field, which narrows to fit,
    // and as tall as it.
    const row = document.createElement("div");
    Object.assign(row.style, { display: "flex", alignItems: "stretch", gap: ".5rem", marginTop: ".25rem" });
    row.append(input, button);
    const note = document.createElement("p");
    Object.assign(note.style, { opacity: "0.7", fontSize: "13px" });
    note.textContent = "End-to-end encrypted. The code never leaves this page: it's used to agree on keys "
        + "with the desktop. One login covers the desktop, terminal and downloads.";
    const p1 = document.createElement("p");
    p1.append(label, row);
    form.append(h1, error, p1, note);
    box.append(form);
    document.body.append(box);
    input.focus();

    return new Promise((resolve) => {
        if (cancellable) {
            const cancel = document.createElement("button");
            Object.assign(cancel, { type: "button", textContent: "Cancel" });
            look(cancel, false);
            cancel.addEventListener("click", () => {
                box.remove();
                resolve(null);
            });
            row.append(cancel);
        }
        form.addEventListener("submit", async (e) => {
            e.preventDefault();
            button.disabled = true;
            button.style.opacity = ".6";  // busy agreeing on keys
            error.textContent = "";
            try {
                const { ip, logins, ...s } = await login(input.value.trim());
                saveSession(s);
                box.remove();
                showLoginSummary(ip, logins);
                resolve(s);
            } catch (err) {
                error.textContent = err.message;
                input.value = "";
                input.focus();
            } finally {
                button.disabled = false;
                button.style.opacity = "";
            }
        });
    });
}

// showLoginSummary shows the logins before this one, so one you didn't
// make stands out: briefly, or until dismissed if there were failed
// attempts or the last login came from another address. A page changed on
// the way could hide it; the files page's list of sessions and the
// gateway's log say the same.
function showLoginSummary(ip, logins) {
    const lastOK = logins.findIndex((l) => l.ok);
    const failed = logins.slice(0, lastOK < 0 ? logins.length : lastOK);
    const prev = logins[lastOK];
    const warn = failed.length > 0 || (prev && prev.ip !== ip);
    const when = (t) => new Date(t).toLocaleString();
    const lines = [prev ? `Previous login: ${when(prev.time)} from ${prev.ip}.`
        : "No earlier login since the server started."];
    if (failed.length) {
        const ips = [...new Set(failed.map((l) => l.ip))].join(", ");
        lines.push(`${failed.length} failed ${failed.length === 1 ? "attempt" : "attempts"} since then, from ${ips}.`);
    }
    lines.push(`This login: from ${ip}.`);
    const box = document.createElement("div");
    box.id = "tabtop_login_summary";
    box.setAttribute("role", "status");
    Object.assign(box.style, {
        // At the top, clear of the files page's transfers at the bottom
        // and the terminal's bar.
        position: "fixed", right: "1rem", top: "2.5rem", left: "1rem", marginLeft: "auto", maxWidth: "26rem",
        zIndex: "1001", padding: ".75rem 1rem", borderRadius: "8px", font: "14px/1.5 system-ui, sans-serif",
        color: "#e8e8ea", background: warn ? "#5c1d1a" : "#2c2c2e", boxShadow: "0 2px 12px rgba(0,0,0,.4)",
    });
    for (const line of lines) {
        const p = document.createElement("p");
        p.style.margin = "0 0 .25rem";
        p.textContent = line;
        box.append(p);
    }
    const close = document.createElement("button");
    close.textContent = "OK";
    close.addEventListener("click", () => box.remove());
    box.append(close);
    document.body.append(box);
    if (!warn) {
        setTimeout(() => box.remove(), 10000);
    }
}
