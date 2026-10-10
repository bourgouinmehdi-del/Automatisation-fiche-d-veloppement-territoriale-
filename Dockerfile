# Image de production : Next.js + Chromium (export PDF).
# Hébergement conseillé : un service « serveur » avec au moins 2 Go de RAM et un
# volume persistant monté sur /data (cache des sources et fiches générées).
FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends chromium fonts-dejavu-core fonts-liberation ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1 \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    CHROMIUM_PATH=/usr/bin/chromium \
    DATA_DIR=/data \
    NODE_OPTIONS=--max-old-space-size=3072 \
    PORT=3000

COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && mkdir -p /data

EXPOSE 3000
CMD ["sh", "-c", "npx next start -p ${PORT:-3000}"]
