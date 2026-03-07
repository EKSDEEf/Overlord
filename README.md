<p align="center">
  <img src="https://raw.githubusercontent.com/vxaboveground/Overlord/refs/heads/main/Overlord-Server/public/assets/353030.png" alt="Overlord" />
</p>

# Overlord

# [TELEGRAM SERVER JOIN NOW NO EXCUSES WE GIVE SUPPORT AND IT'S FUN](https://t.me/WindowsBatch)

Hello, I made this project for fun.

Just use docker please the src is fine to use as well but you need golang, bun, garble and openssl.

To use docker copy the docker-compose.yml to your working directory and run

```sh
docker compose up
```

On first startup, if secrets are not provided through environment variables,
Overlord generates them and persists them to `data/save.json` (inside Docker:
`/app/data/save.json`). This includes:

- JWT signing secret
- Agent auth token

Initial bootstrap login defaults to username `admin` and password `admin`
unless overridden with `OVERLORD_USER` / `OVERLORD_PASS`.

Keep `save.json` private and backed up. Use values from that file if you need
to recover JWT or agent token values.

to update run

```sh
docker compose pull
```

## Docker TLS with certbot

If you want to avoid self-signed certificates in Docker/production, enable certbot TLS settings:

- Set `OVERLORD_TLS_CERTBOT_ENABLED=true`
- Set `OVERLORD_TLS_CERTBOT_DOMAIN=your-domain.com`
- Mount letsencrypt into the container (for example `- /etc/letsencrypt:/etc/letsencrypt:ro`)

By default Overlord reads:

- cert: `/etc/letsencrypt/live/<domain>/fullchain.pem`
- key: `/etc/letsencrypt/live/<domain>/privkey.pem`
- ca: `/etc/letsencrypt/live/<domain>/chain.pem`

These can be changed with:
`OVERLORD_TLS_CERTBOT_LIVE_PATH`,
`OVERLORD_TLS_CERTBOT_CERT_FILE`,
`OVERLORD_TLS_CERTBOT_KEY_FILE`, and
`OVERLORD_TLS_CERTBOT_CA_FILE`.

It's literally just docker any question chatgpt can answer so don't worry.

## Production package (Windows)

Build a production-ready package where the server can still build client binaries at runtime:

```bat
build-prod-package.bat
```

Linux/macOS:

```bash
./build-prod-package.sh
```

Windows output folder:

```text
release
```

Windows package includes:
- `Overlord-Client`
- `overlord-server.exe`
- `overlord-server-linux-x64`
- `start-prod-release.bat`
- `start-prod-release.sh`
- `public`

`build-prod-package.bat` also minifies `public/assets/*.js` into the release package.

Note: both packaging scripts always skip building client binaries and export `Overlord-Client` source for runtime builds.