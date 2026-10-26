# syntax=docker/dockerfile:1.7
# Cryptex 3: one container, nginx + API under s6-overlay. TLS terminates in front of it.

FROM node:24-alpine AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
RUN npm run build && node scripts/budget.mjs

FROM python:3.13-alpine AS runtime
ARG S6_OVERLAY_VERSION=3.2.1.0
ARG TARGETARCH
RUN apk add --no-cache nginx xz tzdata \
 && addgroup -S cryptex && adduser -S -G cryptex -h /app -s /sbin/nologin cryptex
RUN set -eux; \
    case "${TARGETARCH:-amd64}" in amd64) arch=x86_64; sum=8bcbc2cada58426f976b159dcc4e06cbb1454d5f39252b3bb0c778ccf71c9435;; \
      arm64) arch=aarch64; sum=c8fd6b1f0380d399422fc986a1e6799f6a287e2cfa24813ad0b6a4fb4fa755cc;; *) echo "unsupported arch"; exit 1;; esac; \
    base="https://github.com/just-containers/s6-overlay/releases/download/v${S6_OVERLAY_VERSION}"; \
    wget -qO /tmp/noarch.tar.xz "$base/s6-overlay-noarch.tar.xz"; \
    echo "42e038a9a00fc0fef70bf0bc42f625a9c14f8ecdfe77d4ad93281edf717e10c5  /tmp/noarch.tar.xz" | sha256sum -c -; \
    wget -qO /tmp/arch.tar.xz "$base/s6-overlay-${arch}.tar.xz"; \
    echo "${sum}  /tmp/arch.tar.xz" | sha256sum -c -; \
    tar -C / -Jxpf /tmp/noarch.tar.xz; tar -C / -Jxpf /tmp/arch.tar.xz; rm /tmp/*.tar.xz

WORKDIR /app
COPY api/requirements.txt ./
RUN pip install --no-cache-dir --require-hashes -r requirements.txt
COPY api/cryptex ./cryptex
COPY --from=web /web/dist /usr/share/cryptex/web
COPY docker/nginx.conf /etc/nginx/nginx.conf
COPY docker/cryptex-headers.conf /etc/nginx/cryptex-headers.conf
COPY docker/s6-rc.d /etc/s6-overlay/s6-rc.d
COPY docker/scripts /etc/s6-overlay/scripts
COPY docker/cryptex /usr/local/bin/cryptex
RUN touch /etc/nginx/cryptex-demo.conf && python -m compileall -q /app/cryptex

ENV DATA_DIR=/data \
    CRYPTEX_BEHIND_NGINX=true \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    S6_BEHAVIOUR_IF_STAGE2_FAILS=2 \
    S6_KILL_GRACETIME=5000 \
    S6_CMD_WAIT_FOR_SERVICES_MAXTIME=30000
VOLUME /data
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://127.0.0.1/api/v1/healthz >/dev/null || exit 1
ENTRYPOINT ["/init"]
