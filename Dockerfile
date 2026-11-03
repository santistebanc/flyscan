FROM node:22-bookworm-slim AS frontend
WORKDIR /build/desktop
COPY desktop/package*.json ./
RUN npm ci
COPY desktop/ ./
RUN npm run build

FROM python:3.12-slim-bookworm
WORKDIR /app
COPY pyproject.toml README.md ./
COPY packaging/requirements-web.lock /tmp/requirements-web.lock
COPY flyscan/ ./flyscan/
RUN pip install --no-cache-dir --require-hashes -r /tmp/requirements-web.lock \
    && pip install --no-cache-dir --no-deps .
COPY --from=frontend /build/desktop/dist ./desktop/dist
ENV FLYSCAN_MODE=web FLYSCAN_DATA_DIR=/data PYTHONUNBUFFERED=1
EXPOSE 8080
CMD ["python", "-m", "flyscan.host"]
