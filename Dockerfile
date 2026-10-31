# syntax=docker/dockerfile:1.7
# Cryptex: one uvicorn process serves the API and the web app. TLS terminates at a proxy in front (README.md).
# Base images are pinned by digest (Dependabot updates both the tag and the digest).
FROM --platform=$BUILDPLATFORM node:25-alpine@sha256:bdf2cca6fe3dabd014ea60163eca3f0f7015fbd5c7ee1b0e9ccb4ced6eb02ef4 AS web
WORKDIR /src/web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY docs/vectors.json /src/docs/
COPY web/ ./
RUN npm run build && node scripts/budget.mjs && rm -rf dist/.vite

FROM python:3.13-alpine@sha256:8bcfa47b04b853a17aaf909362b847b2112fd6ec4105ea553ef9a43bafbb5916
WORKDIR /app
COPY api/requirements.txt ./
# The server runs as cryptex (UID 10001). docker-entrypoint.sh starts as root only to hand it the data folder; the
# cryptex command, run with docker exec (as root), drops to that user the same way.
RUN pip install --no-cache-dir --require-hashes -r requirements.txt \
 && apk add --no-cache su-exec \
 && addgroup -S -g 10001 cryptex && adduser -S -D -H -u 10001 -G cryptex -h /app -s /sbin/nologin cryptex \
 && install -d -m 700 -o cryptex -g cryptex /data \
 && printf '#!/bin/sh\n[ "$(id -u)" = 0 ] && exec su-exec cryptex python -m cryptex.manage "$@"\nexec python -m cryptex.manage "$@"\n' > /usr/local/bin/cryptex && chmod 755 /usr/local/bin/cryptex
COPY --chmod=755 docker-entrypoint.sh /usr/local/bin/
COPY api/cryptex ./cryptex
COPY --from=web /src/web/dist /usr/share/cryptex/web
RUN python -m compileall -q cryptex
ENV DATA_DIR=/data STATIC_DIR=/usr/share/cryptex/web PYTHONPATH=/app PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 \
    TRUSTED_PROXIES=127.0.0.0/8,::1,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,fc00::/7
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --start-interval=2s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/api/v1/healthz >/dev/null || exit 1
ENTRYPOINT ["docker-entrypoint.sh"]
# Shell form for $TRUSTED_PROXIES; exec makes uvicorn PID 1, so `docker stop` reaches it (open requests get 5 s).
CMD exec uvicorn cryptex.app:create_app --factory --host 0.0.0.0 --port 8080 --loop uvloop --http httptools \
    --proxy-headers --forwarded-allow-ips "$TRUSTED_PROXIES" --no-server-header --log-level warning \
    --timeout-graceful-shutdown 5
