# agy (Antigravity CLI) Dockerfile install: Go binary, not npm — move out of HOME

## What went wrong
(Pre-emptive) The `agy` binary is a native Go binary distributed via a shell
install script, NOT an npm package. If the install script runs during the Docker
build with the runtime HOME set (e.g. `ENV HOME=/agy-home`), the binary lands at
`/agy-home/.local/bin/agy` — inside the named auth volume mount. Running
`docker compose down -v` would wipe the binary along with the credentials.

## Fix
During the build stage, HOME defaults to `/root` (the RUN user). Let the install
script write to `/root/.local/bin/agy`, then MOVE the binary to `/usr/local/bin/`
so it lives in the image layer, not in the volume:

```dockerfile
# Binary install (build time — HOME=/root, so install script writes there)
RUN curl -fsSL https://antigravity.google/cli/install.sh | bash \
    && mv /root/.local/bin/agy /usr/local/bin/agy \
    && rm -rf /root/.local /root/.bashrc /root/.profile

# Runtime HOME for auth only (volume-mounted — credentials only, not binary)
ENV HOME=/agy-home
RUN mkdir -p /agy-home /work && chown -R node:node /agy-home /work
```

Key facts about agy:
- Version 1.0.12 (linux_amd64 Go binary); base image must be glibc (node:22-slim /
  Debian), NOT musl/Alpine
- Generation: `agy --print --dangerously-skip-permissions [--model <model>] "prompt"`
  stdout = response (same as `claude --print`)
- Auth: NO `auth` subcommand. Run `agy` interactively once:
    docker compose exec agy agy   # prints a Google OAuth URL to visit
- Credentials written to: `$HOME/.config/antigravity/`
- Health auth check: `access($HOME/.config/antigravity/)` — dir present = logged in
- Port: 8084 (codex=8082, claude=8083, agy=8084)
- nginx route: `/agy/` -> `${AGY_HOST}` (add `AGY_` to NGINX_ENVSUBST_FILTER)

## Verification
```sh
docker compose up -d --build
docker compose exec agy agy        # follow the Google OAuth URL, then Ctrl-C
curl http://localhost:8080/agy/healthz
# -> {"ok":true,"backend":"agy","auth":"logged-in",...}
```
