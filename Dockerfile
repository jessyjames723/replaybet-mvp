FROM node:20-slim

# Install dependencies for Playwright Chromium
RUN apt-get update && apt-get install -y \
    wget \
    gnupg \
    ca-certificates \
    libnss3 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libasound2 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libx11-xcb1 \
    libxcb-dri3-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files
COPY package.json package-lock.json* ./

# Install Node dependencies
RUN npm install --omit=dev

# Install Playwright browsers (Chromium only)
RUN npx playwright install chromium --with-deps

# Copy application code
COPY src/ ./src/
COPY public/ ./public/

# Expose HTTP port
EXPOSE 3000

# WebSocket port (internal, same process)
EXPOSE 3001

# Start server (Railway runs only server; bot/observer are separate processes)
CMD ["node", "src/server.js"]
