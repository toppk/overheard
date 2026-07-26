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

# Recordings and certs live on volumes; certs/ presence switches on HTTPS.
VOLUME ["/app/recordings", "/app/certs"]
EXPOSE 3000/tcp 40000-40100/udp 40000-40100/tcp

ENV NODE_ENV=production
CMD ["npx", "tsx", "server/index.ts"]
