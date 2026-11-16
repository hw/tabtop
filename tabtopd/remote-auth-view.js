import { el } from "./preview-dom.js";
import { iconSVG } from "./glyphs.js";
import { qrcodegen } from "./third-party/qrcodegen.js";

// How long a request waits for its approval (remote_auth.go's remoteWait):
// counted from when it's shown, not by the server's clock, which may differ.
const WAIT = 120;

// The panel's look: as the login form's (always dark; see login-ui.js).
const STYLE = `
#tabtop_login .remote-auth-request { box-sizing: border-box; max-width: 34rem; margin: 1rem 0; padding: 1.1rem 1.2rem 1rem; border: 1px solid #3d5a80; border-radius: 14px;
    background: linear-gradient(180deg, #24324a 0%, #1f2836 100%); box-shadow: 0 10px 30px rgba(0, 0, 0, .35); overflow-wrap: anywhere; }
#tabtop_login .remote-auth-head { display: flex; align-items: center; gap: .8rem; }
#tabtop_login .remote-auth-icon { display: inline-flex; align-items: center; justify-content: center; flex: none; width: 2.6rem; height: 2.6rem; border-radius: 11px; background: #344c6a; color: #aecbfa; }
#tabtop_login .remote-auth-icon svg { display: block; }
#tabtop_login .remote-auth-head h2 { margin: 0; font-size: 1.1rem; font-weight: 600; color: #e8f0fe; }
#tabtop_login .remote-auth-head p { margin: .1rem 0 0; font-size: .85rem; color: #bdc9da; }
#tabtop_login .remote-auth-head .remote-auth-cancel { margin-left: auto; }
#tabtop_login .remote-auth-body { display: flex; flex-direction: column; align-items: center; gap: 1.2rem; margin: 1.1rem 0 .9rem; }
#tabtop_login .remote-auth-qr { flex: none; width: 11rem; padding: .6rem; border-radius: 12px; background: #fff; box-shadow: 0 0 0 4px rgba(174, 203, 250, .18); }
#tabtop_login .remote-auth-qr svg { display: block; width: 100%; height: auto; }
#tabtop_login .remote-auth-steps { width: 100%; margin: 0; padding: 0; list-style: none; counter-reset: step; }
#tabtop_login .remote-auth-steps li { position: relative; margin: 0 0 .7rem; padding-left: 2rem; font-size: .9rem; line-height: 1.4; color: #d7dde7; counter-increment: step; }
#tabtop_login .remote-auth-steps li::before { content: counter(step); position: absolute; left: 0; top: -.05rem; width: 1.4rem; height: 1.4rem; border-radius: 50%;
    background: #344c6a; color: #aecbfa; font-size: .75rem; font-weight: 600; line-height: 1.4rem; text-align: center; }
#tabtop_login .remote-auth-steps strong { color: #e8f0fe; font-weight: 600; }
#tabtop_login .remote-auth-address { font: .85rem ui-monospace, monospace; color: #aecbfa; }
#tabtop_login .remote-auth-code { display: flex; justify-content: center; gap: .35rem; margin: .55rem 0 0; font: 600 1.35rem ui-monospace, monospace; letter-spacing: .14em; color: #e8f0fe; }
#tabtop_login .remote-auth-code span { padding: .15rem .35rem .15rem .5rem; border: 1px solid #4b6b93; border-radius: 8px; background: #1b2532; }
#tabtop_login .remote-auth-timer { display: flex; align-items: center; gap: .7rem; font-size: .82rem; color: #bdc9da; font-variant-numeric: tabular-nums; }
#tabtop_login .remote-auth-bar { flex: 1; height: 5px; border-radius: 3px; background: #2f3c4f; overflow: hidden; }
#tabtop_login .remote-auth-bar span { display: block; height: 100%; border-radius: 3px; background: #8ab4f8; transition: width 1s linear; }
#tabtop_login .remote-auth-timer.ending .remote-auth-bar span { background: #fdd663; }
#tabtop_login .remote-auth-link { margin: .9rem 0 0; font-size: .85rem; color: #bdc9da; }
#tabtop_login .remote-auth-link summary { cursor: pointer; color: #aecbfa; }
#tabtop_login .remote-auth-link summary:focus-visible { outline: 2px solid #aecbfa; outline-offset: 2px; border-radius: 3px; }
#tabtop_login .remote-auth-copy-row { display: flex; gap: .4rem; margin-top: .5rem; }
#tabtop_login .remote-auth-copy-row input { all: revert; box-sizing: border-box; flex: 1; min-width: 0; padding: .45rem .6rem; border: 1px solid #4b5563; border-radius: 8px;
    font: .8rem ui-monospace, monospace; color: #e8e8ea; background: #161b22; }
#tabtop_login .remote-auth-request button { all: revert; box-sizing: border-box; padding: .45rem .8rem; border: 1px solid #5f6368; border-radius: 8px; font: inherit; font-size: .85rem;
    color: #e8e8ea; background: transparent; cursor: pointer; white-space: nowrap; transition: background .15s, border-color .15s; }
#tabtop_login .remote-auth-request button:hover { background: #2b3d53; border-color: #aecbfa; }
#tabtop_login .remote-auth-request button:focus-visible { outline: 3px solid #aecbfa; outline-offset: 2px; }
#tabtop_login .remote-auth-request .remote-auth-copy { color: #1c1c1e; background: #8ab4f8; border-color: #8ab4f8; }
#tabtop_login .remote-auth-request .remote-auth-copy:hover { background: #aecbfa; }
#tabtop_login .remote-auth-said { min-height: 1.2em; margin: .5rem 0 0; font-size: .82rem; color: #81c995; }
#tabtop_login .remote-auth-warning { display: flex; gap: .55rem; align-items: flex-start; margin: .9rem 0 0; padding: .6rem .75rem; border-radius: 10px;
    background: rgba(253, 214, 99, .08); border: 1px solid rgba(253, 214, 99, .28); font-size: .8rem; line-height: 1.4; color: #e8dcb5; }
#tabtop_login .remote-auth-warning svg { flex: none; margin-top: .05rem; color: #fdd663; }
#tabtop_login .remote-auth-elsewhere { margin: 0 0 .9rem; padding: .6rem .75rem; border-radius: 10px; background: rgba(242, 139, 130, .1); border: 1px solid rgba(242, 139, 130, .45);
    font-size: .85rem; line-height: 1.4; color: #f6c7c3; }
#tabtop_login .remote-auth-elsewhere strong { color: #f28b82; }
@media (prefers-reduced-motion: reduce) { #tabtop_login .remote-auth-bar span, #tabtop_login .remote-auth-request button { transition: none; } }
`;

