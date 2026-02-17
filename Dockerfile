FROM nginx:alpine

# Install Python and pip
RUN apk add --no-cache python3 py3-pip

# Set working directory
WORKDIR /cryptex

# Copy API files
COPY api /cryptex/api
COPY --chown=nginx:nginx web /cryptex/web

# Install Python dependencies
RUN pip3 install --no-cache-dir -r /cryptex/api/requirements.txt --break-system-packages

# Copy custom Nginx configuration
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY entrypoint.sh /cryptex/entrypoint.sh
RUN chmod +x /cryptex/entrypoint.sh

# Create data directory for persistent storage
RUN mkdir -p /cryptex/data/files

# Expose ports
EXPOSE 80

# Default rate limit (requests per minute per IP)
ENV RATE_LIMIT=30

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1/api/health || exit 1

ENTRYPOINT ["/cryptex/entrypoint.sh"]
