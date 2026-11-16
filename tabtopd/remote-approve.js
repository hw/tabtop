import { loginForm } from "./login-ui.js";
import { Tunnel } from "./tunnel-protocol.js";
import { el } from "./preview-dom.js";

const main = document.querySelector("#approval");
const params = new URLSearchParams(location.hash.slice(1));
const id = params.get("id"), proof = params.get("proof"), secret = params.get("secret");
// Binding material stays out of HTTP requests, referrers, and browser history.
history.replaceState(null, "", location.pathname);
main.append(el("h1", { textContent: "Approve a TabTop login" }), el("p", { textContent: `Approving through ${location.host}` }));
const status = el("p", { role: "status", textContent: "Log in on this trusted device to review the request." });
main.append(status);
const request = async (session, type) => {
    const t = await Tunnel.open({ type, remote_id: id, remote_proof: proof, ...(type === "remote-auth-info" ? {} : { remote_secret: secret }) }, session);
    try { return t.reply; } finally { t.close(); }
};
const showError = err => { status.textContent = err.message; status.style.color = "#f28b82"; };
void (async () => {
    try {
        if (![id, proof, secret].every(v => typeof v === "string" && /^[A-Za-z0-9_-]{43}$/.test(v))) throw new Error("This approval link is incomplete. Scan the QR code or copy the full link again on the requesting device.");
        // Deliberately ignore remembered sessions: authorization requires a
        // fresh password/TOTP or passkey login after the request was made.
        const session = await loginForm("Log in to approve another device", false, { remote: false });
        const info = await request(session, "remote-auth-info");
        status.textContent = "Confirm this code matches the requesting device. Only approve a request you started yourself.";
        const code = el("strong", { className: "approval-code", textContent: info.code });
        Object.assign(code.style, { display: "block", font: "600 2rem ui-monospace, monospace", letterSpacing: ".12em", margin: "1rem 0" });
        const details = el("dl");
        for (const [name, value] of [["Requesting IP", info.ip], ["Reported browser", info.browser || "Unknown"], ["Request expires", new Date(info.expires).toLocaleString()], ["Session lifetime", `Up to ${info.session_minutes} minutes`]]) details.append(el("dt", { textContent: name }), el("dd", { textContent: value }));
        const confirm = el("input", { type: "checkbox", id: "confirm-device" });
        const approve = el("button", { type: "button", className: "remote-approve", textContent: "Approve login", disabled: true });
        const deny = el("button", { type: "button", className: "remote-deny", textContent: "Deny" });
        for (const button of [approve, deny]) Object.assign(button.style, { font: "inherit", padding: ".65rem 1rem", borderRadius: ".5rem", marginTop: "1rem", cursor: "pointer" });
        confirm.addEventListener("change", () => { approve.disabled = !confirm.checked; });
        const act = async allowed => {
            approve.disabled = deny.disabled = confirm.disabled = true;
            try {
                await request(session, allowed ? "remote-auth-approve" : "remote-auth-deny");
                status.textContent = allowed ? "Login approved. Return to the requesting device. You can revoke its session from Sessions." : "Login denied.";
                confirm.checked = false; actions.remove(); code.remove();
            } catch (err) {
                showError(err); deny.disabled = confirm.disabled = false; approve.disabled = !confirm.checked;
            }
        };
        approve.addEventListener("click", () => act(true)); deny.addEventListener("click", () => act(false));
        const actions = el("div", {}, el("label", { htmlFor: "confirm-device" }, confirm, " I started this request, have the device with me, and the codes match."), el("br"), approve, " ", deny);
        main.append(code, details, actions);
    } catch (err) { showError(err); }
})();
