# Build the Astro frontend (no install scripts: this stage never runs
# mediasoup, so skip its worker download/check entirely)
FROM node:22-trixie-slim AS webbuild
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci --ignore-scripts
COPY web ./web
RUN npm run build:web

# Runtime: Node control plane + ffmpeg recorder + Python transcription.
# trixie (not bookworm): the prebuilt mediasoup worker needs glibc >= 2.38.
FROM node:22-trixie-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg python3 python3-venv \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci
COPY server ./server
COPY transcription ./transcription
RUN python3 -m venv .venv && .venv/bin/pip install --no-cache-dir -r transcription/requirements.txt
COPY --from=webbuild /app/web/dist ./web/dist

# Single data directory: mount one volume at /data and everything durable
# lives inside it — recordings, TLS certs (their presence switches on
# HTTPS), the rebuildable search index, and the whisper model cache.
ENV NODE_ENV=production \
    RECORDINGS_DIR=/data/recordings \
    CERTS_DIR=/data/certs \
    DB_PATH=/data/index/overheard.db \
    HF_HOME=/data/hf-cache
VOLUME ["/data"]
EXPOSE 3000/tcp 40000-40100/udp 40000-40100/tcp

CMD ["npx", "tsx", "server/index.ts"]
