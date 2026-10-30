// Hooks noVNC up to the encrypted tunnel, served by tabtopd (see e2e.go).
// The image's noVNC asks window.tabtopChannel for a channel to use instead
// of its WebSocket URL; with WEB_E2E=1, that's a TunnelSocket carrying RFB.
// The tunnel's login is the desktop's: it shows the login form when
// there's no session, and Xvnc, which only the gateway can reach then,
// asks for nothing more.

import * as e2e from "./e2e.js";

if (e2e.enabled) {
    window.tabtopChannel = () => new e2e.TunnelSocket({ type: "vnc" }, { title: "Desktop" });
}
