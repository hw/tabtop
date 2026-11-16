import { login, passkeyLogin, passkeysUsable } from "./tunnel-protocol.js";
import { iconSVG } from "./glyphs.js";
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
        const attempt = new AbortController();
        let cancelled = false;
        if (cancellable) {
            const cancel = document.createElement("button");
            Object.assign(cancel, { type: "button", textContent: "Cancel" });
            look(cancel, false);
            cancel.addEventListener("click", () => {
                cancelled = true;
                attempt.abort();
                box.remove();
                resolve(null);
            });
            row.append(cancel);
        }
        // With a passkey, where this page can use one (see passkey.go).
        let usePasskey = false, passkey = null;
        if (passkeysUsable()) {
            const style = document.createElement("style");
            style.textContent = `
                #tabtop_login .passkey-option { max-width: 26rem; margin: 1.2rem 0; }
                #tabtop_login .passkey-divider { display: flex; align-items: center; gap: .8rem; margin: 0 0 1rem; color: #9aa0a6; font-size: .8rem; }
                #tabtop_login .passkey-divider::before, #tabtop_login .passkey-divider::after { content: ""; flex: 1; height: 1px; background: #3c4043; }
                #tabtop_login .passkey-login { all: revert; box-sizing: border-box; display: flex; align-items: center; gap: .85rem; width: 100%; min-height: 4.5rem; padding: .8rem 1rem; border: 1px solid #6385b3; border-radius: 12px; font: inherit; color: #e8f0fe; background: #222e3d; cursor: pointer; text-align: left; transition: background .15s, border-color .15s; }
                #tabtop_login .passkey-login:hover:not(:disabled) { background: #2b3d53; border-color: #aecbfa; }
                #tabtop_login .passkey-login:active:not(:disabled) { background: #334b68; }
                #tabtop_login .passkey-login:focus-visible { outline: 3px solid #aecbfa; outline-offset: 3px; }
                #tabtop_login .passkey-login:disabled { opacity: .6; cursor: wait; }
                #tabtop_login .passkey-icon { display: inline-flex; align-items: center; justify-content: center; flex: none; width: 2.5rem; height: 2.5rem; border-radius: 10px; background: #344c6a; color: #aecbfa; }
                #tabtop_login .passkey-icon svg { display: block; }
                #tabtop_login .passkey-copy { display: flex; flex-direction: column; gap: .15rem; min-width: 0; }
                #tabtop_login .passkey-copy strong { font-size: 1rem; font-weight: 600; }
                #tabtop_login .passkey-copy small { font-size: .8rem; color: #bdc9da; }
                #tabtop_login .passkey-arrow { margin-left: auto; color: #aecbfa; font-size: 1.3rem; }
                @media (prefers-reduced-motion: reduce) { #tabtop_login .passkey-login { transition: none; } }
            `;
            box.append(style);
            passkey = document.createElement("button");
            Object.assign(passkey, { type: "submit", className: "passkey-login" });
            const icon = document.createElement("span");
            icon.className = "passkey-icon";
            icon.setAttribute("aria-hidden", "true");
            icon.innerHTML = iconSVG("passkey");
            const copy = document.createElement("span");
            copy.className = "passkey-copy";
            const heading = document.createElement("strong"); heading.textContent = "Use a passkey";
            const hint = document.createElement("small"); hint.textContent = "Use your device or security key";
            copy.append(heading, hint);
            const arrow = document.createElement("span"); arrow.className = "passkey-arrow"; arrow.textContent = "›"; arrow.setAttribute("aria-hidden", "true");
            passkey.append(icon, copy, arrow);
            passkey.addEventListener("click", () => { usePasskey = true; input.required = false; });
            const option = document.createElement("div"); option.className = "passkey-option";
            const divider = document.createElement("div"); divider.className = "passkey-divider"; divider.textContent = "or";
            option.append(divider, passkey);
            form.insertBefore(option, note);
        }
        form.addEventListener("submit", async (e) => {
            e.preventDefault();
            const withPasskey = usePasskey;
            usePasskey = false;
            input.required = true;
            if (cancelled || button.disabled) { return; }
            button.disabled = true;
            if (passkey) { passkey.disabled = true; passkey.setAttribute("aria-busy", String(withPasskey)); }
            button.style.opacity = ".6";  // busy agreeing on keys
            error.textContent = "";
            try {
                const { ip, logins, ...s } = withPasskey ? await passkeyLogin(undefined, { signal: attempt.signal })
                    : await login(input.value.trim(), undefined, { signal: attempt.signal });
                if (cancelled) { return; }
                saveSession(s);
                box.remove();
                showLoginSummary(ip, logins);
                resolve(s);
            } catch (err) {
                if (cancelled) { return; }
                error.textContent = err.message;
                input.value = "";
                input.focus();
            } finally {
                if (!cancelled) {
                    button.disabled = false;
                    if (passkey) { passkey.disabled = false; passkey.setAttribute("aria-busy", "false"); }
                    button.style.opacity = "";
                }
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
