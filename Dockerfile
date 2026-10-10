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
    PORT=3000
# Pas de NODE_OPTIONS imposé : Node dimensionne sa mémoire selon le conteneur.
# Sur une machine de 2 Go ou plus, on peut ajouter la variable
# NODE_OPTIONS=--max-old-space-size=1536 dans l'hébergeur.

COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && mkdir -p /data

EXPOSE 3000
CMD ["sh", "-c", "npx next start -p ${PORT:-3000}"]
