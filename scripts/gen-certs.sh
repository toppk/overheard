#!/usr/bin/env bash
# Generate a self-signed cert so the server runs HTTPS (required for
# microphone access from non-localhost clients, e.g. iPad Safari on the LAN).
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p certs
LAN_IP=$(hostname -I | awk '{print $1}')
openssl req -x509 -newkey rsa:2048 -nodes -days 365 \
  -keyout certs/key.pem -out certs/cert.pem \
  -subj "/CN=overheard" \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1,IP:${LAN_IP}"
echo "wrote certs/cert.pem and certs/key.pem (SAN includes ${LAN_IP})"
