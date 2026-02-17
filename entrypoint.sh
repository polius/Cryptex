#!/bin/sh
set -e

# Substitute rate limit env var into nginx config
envsubst '${RATE_LIMIT}' < /etc/nginx/conf.d/default.conf > /etc/nginx/conf.d/default.conf.tmp
mv /etc/nginx/conf.d/default.conf.tmp /etc/nginx/conf.d/default.conf

# Start FastAPI in background
python3 -m uvicorn api.main:app --host 127.0.0.1 --port 8000 &

# Start nginx in foreground
nginx -g 'daemon off;'
