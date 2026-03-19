FROM node:20-slim

RUN apt-get update && apt-get install -y \
    wget gnupg ca-certificates \
    libnss3 libatk1.0-0 libatk-bridge2.0-0 \
    libcups2 libdrm2 libxkbcommon0 \
    libxcomposite1 libxdamage1 libxfixes3 \
    libxrandr2 libgbm1 libpango-1.0-0 \
    libpangocairo-1.0-0 libx11-xcb1 libxcb-dri3-0 \
    libxshmfence1 libx11-6 libxext6 libxcb1 \
    fonts-liberation \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./

RUN npm ci --omit=dev

RUN npx playwright install chromium --with-deps

COPY src/ ./src/
COPY public/ ./public/

EXPOSE 3000

CMD ["node", "src/server.js"]