// remoteRequestView is the panel shown while a login waits for approval on
// another device: its QR code (made here, from the local handshake: never
// fetched, where a TLS interceptor could replace what it binds), the
// address it opens, the code to match there, how long it has, the link to
// copy, and Cancel (cancel). It's {node, stop()}.
export function remoteRequestView(details, cancel) {
    const qr = qrcodegen.QrCode.encodeText(details.url, qrcodegen.QrCode.Ecc.MEDIUM);
    const ns = "http://www.w3.org/2000/svg", svg = document.createElementNS(ns, "svg");
    const size = qr.size + 2;
    svg.setAttribute("viewBox", `0 0 ${size} ${size}`);
    svg.setAttribute("shape-rendering", "crispEdges");
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", "QR code: scan it on your trusted device to approve this login");
    let path = "";
    for (let y = 0; y < qr.size; y++) for (let x = 0; x < qr.size; x++) if (qr.getModule(x, y)) path += `M${x + 1},${y + 1}h1v1h-1z`;
    const ink = document.createElementNS(ns, "path");
    ink.setAttribute("d", path);
    ink.setAttribute("fill", "#111");
    svg.append(ink);

    const address = new URL(details.url);
    // A link to another page than the approval page where this page reaches
    // the server (its address, or its path): only as expected where the
    // server's set up with an approval page of its own (-remote-approval-url);
    // else, perhaps, a proxy's doing.
    const goesTo = `${address.origin}${address.pathname}`;
    const elsewhere = details.expectedApproval && goesTo !== details.expectedApproval
        ? el("p", { className: "remote-auth-elsewhere", role: "alert" }, el("strong", { textContent: "Check the address. " }),
            `This link goes to ${goesTo}, not ${details.expectedApproval}, the approval page where this page reaches the server. That's expected only if the server is set up with a separate approval page; otherwise, don't use it.`)
        : null;
    // The code, in its groups, as they're to be compared.
    const code = el("strong", { className: "remote-auth-code", ariaLabel: `Code ${details.code}` },
        ...details.code.split("-").map((part) => el("span", { textContent: part })));
    const icon = el("span", { className: "remote-auth-icon" });
    icon.innerHTML = iconSVG("devices");
    icon.setAttribute("aria-hidden", "true");
    const status = el("p", { textContent: "Waiting for approval…" });
    const stop = el("button", { type: "button", className: "remote-auth-cancel", textContent: "Cancel" });
    stop.addEventListener("click", cancel);

    const bar = el("span");
    const left = el("span", { role: "status" });
    const timer = el("div", { className: "remote-auth-timer" }, el("div", { className: "remote-auth-bar", ariaHidden: "true" }, bar), left);
    const began = performance.now();
    const update = () => {
        const s = Math.max(0, WAIT - Math.floor((performance.now() - began) / 1000));
        bar.style.width = `${(s / WAIT) * 100}%`;
        timer.classList.toggle("ending", s <= 20);
        left.textContent = s ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")} left` : "Expired: start a new request";
        if (!s) status.textContent = "This request has expired.";
    };
    update();
    const ticking = setInterval(update, 1000);

    // Can't scan: the link, to copy.
    const link = el("input", { type: "text", value: details.url, readOnly: true, ariaLabel: "Approval link" });
    link.addEventListener("focus", () => link.select());
    const said = el("p", { className: "remote-auth-said", role: "status" });
    const copy = el("button", { type: "button", className: "remote-auth-copy", textContent: "Copy link" });
    copy.addEventListener("click", async () => {
        try {
            await navigator.clipboard.writeText(details.url);
            said.textContent = "Copied. Open it on your trusted device.";
        } catch {
            link.focus();
            link.select();
            said.textContent = "Copy the selected link, and open it on your trusted device.";
        }
    });
    const shield = el("span", { ariaHidden: "true" });
    shield.innerHTML = iconSVG("security");

    const node = el("section", { className: "remote-auth-request", ariaLabel: "Approve this login on another device" },
        el("style", { textContent: STYLE }),
        el("div", { className: "remote-auth-head" }, icon, el("div", {}, el("h2", { textContent: "Approve on another device" }), status), stop),
        ...(elsewhere ? [elsewhere] : []),
        el("div", { className: "remote-auth-body" },
            el("div", { className: "remote-auth-qr" }, svg),
            el("ol", { className: "remote-auth-steps" },
                el("li", {}, el("strong", { textContent: "Scan" }), " this code with a phone or computer you're logged in on."),
                el("li", {}, el("strong", { textContent: "Check" }), " that it opens ", el("span", { className: "remote-auth-address", textContent: `${address.origin}${address.pathname}` }), "."),
                el("li", {}, el("strong", { textContent: "Confirm" }), " this code there:", el("br"), code))),
        timer,
        el("details", { className: "remote-auth-link" }, el("summary", { textContent: "Can't scan? Copy the link instead" }),
            el("div", { className: "remote-auth-copy-row" }, link, copy), said),
        el("p", { className: "remote-auth-warning" }, shield,
            el("span", { textContent: "This link is for one login, for two minutes. Keep it private, and only approve a login you started yourself, on a device you have with you." })));
    return {
        node,
        stop() {
            clearInterval(ticking);
            link.value = "";
            node.remove();
        },
    };
}
