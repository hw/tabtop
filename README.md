# TabTop

[![Build](https://github.com/hw/tabtop/actions/workflows/build.yml/badge.svg)](https://github.com/hw/tabtop/actions/workflows/build.yml)

A Linux desktop in the browser: XFCE and Chromium over noVNC, plus a
terminal and a files page for `~/Downloads`. Log in with a TOTP code
(optionally preceded by a password). Sound plays in the browser. Logins and
everything after them use an [encrypted tunnel](docs/encryption.md), so a
proxy that only decrypts HTTPS can't read them.

One HTTP port (`6080`) serves the desktop (`/`), [files](docs/downloads.md)
(`/fs/`), [terminal](docs/terminal.md) (`/tty/`), the tunnel, and
[health checks](docs/health-checks.md).

Two images: `tabtop`, with its own desktop
([XFCE](docs/full-image.md)), and `tabtop-lite`, which shows a VNC server
elsewhere, such as the host ([lite](docs/lite.md)).

## Local quick start

```sh
docker run -d --name tabtop -p 6080:6080 ghcr.io/hw/tabtop:latest
```
This runs the image GitHub Actions publishes to `ghcr.io/hw/tabtop`. To run
your own build instead, build it with `docker build -t tabtop .` and replace
`ghcr.io/hw/tabtop:latest` in the `docker run` command with `tabtop`.

Open <http://localhost:6080/> and enter the current code from your
authenticator app. To require a password as well, set `VNC_PASSWORD` (see below): then enter that password
immediately followed by the code, with no separator.

No persistent volume is required. To keep the same authenticator entry when
the container is replaced, keep passing the same `VNC_TOTP_SECRET`. You can
optionally mount storage at `/home/<VNC_USER>` to retain browser data, 
downloads and desktop settings as well.

## Secured local access 

Set the user and TOTP via environment variable:

```sh
docker run -d --name tabtop -p 6080:6080 \
  -e VNC_USER=$USER -e VNC_TOTP_SECRET="$(head -c 20 /dev/urandom | base32)" \
  ghcr.io/hw/tabtop:latest
docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' tabtop | grep VNC_TOTP_SECRET
```

Add that secret to an authenticator app as a time-based (TOTP) entry: 
SHA-1, 30 seconds and 6 digits, which are most apps' defaults. Without
`VNC_TOTP_SECRET`, the container uses a **well-known, public default secret** 
(see [Default TOTP secret](docs/environment.md#default-totp-secret)), which is only safe on a 
machine nobody else can reach.


## Documentation

- [Running TabTop with XFCE](docs/full-image.md): the full image's desktop,
  clipboard and sound
- [Running tabtop-lite with the host's desktop](docs/lite.md): the host's
  VNC server, sound and an SSH terminal
- [Reverse proxy](docs/reverse-proxy.md): HTTPS in front of TabTop, with
  nginx examples at the root and under `WEB_BASE_PATH`
- [Environment variables](docs/environment.md): defaults, validation and
  every setting in detail
- [Encryption and security](docs/encryption.md): the end-to-end encrypted
  tunnel, sessions and security notes
- [Downloads](docs/downloads.md): the files page
- [Terminal](docs/terminal.md): the browser terminal
- [Health checks](docs/health-checks.md): `/healthz` and the `/doctor`
  report
- [Building and development](docs/development.md): build arguments, tests
  and continuous integration
- [Credits](docs/credits.md): the projects TabTop is built on


## License

TabTop is licensed under the [Apache License, Version 2.0](LICENSE); see
[NOTICE](NOTICE). The third-party components it bundles keep their own
licences, listed in [Credits](docs/credits.md).
