# Reverse proxy

Put TabTop behind a reverse proxy when it's reachable beyond a trusted
network: terminate HTTPS there, and proxy HTTP (including WebSockets) to
container port `6080`. The gateway itself speaks plain HTTP.

Failed logins are limited per visitor IP. Behind a proxy every visitor can
look like the proxy unless you set
[WEB_TRUSTED_PROXIES](environment.md#web_trusted_proxies) (or [WEB_TRUST_NPROXIES](environment.md#web_trust_nproxies)) 
so the gateway reads `X-Forwarded-For`. See also [Behind Cloudflare](environment.md#behind-cloudflare).

## What the proxy must do

- Pass the `Host` header through unchanged. Otherwise the gateway refuses
  the tunnel's WebSocket as cross-origin.
- Forward WebSocket upgrades (`Upgrade` / `Connection`).
- Allow long idle times, or idle desktop and terminal sessions get cut
  off. The gateway pings every WebSocket every 30 seconds, which is enough
  for idle limits of a minute or more (nginx's default `proxy_read_timeout`
  is 60 s).
- Send `X-Forwarded-For` and `X-Forwarded-Proto`. The gateway only believes
  them from a trusted proxy. Over HTTPS, the browser's tunnel works by any
  name. Over plain HTTP, only by an address or a name no website can point
  at the gateway, unless the name is listed in
  [`WEB_HOSTS`](environment.md#web_hosts).
- Leave responses unchanged. The gateway sends `Cache-Control: no-transform`
  with every page and script. Turn off any proxy or CDN feature that
  rewrites scripts for this site (such as Cloudflare's Rocket Loader): a
  changed script can break the tunnel.

Publish the container only on localhost or a private network when the
proxy is on the same host, for example `-p 127.0.0.1:6080:6080`, so
visitors can't bypass the proxy and spoof forwarded headers.

## nginx: site at the root

With the default `WEB_BASE_PATH=/`, serve TabTop at `https://example.com/`:

```sh
docker run -d --name tabtop -p 127.0.0.1:6080:6080 \
  -e VNC_TOTP_SECRET=... \
  -e WEB_TRUSTED_PROXIES=172.17.0.1 \
  ghcr.io/hw/tabtop:latest
```

Trust the address the container sees the proxy connect from, which isn't
always the one the proxy dials:

- **nginx on the host**, as here, reaching a port published only on
  `127.0.0.1`: the container sees the Docker network's gateway, not
  `127.0.0.1`. That's `172.17.0.1` on the default bridge; on a network
  of your own, its gateway (`docker network inspect`). Trusting it is
  safe only because the port is published on `127.0.0.1` alone: with a
  plain `-p 6080:6080`, every visitor arrives from that gateway too, and
  could then pick their own IP.
- **nginx in a container** on the same Docker network: that container's
  IP. Give it a fixed one, and trust only that, not the network's range.

`/doctor` (see [Health checks](health-checks.md)) shows the address a
request came from and whether it was trusted; see
[WEB_TRUSTED_PROXIES](environment.md#web_trusted_proxies).

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 443 ssl http2;
    server_name example.com;

    # ssl_certificate     /etc/ssl/certs/example.com.crt;
    # ssl_certificate_key /etc/ssl/private/example.com.key;

    location / {
        proxy_pass http://127.0.0.1:6080;
        proxy_http_version 1.1;
        proxy_set_header Host $http_host;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 1h;
        # Upload links: each link sets its own limit, and bodies go
        # straight through, so the page's progress is real.
        client_max_body_size 0;
        proxy_request_buffering off;
    }
}
```

`client_max_body_size 0` and `proxy_request_buffering off` are for
[upload links](downloads.md#upload-links), the one thing that sends big
request bodies over plain HTTP: the upload page sends 8 MB pieces, and
`curl -T` a whole file. nginx refuses bodies over 1 MB by default, and
otherwise holds each body on disk before passing it on, so the
uploader's progress runs ahead of what's saved. Leave them out if you
don't use upload links.

Open `https://example.com/`. Paths stay as in the README (`/fs/`,
`/tty/`, `/session` (the encrypted tunnel), `/healthz`, `/auth/approve`, `/auth/bootstrap`, `/auth/pack`).

## nginx: site under a path (`WEB_BASE_PATH`)

To put TabTop at `https://example.com/tabtop/` next to other sites, set
[WEB_BASE_PATH](environment.md#web_base_path) and proxy that prefix
**without stripping it**. With nginx, give `proxy_pass` no URI path after
the upstream address. `absolute_redirect off` keeps nginx's own redirect
from `/tabtop` to `/tabtop/` working when its listen port differs from the
one in the browser.

```sh
docker run -d --name tabtop -p 127.0.0.1:6080:6080 \
  -e VNC_TOTP_SECRET=... \
  -e WEB_BASE_PATH=/tabtop/ \
  -e WEB_TRUSTED_PROXIES=172.17.0.1 \
  ghcr.io/hw/tabtop:latest
```

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 443 ssl http2;
    server_name example.com;

    # ssl_certificate     /etc/ssl/certs/example.com.crt;
    # ssl_certificate_key /etc/ssl/private/example.com.key;

    location /tabtop/ {
        absolute_redirect off;
        proxy_pass http://127.0.0.1:6080;
        proxy_http_version 1.1;
        proxy_set_header Host $http_host;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 1h;
        # Upload links: each link sets its own limit, and bodies go
        # straight through, so the page's progress is real.
        client_max_body_size 0;
        proxy_request_buffering off;
    }
}
```

Open `https://example.com/tabtop/`. Paths move under the base
(`/tabtop/fs/`, `/tabtop/tty/`, and so on). Anything outside
`/tabtop/` is not found on the container, including `/`.

Browsers treat paths on the same host as one origin: any other page on
`example.com` can script TabTop and read its login session. Only put it
next to sites you trust. Details:
[WEB_BASE_PATH](environment.md#web_base_path).

## Checking the setup

With [WEB_DOCTOR_ENDPOINT](environment.md#web_doctor_endpoint) set to `1`,
[/doctor](health-checks.md) (under `WEB_BASE_PATH`) shows how the request
arrived: whether HTTPS was detected, which `X-Forwarded-For` hops were
trusted, and the visitor IP the login limit will use. Turn it off again
when you're done.
