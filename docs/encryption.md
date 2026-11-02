# Encryption and security

Everything private goes through an encrypted tunnel between the page's
JavaScript and the gateway: the login, the desktop (screen, keyboard and
clipboard), terminal sessions, file listings, downloads and uploads, and
sound. It's meant for the case where HTTPS alone isn't enough: a proxy that
decrypts HTTPS on the way, such as a corporate TLS-inspection proxy, a CDN
like Cloudflare, or a platform's load balancer that logs traffic. Such a
proxy would otherwise see TOTP codes and passwords, the screen and
keystrokes, terminal sessions, files and anything it could replay.

- **One login:** the desktop, terminal and files page share one login form,
  shown by whichever you open first, and one [session](#sessions). Logging
  out, or the session ending, closes the desktop, the terminal and any
  download at once.
- **The login never crosses the wire:** the password and TOTP code are used
  in [CPace](https://datatracker.ietf.org/doc/draft-irtf-cfrg-cpace/), a
  password-authenticated key exchange on X25519. Both sides prove they know
  the same code without sending it, so a recording of the login doesn't help
  anyone guess it later, even with TOTP-only logins. The gateway tries the
  codes for the previous, current and next 30 seconds. Codes are
  single-use, and failed logins count against the
  [login limit](environment.md#web_trusted_proxies).
- **Sessions:** a successful login gives the page a random session secret,
  kept in the browser's local storage. Every later connection combines a
  fresh X25519 exchange with that secret, so only that browser can open
  connections for the session. The fresh keys mean a secret that leaks later
  doesn't decrypt connections recorded earlier. There are no cookies, and
  nothing on the wire can be replayed.
- **Encryption:** every message is encrypted with ChaCha20-Poly1305. A
  message that's changed, dropped, reordered or replayed ends the
  connection. Browsers don't have ChaCha20-Poly1305 built in, so the page
  uses [@noble/ciphers](https://github.com/paulmillr/noble-ciphers), an
  audited JavaScript library, served from the image (`/opt/noble`). In
  Chromium it decrypts well over 100 MB/s, far more than the desktop needs.
  The handshakes' X25519, SHA-2 and HKDF come from the browser's own
  WebCrypto where it offers them, which is over HTTPS or on `localhost` in
  Chrome 133, Firefox 130, Safari 17 or later. Elsewhere the page loads
  [@noble/curves](https://github.com/paulmillr/noble-curves) and
  [@noble/hashes](https://github.com/paulmillr/noble-hashes) for them
  instead, which adds a few milliseconds to each login and connection.
  Browsers keep the noble files and the terminal's ghostty-web cached,
  under a path that changes when the image's copies do. The gateway sends
  them gzipped, since `no-transform` (below) stops proxies from
  compressing them.
- **Unchanged in transit:** every page and script carries `Cache-Control:
  no-transform`, which tells proxies and CDNs not to rewrite it. Turn off
  any feature that rewrites scripts for this site, such as Cloudflare's
  Rocket Loader.
- **Requirements:** any current browser with JavaScript. Over plain HTTP
  (other than to `localhost`) everything works except sound, copying from
  the terminal to your clipboard and the desktop's clipboard sharing, and
  large downloads are held in memory before they're saved; see
  [Downloads](downloads.md), [Terminal](terminal.md) and [Audio](full-image.md#audio).

This protects against a proxy that **reads** traffic. A proxy that
**changes** traffic but leaves the page's scripts alone gets one guess at the
code per login attempt, which the login limit counts. One that replaces the
scripts can do anything, such as send your keystrokes elsewhere: the
JavaScript comes through the same proxy. What a proxy can still see is which
pages and scripts you load, when you connect, and how much data flows,
including the timing of terminal keystrokes.

The desktop's own Chromium isn't affected: it browses from the container,
not through your browser.

## Sessions

The desktop, terminal and files page share a login within one deployment.
Deployments under different base paths keep separate browser sessions.
Upgrading from a version that shared session storage across base paths asks
for one fresh login; the old stored session cannot be assigned safely.

How long a login lasts, and how to notice and end one you didn't make:

Logging out clears the saved browser session immediately. The page waits
at most three seconds for server revocation before reloading. If the server
cannot be reached, its session may remain active until it expires or is
ended separately.

- **Limits:** a login lasts 12 hours at most (`WEB_SESSION_MAX`), and ends
  after an hour with nothing open (`WEB_SESSION_IDLE`). Anything still open
  then closes at once. The idle limit only ends sessions nobody is using:
  one that someone keeps a desktop or terminal open on, or a files page in
  view, lasts until the maximum. A login can have 64 connections open at
  once (a desktop tab uses three, a terminal, a files page in view or a
  download one); more are refused until some close. At most 16 connections from one address, and 256 in all, can be
  waiting to log in or prove their session; more are refused. A
  connection whose browser stops taking data for a minute is closed.
- **Before the end:** ten minutes before a login reaches its maximum, each
  open page shows a banner saying when, with **Log in again**, so it
  doesn't stop you in the middle of something. Logging in again ends the
  old login at once: the desktop, terminal and files pages open in other
  tabs reconnect with the new one by themselves, and the warning goes from
  them too. **Later** puts the warning off until a minute before.
- **After each login,** the page shows the previous login's time and IP
  address, and any failed attempts since. It stays on screen until
  dismissed when there were failed attempts or the previous login came from
  another address.
- **The files page** lists the live sessions under **Security and
  sessions**, a shield by Log out that shows them in place of the folder
  (and goes back to it when pressed again). It turns red, with a red dot,
  for something new: a failed login since you logged in (those before
  are in the summary shown after logging in), or a session used from
  another address. **Mark as seen** clears it until something else
  happens; the gateway keeps that, in memory, for every session. It shows
  when each logged in, with
  which browser (such as `Chrome on macOS`, as the browser describes
  itself, so it tells logins apart but proves nothing), the
  address it logged in from, any other address it has been used from
  (marked in red), and how many connections it has open, not counting the
  page's own request. A page closed or left closes its connections. Below
  are the last 20 logins, failed ones included, with their browsers. **End…** on another
  session's row ends just that one, after asking, and closes everything it
  has open; the page never sees other sessions' ids, only a name for each
  derived from it. **Log out everywhere** ends every session, this one
  too, and closes everything they have open: an open desktop or terminal
  asks for a login when it reconnects, which it does by itself.
- **The gateway's log** (`docker logs`) records each login and each time a
  session is used from an address it didn't log in from.

A proxy that rewrites the page sits on your network path, so a session it
reuses most likely comes from your address and isn't marked: only
connections you didn't open give it away. All of this is drawn by the page,
which such a proxy could change too. Check from a network you trust, or
read `docker logs`. If you suspect a session was taken, log out everywhere
from a trusted network and change `VNC_PASSWORD`: a changed page could have
read the password, but never the TOTP secret. Sessions and the login
history are kept in memory only, so restarting the container logs everyone
out and starts the history empty.

## Security notes

- **HTTPS:** put the site behind HTTPS whenever it's reachable beyond a
  trusted network, and set `WEB_TRUSTED_PROXIES`. The encrypted tunnel
  keeps logins and content from anyone who only reads traffic, including
  a proxy that decrypts HTTPS, but whoever can change traffic can replace
  the page's scripts and take everything.
  HTTPS stops that for everyone on the way except the proxies that decrypt
  it.
- **Login limit:** failed logins are limited per visitor address, as
  described under `WEB_TRUSTED_PROXIES`: an IPv4 address, or an IPv6
  address's /64, since one subscriber usually has a whole /64. Guesses
  spread over many addresses are limited too: once 30 logins have failed
  within 5 minutes, from all addresses together, logins are checked at
  most one every 5 seconds until the failures thin out, and the log says
  so. That makes guessing a code-only login (one chance in about 333,000
  per guess with 6 digits) take weeks rather than hours, but it's still a
  matter of time: set `VNC_PASSWORD` for a site the internet can reach.
  While logins are slowed down, yours may be turned away with "try again
  in a few seconds" more than once. The gateway also checks at most 4
  logins at once, and turns away any more with "The server is busy".
  Connections that haven't logged in yet are limited per address (16) and
  in all (256), and each message before the login must arrive within 10
  seconds. A flood of logins from many addresses can keep refusing logins
  for as long as it lasts, but locks nothing afterwards. Xvnc's own
  blacklist is turned off, because every connection reaches Xvnc from the
  gateway.
- **Desktop access:** anyone logged in to the desktop has full access as
  `VNC_USER`, including the TOTP secret and (when configured) the plaintext
  password PIN in `~/.config/tabtop/`.
- **Terminal:** the terminal is a full shell as `VNC_USER`, the same access
  the desktop already gives. Set `WEB_TTY=0` if you don't want it. Only
  pages from the site itself can open the tunnel; the gateway refuses
  WebSocket requests from other sites.
- **Files:** anyone logged in can delete files and folders in
  `~/Downloads`, with no way to undo it.
