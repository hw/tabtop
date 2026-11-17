import { loginForm } from "./login-ui.js";
import { Tunnel } from "./tunnel-protocol.js";
import { el } from "./preview-dom.js";
import { iconSVG } from "./glyphs.js";

const STYLE = `
:root { color-scheme: dark; --bg: #12151c; --fg: #e8f0fe; --muted: #9aa8bc; --line: #3d5a80; --raised: #1a2332;
  --panel: linear-gradient(165deg, #24324a 0%, #1a2230 55%, #161c28 100%); --accent: #8ab4f8; --accent-ink: #1c1c1e;
  --chip: #1b2532; --chip-line: #4b6b93; --danger: #f28b82; --ok: #81c995; --warn: #fdd663; }
html, body { min-height: 100%; }
body { margin: 0; font: 15px/1.5 system-ui, sans-serif; color: var(--fg);
  background: radial-gradient(120% 80% at 50% -10%, #2a3b58 0%, transparent 55%), var(--bg); }
#approval { box-sizing: border-box; width: min(28rem, calc(100% - 2rem)); margin: 0 auto; padding: 2.5rem 0 3rem; }
.approval-shell { box-sizing: border-box; padding: 1.25rem 1.35rem 1.2rem; border: 1px solid var(--line); border-radius: 16px;
  background: var(--panel); box-shadow: 0 18px 50px rgba(0, 0, 0, .4); }
.approval-head { display: flex; align-items: flex-start; gap: .85rem; margin-bottom: 1rem; }
.approval-icon { display: inline-flex; align-items: center; justify-content: center; flex: none; width: 2.75rem; height: 2.75rem;
  border-radius: 12px; background: #344c6a; color: var(--accent); }
.approval-icon svg { display: block; }
.approval-head h1 { margin: 0; font-size: 1.2rem; font-weight: 650; letter-spacing: -.01em; color: var(--fg); }
.approval-host { margin: .2rem 0 0; font-size: .85rem; color: var(--muted); overflow-wrap: anywhere; }
.approval-host code { font: inherit; font-family: ui-monospace, monospace; color: var(--accent); }
.approval-status { margin: 0 0 1rem; font-size: .92rem; color: #c5d0e0; }
.approval-status.error { color: var(--danger); }
.approval-status.ok { color: var(--ok); }
.approval-code-block { display: flex; flex-direction: column; align-items: center; gap: .55rem; margin: 1.15rem 0 1.25rem;
  padding: 1.1rem 1rem; border-radius: 14px; background: rgba(0, 0, 0, .18); border: 1px solid rgba(75, 107, 147, .45); }
.approval-code-label { margin: 0; font-size: .78rem; color: var(--muted); }
.approval-code { display: flex; justify-content: center; flex-wrap: wrap; gap: .4rem; font: 650 1.65rem/1.2 ui-monospace, monospace;
  letter-spacing: .16em; color: var(--fg); }
.approval-code span { padding: .35rem .45rem .35rem .55rem; border: 1px solid var(--chip-line); border-radius: 10px; background: var(--chip); }
.approval-details { margin: 0; display: grid; grid-template-columns: auto 1fr; gap: .45rem .85rem; font-size: .88rem; }
.approval-details dt { margin: 0; color: var(--muted); }
.approval-details dd { margin: 0; color: var(--fg); overflow-wrap: anywhere; }
.approval-confirm { display: flex; gap: .65rem; align-items: flex-start; margin: 1.15rem 0 0; padding: .7rem .8rem;
  border-radius: 12px; background: rgba(253, 214, 99, .07); border: 1px solid rgba(253, 214, 99, .28); }
.approval-confirm input { flex: none; width: 1.1rem; height: 1.1rem; margin: .15rem 0 0; accent-color: var(--accent); }
.approval-confirm label { flex: 1; font-size: .88rem; line-height: 1.4; color: #e8dcb5; cursor: pointer; }
.approval-actions { display: flex; flex-wrap: wrap; gap: .55rem; margin-top: 1rem; }
.approval-actions button { all: revert; box-sizing: border-box; flex: 1 1 8rem; min-height: 2.6rem; padding: .65rem 1rem;
  border-radius: 10px; font: inherit; font-size: .95rem; font-weight: 600; cursor: pointer; transition: background .15s, border-color .15s, opacity .15s; }
.approval-actions button:disabled { opacity: .55; cursor: not-allowed; }
.approval-actions button:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }
.approval-actions .remote-approve { color: var(--accent-ink); background: var(--accent); border: 1px solid var(--accent); }
.approval-actions .remote-approve:hover:not(:disabled) { background: #aecbfa; border-color: #aecbfa; }
.approval-actions .remote-deny { color: var(--fg); background: transparent; border: 1px solid #5f6368; }
.approval-actions .remote-deny:hover:not(:disabled) { background: #2b3d53; border-color: var(--accent); }
.approval-note { display: flex; gap: .55rem; align-items: flex-start; margin: 1rem 0 0; font-size: .8rem; line-height: 1.4; color: var(--muted); }
.approval-note svg { flex: none; margin-top: .05rem; color: var(--accent); }
@media (prefers-reduced-motion: reduce) { .approval-actions button { transition: none; } }
`;

