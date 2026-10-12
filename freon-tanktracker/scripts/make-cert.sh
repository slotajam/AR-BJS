#!/bin/sh
# Self-signed certificate for pilot testing on a local network.
# Phones will show a certificate warning; for real use put the app behind a
# reverse proxy with a publicly trusted certificate (e.g. Let's Encrypt).
set -e
HOST_IP=${1:-192.168.1.10}
mkdir -p certs
openssl req -x509 -newkey rsa:2048 -nodes -days 365 \
  -keyout certs/key.pem -out certs/cert.pem \
  -subj "/CN=Freon TankTracker pilot" \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1,IP:${HOST_IP}"
echo "Start with: TLS_CERT=certs/cert.pem TLS_KEY=certs/key.pem PUBLIC_BASE_URL=https://${HOST_IP}:3000 npm start"
