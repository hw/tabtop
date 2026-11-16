import { el } from "./preview-dom.js";
import { qrcodegen } from "./third-party/qrcodegen.js";

// The QR is generated from the local handshake; never fetch a QR image from
// the network, where a TLS interceptor could replace its binding data.
export function remoteRequestView(details, cancel) {
    const qr = qrcodegen.QrCode.encodeText(details.url, qrcodegen.QrCode.Ecc.MEDIUM);
    const ns = "http://www.w3.org/2000/svg", svg = document.createElementNS(ns, "svg");
    const size = qr.size + 8;
    svg.setAttribute("viewBox", `0 0 ${size} ${size}`);
    svg.setAttribute("role", "img"); svg.setAttribute("aria-label", "Scan on your trusted device to approve this login");
    Object.assign(svg.style, { width: "min(100%, 18rem)", height: "auto", display: "block", background: "white", borderRadius: ".5rem", margin: "1rem 0" });
    let path = "";
    for (let y = 0; y < qr.size; y++) for (let x = 0; x < qr.size; x++) if (qr.getModule(x, y)) path += `M${x+4},${y+4}h1v1h-1z`;
    const ink = document.createElementNS(ns, "path"); ink.setAttribute("d", path); ink.setAttribute("fill", "#111"); svg.append(ink);
    const code = el("strong", { className: "remote-auth-code", textContent: details.code });
    Object.assign(code.style, { display: "block", font: "600 1.5rem ui-monospace, monospace", letterSpacing: ".12em" });
    const address = new URL(details.url);
    const link = el("input", { type: "text", value: details.url, readOnly: true, ariaLabel: "Approval link" });
    Object.assign(link.style, { boxSizing: "border-box", width: "100%", font: "inherit", padding: ".5rem", marginTop: ".75rem" });
    link.addEventListener("focus", () => link.select());
    const status = el("p", { role: "status" });
    const copy = el("button", { type: "button", textContent: "Copy approval link" });
    const stop = el("button", { type: "button", className: "remote-auth-cancel", textContent: "Cancel request" });
    for (const button of [copy, stop]) Object.assign(button.style, { all: "revert", font: "inherit", cursor: "pointer", padding: ".5rem .75rem", borderRadius: "6px", border: "1px solid #6385b3", color: "#e8e8ea", background: "#222e3d" });
    copy.addEventListener("click", async () => {
        try { await navigator.clipboard.writeText(details.url); status.textContent = "Approval link copied. Open it on your trusted device."; }
        catch { link.focus(); link.select(); status.textContent = "Copy the selected link and open it on your trusted device."; }
    });
    stop.addEventListener("click", cancel);
    const began = performance.now();
    const countdown = el("p", { role: "status" });
    const update = () => { const left = Math.max(0, 120 - Math.floor((performance.now()-began)/1000)); countdown.textContent = left ? `Waiting for approval · ${left}s remaining` : "This request is expiring. Start a new request if needed."; };
    update(); const timer = setInterval(update, 1000);
    const node = el("section", { className: "remote-auth-request", ariaLabel: "Approve this login on another device" },
        el("h2", { textContent: "Approve on other device" }),
        el("p", { textContent: "Scan this QR code with your trusted phone or computer. Check the approval address, log in there, and confirm the matching code." }),
        el("p", { textContent: `Approval address: ${address.origin}${address.pathname}` }), svg, code, countdown,
        link, el("div", {}, copy, " ", stop), status,
        el("p", { textContent: "Keep this one-time link private. Only approve a login you started on a device in your possession." }));
    Object.assign(node.style, { maxWidth: "32rem", padding: "1rem", margin: "1rem 0", border: "1px solid #6385b3", borderRadius: "12px", overflowWrap: "anywhere" });
    return { node, stop() { clearInterval(timer); link.value = ""; node.remove(); } };
}
