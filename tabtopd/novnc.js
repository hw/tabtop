// Hooks noVNC up to the encrypted tunnel, served by tabtopd (see e2e.go).
// The image's noVNC asks window.tabtopChannel for a channel to use instead
// of its WebSocket URL: a TunnelSocket carrying RFB. The tunnel's login is
// the desktop's: it shows the login form when there's no session, and
// Xvnc, which only the gateway can reach, asks for nothing more.

import { TunnelSocket } from "./tunnel.js";

window.tabtopChannel = () => new TunnelSocket({ type: "vnc" }, { title: "Desktop" });
