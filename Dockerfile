FROM node:22-bookworm-slim AS frontend
WORKDIR /build/desktop
COPY desktop/package*.json ./
RUN npm ci
COPY desktop/ ./
COPY shared/ /build/shared/
RUN npm run build

FROM node:22-bookworm-slim AS backend
WORKDIR /build/backend
COPY backend/package*.json ./
RUN npm ci
COPY backend/ ./
COPY shared/ /build/shared/
RUN npm run build

FROM python:3.12-slim-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends libstdc++6 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY pyproject.toml README.md ./
COPY packaging/requirements-web.lock /tmp/requirements-web.lock
COPY flyscan/ ./flyscan/
RUN pip install --no-cache-dir --require-hashes -r /tmp/requirements-web.lock
COPY --from=frontend /build/desktop/dist ./desktop/dist
COPY --from=backend /usr/local/bin/node /usr/local/bin/node
COPY --from=backend /build/backend/dist ./backend/dist
COPY packaging/smoke_web.mjs ./packaging/smoke_web.mjs
ENV FLYSCAN_MODE=web FLYSCAN_DATA_DIR=/data PYTHONUNBUFFERED=1 FLYSCAN_PYTHON=python FLYSCAN_TRANSPORT_SCRIPT=/app/flyscan/transport.py FLYSCAN_FRONTEND=/app/desktop/dist
EXPOSE 8080
CMD ["node", "/app/backend/dist/index.cjs", "serve"]
