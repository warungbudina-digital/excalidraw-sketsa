# App nginx HEALTHCHECK must hit 127.0.0.1, not localhost (image renders IPv4-only)

## What went wrong
The `app` container served fine (host `curl localhost:8080/` -> 200) but its Docker
HEALTHCHECK stayed `unhealthy`/`starting` with `wget: can't connect to remote host:
Connection refused`. Cause: our nginx config comes from a TEMPLATE
(`deploy/nginx.conf.template` -> `/etc/nginx/templates/*.template`), and the nginx:alpine
entrypoint runs `10-listen-on-ipv6-by-default.sh` BEFORE `20-envsubst-on-templates.sh`. At
step 10 our `default.conf` doesn't exist yet, so the IPv6 `listen [::]:80;` is never added —
the rendered conf has only `listen 80;` (IPv4). Inside the container `localhost` resolves to
IPv6 `::1` first, so `wget http://localhost/` hits `::1:80` -> refused, while `127.0.0.1`
works. (Host access works because the published port maps to the container's `0.0.0.0:80`.)

## Fix
In the Dockerfile HEALTHCHECK use the IPv4 literal:
`HEALTHCHECK ... CMD wget -q -O /dev/null http://127.0.0.1/ || exit 1`
(busybox wget ships in nginx:alpine — no extra packages). Same trap applies to any
in-container probe of this app. Alternatively add `listen [::]:80;` to the template, but
127.0.0.1 is simpler and avoids needing IPv6 in the container.

## Verification
`docker compose up -d --build app` then poll
`docker inspect -f '{{.State.Health.Status}}' excalidraw-sketsa-app-1` -> `healthy` in ~12s.
Confirm the cause: `docker compose exec app sh -c 'wget -qO- http://127.0.0.1/ >/dev/null && echo IPv4-OK; wget -qO- http://localhost/ >/dev/null || echo localhost-FAIL'`
and `docker compose exec app grep listen /etc/nginx/conf.d/default.conf` (shows only `listen 80;`).
