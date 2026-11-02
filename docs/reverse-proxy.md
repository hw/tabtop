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
  them from a trusted proxy.
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
  -e WEB_TRUSTED_PROXIES=172.18.0.5 \
  ghcr.io/hw/tabtop:latest
```

Use the address the proxy uses to reach the container (a fixed Docker
network IP, or `127.0.0.1` when nginx is on the host). Trust only that
address, not a whole Docker bridge range; see
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
    }
}
```

Open `https://example.com/`. Paths stay as in the README (`/downloads/`,
`/tty/`, `/tunnel`, `/healthz`).

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
  -e WEB_TRUSTED_PROXIES=172.18.0.5 \
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
    }
}
```

Open `https://example.com/tabtop/`. Paths move under the base
(`/tabtop/downloads/`, `/tabtop/tty/`, and so on). Anything outside
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