const main = document.querySelector("#approval");
const params = new URLSearchParams(location.hash.slice(1));
const id = params.get("id"), proof = params.get("proof"), secret = params.get("secret");
// Binding material stays out of HTTP requests, referrers, and browser history.
history.replaceState(null, "", location.pathname);

document.head.append(el("style", { textContent: STYLE }));
const icon = el("span", { className: "approval-icon", ariaHidden: "true" });
icon.innerHTML = iconSVG("devices");
const status = el("p", { className: "approval-status", role: "status", textContent: "Log in on this trusted device to review the request." });
const shell = el("section", { className: "approval-shell", ariaLabel: "Approve a TabTop login" },
    el("div", { className: "approval-head" }, icon, el("div", {},
        el("h1", { textContent: "Approve a TabTop login" }),
        el("p", { className: "approval-host" }, "Approving through ", el("code", { textContent: location.host })))),
    status);
main.replaceChildren(shell);

const request = async (session, type) => {
    const t = await Tunnel.open({ type, remote_id: id, remote_proof: proof, ...(type === "remote-auth-info" ? {} : { remote_secret: secret }) }, session);
    try { return t.reply; } finally { t.close(); }
};
const showError = (err) => {
    status.textContent = err.message;
    status.classList.add("error");
    status.classList.remove("ok");
};

void (async () => {
    try {
        if (![id, proof, secret].every((v) => typeof v === "string" && /^[A-Za-z0-9_-]{43}$/.test(v))) {
            throw new Error("This approval link is incomplete. Scan the QR code or copy the full link again on the requesting device.");
        }
        // Deliberately ignore remembered sessions: authorization requires a
        // fresh password/TOTP or passkey login after the request was made.
        const session = await loginForm("Log in to approve another device", false, { remote: false });
        const info = await request(session, "remote-auth-info");
        status.textContent = "Confirm this code matches the requesting device. Only approve a request you started yourself.";
        status.classList.remove("error", "ok");

        const code = el("strong", { className: "approval-code", ariaLabel: `Code ${info.code}` },
            ...String(info.code).split("-").map((part) => el("span", { textContent: part })));
        const codeBlock = el("div", { className: "approval-code-block" },
            el("p", { className: "approval-code-label", textContent: "Confirmation code" }), code);

        const details = el("dl", { className: "approval-details" });
        for (const [name, value] of [
            ["Requesting IP", info.ip],
            ["Reported browser", info.browser || "Unknown"],
            ["Request expires", new Date(info.expires).toLocaleString()],
            ["Session lifetime", `Up to ${info.session_minutes} minutes`],
        ]) {
            details.append(el("dt", { textContent: name }), el("dd", { textContent: value }));
        }

        const confirm = el("input", { type: "checkbox", id: "confirm-device" });
        const confirmLabel = el("label", { htmlFor: "confirm-device" },
            "I started this request, have the device with me, and the codes match.");
        const approve = el("button", { type: "button", className: "remote-approve", textContent: "Approve login", disabled: true });
        const deny = el("button", { type: "button", className: "remote-deny", textContent: "Deny" });
        confirm.addEventListener("change", () => { approve.disabled = !confirm.checked; });

        const shield = el("span", { ariaHidden: "true" });
        shield.innerHTML = iconSVG("security");
        const note = el("p", { className: "approval-note" }, shield,
            el("span", { textContent: "Approving starts a session on the other device. You can end it later from Sessions." }));

        const act = async (allowed) => {
            approve.disabled = deny.disabled = confirm.disabled = true;
            try {
                await request(session, allowed ? "remote-auth-approve" : "remote-auth-deny");
                status.textContent = allowed
                    ? "Login approved. Return to the requesting device. You can revoke its session from Sessions."
                    : "Login denied.";
                status.classList.toggle("ok", allowed);
                status.classList.remove("error");
                confirm.checked = false;
                review.remove();
            } catch (err) {
                showError(err);
                deny.disabled = confirm.disabled = false;
                approve.disabled = !confirm.checked;
            }
        };
        approve.addEventListener("click", () => act(true));
        deny.addEventListener("click", () => act(false));

        const review = el("div", { className: "approval-review" },
            codeBlock, details,
            el("div", { className: "approval-confirm" }, confirm, confirmLabel),
            el("div", { className: "approval-actions" }, approve, deny),
            note);
        shell.append(review);
    } catch (err) {
        showError(err);
    }
})();
