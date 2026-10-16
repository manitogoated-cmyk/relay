# Build context: repo root.  docker build -f deploy/Dockerfile -t relay .
FROM node:20-alpine AS ui
WORKDIR /ui
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
RUN npx vite build

FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 \
    RELAY_DATABASE_URL=sqlite:////data/relay.db RELAY_STORAGE_DIR=/data/uploads RELAY_FRONTEND_DIST=/app/frontend/dist
WORKDIR /app
COPY backend/requirements.txt backend/requirements-s3.txt backend/
RUN pip install --no-cache-dir -r backend/requirements.txt -r backend/requirements-s3.txt
COPY backend/ backend/
COPY --from=ui /ui/dist frontend/dist
RUN useradd --system --uid 10001 relay && mkdir -p /data && chown relay /data
USER relay
VOLUME ["/data"]
WORKDIR /app/backend
EXPOSE 8100
HEALTHCHECK --interval=30s --timeout=5s CMD python -c "import urllib.request;urllib.request.urlopen('http://127.0.0.1:8100/api/health')"
# One worker: rate limits and live events are in-process (see docs/DEPLOYMENT.md).
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8100", "--proxy-headers", "--forwarded-allow-ips", "*", "--workers", "1"]
