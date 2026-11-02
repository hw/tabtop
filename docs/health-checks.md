# Health checks

`/healthz` (under `WEB_BASE_PATH`, like every path) answers `200 ok` while
the desktop's VNC server is there and the login file can be read, and
`503` otherwise. It needs no login and reveals nothing else, so load
balancers and uptime monitors can call it. The image's Docker
`HEALTHCHECK` uses it, so `docker ps` shows `unhealthy` when it fails, and
the reason is in the log. It never connects to the VNC server: servers
such as TigerVNC count a connection closed without logging in, even one
closed at once, as an abandoned login, and enough of them get the
gateway's address blacklisted, refusing the desktop too. The container's
own Xvnc, and a socket given as `VNC_ADDR`, are checked without
connecting; a server reached over TCP isn't checked, so `/healthz` then
says the gateway itself can serve. The doctor report shows how the
gateway's last login to that server went.

`/doctor` is for troubleshooting and is off unless
`WEB_DOCTOR_ENDPOINT=1`. It returns a JSON report:

Socket status and audio probe results are shared for ten seconds, including
failures, with only one probe batch running at a time. Clock, proxy, session
state and the last VNC login result are evaluated for each request.

- **checks:** each part's state: Xvnc, or the VNC server at `VNC_ADDR`
  (whether it's listening, checked as `/healthz` does; when the gateway
  logs in to it,
  with `VNC_UPSTREAM_PASSWORD` or `VNC_X509=1`, how its last login went,
  and whether it's waiting after a failed one), the login file, noVNC,
  `~/Downloads`, audio (the PipeWire sink), the terminal (tmux and
  ghostty-web) and the tunnel (whether the JavaScript libraries it needs
  are in place). The report connects to the VNC server no further than
  `/healthz` does, and shares its result: a connection that read the
  server's greeting or chose a login, then stopped, counts as an abandoned
  login on servers such as TigerVNC, and enough of them get the gateway's
  address blacklisted, refusing the desktop too.
- **clock:** the server's time. Codes are only accepted within 30 seconds
  of it, so a wrong clock explains logins that always fail.
- **proxy:** how your request arrived, for setting up a reverse proxy. It
  shows the address the connection came from and whether it's trusted, the
  `Host`, `X-Forwarded-For` and `X-Forwarded-Proto` headers as received
  (even from an untrusted address, where they're otherwise ignored), the
  `WEB_TRUSTED_PROXIES` list and `WEB_TRUST_NPROXIES` count, each address
  checked to find the client IP (and whether it was trusted by address or by
  count), and whether the request came over HTTPS. A **diagnosis** explains
  the result in words and what to change, such as the `WEB_TRUSTED_PROXIES`
  value that would trust the connection's address.
- **state:** counts of web sessions, open terminals, locked-out addresses
  (IPv4 addresses and IPv6 /64s) and audio listeners, and whether logins
  are being slowed down after many failed ones.

It needs no login, so it works when logins don't. It leaves out the
password and TOTP key, and redacts what would name the account or the VNC
server: the home folder shows as `~`, the runtime folder as
`$XDG_RUNTIME_DIR`, and the VNC server's address as `VNC_ADDR`. It still
shows how requests reach it through proxies, and activity, so turn it off
again when you're done.
