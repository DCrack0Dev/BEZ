FROM node:20-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_BREAK_SYSTEM_PACKAGES=1 \
    NODE_ENV=production \
    PORT=8080

WORKDIR /app

# --- System layer: Python 3.11 + build deps (numpy/pytorch need libgomp/blas) ---
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        python3 python3-pip python3-venv python3-dev \
        build-essential gfortran libopenblas-dev libgomp1 \
        ca-certificates curl \
    && update-alternatives --install /usr/bin/python python /usr/bin/python3 1 \
    && update-alternatives --install /usr/bin/pip pip /usr/bin/pip3 1 \
    && rm -rf /var/lib/apt/lists/*

# --- Persistent data directories (bind a Docker volume to /app/data in production) ---
RUN mkdir -p /app/backend/python/saved_models \
             /app/backend/python/saved_scalers \
             /app/backend/data/learning \
             /app/backend/data/monitoring \
             /app/backend/data/audit \
             /app/backend/data/backtest-reports \
             /app/backend/data/simulations

# --- Python deps layer (torch + scikit-learn + numpy + pandas + joblib) ---
# CPU-only torch cuts image size from 6GB -> 300MB. Swap for CUDA build only if you deploy to GPU box.
COPY backend/python/requirements.txt /app/backend/python/requirements.txt
RUN pip install --upgrade pip setuptools wheel \
    && pip install --index-url https://download.pytorch.org/whl/cpu torch \
    && pip install -r /app/backend/python/requirements.txt

# --- Node deps layer ---
COPY backend/package*.json /app/backend/
WORKDIR /app/backend
RUN npm ci --omit=dev

# --- Source code (python + ts + prisma + mq5 refs live in backend/) ---
COPY backend/ /app/backend/

# --- Prisma client regenerate (matches prisma/schema.prisma shipped in image) ---
RUN npx prisma generate

# --- Runtime: Node + Python both on PATH, persist storage mounted outside image ---
ENV PYTHON_PATH=/usr/bin/python
ENV DATA_ROOT=/app/backend/data

EXPOSE 8080

# Boot:
#   1. If Render Persistent Disk mounted at /app/persist → symlink persisted dirs into it
#      (saved_models, saved_scalers, data/) so training + journal data survive deploys.
#      If no disk is attached, these dirs stay on the ephemeral FS — the DB persistence
#      layer (ModelArtifact BYTEA blobs + cloudPersistence.ts) guarantees nothing is lost.
#   2. Run Prisma DB migrations against the managed Postgres.
#   3. Start the Node backend (TS executed via ts-node/register for zero-build simplicity).
CMD ["sh", "-c", "\
  if [ -d /app/persist ]; then \
    mkdir -p /app/persist/saved_models /app/persist/saved_scalers /app/persist/data && \
    [ -d /app/backend/python/saved_models ] || mv /app/backend/python/saved_models /app/backend/python/saved_models.bak 2>/dev/null; \
    [ -d /app/backend/python/saved_scalers ] || mv /app/backend/python/saved_scalers /app/backend/python/saved_scalers.bak 2>/dev/null; \
    [ -d /app/backend/data ] || mv /app/backend/data /app/backend/data.bak 2>/dev/null; \
    ln -sfn /app/persist/saved_models /app/backend/python/saved_models && \
    ln -sfn /app/persist/saved_scalers /app/backend/python/saved_scalers && \
    ln -sfn /app/persist/data         /app/backend/data; \
    chmod -R u+w /app/persist; \
    echo '[docker-entrypoint] Persistent disk symlinks OK'; \
  else \
    echo '[docker-entrypoint] No /app/persist disk — using ephemeral FS + DB blob persistence'; \
  fi && \
  cd /app/backend && \
  npx prisma migrate deploy && \
  node -r ts-node/register src/main.ts"]
