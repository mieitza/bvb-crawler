# ── build stage ──
FROM node:22-bookworm-slim AS build

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

# ── runtime stage ──
FROM node:22-bookworm-slim

WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY package.json ./

# Install Playwright system deps + browser binary matching the npm-installed version.
RUN npx playwright install --with-deps chromium \
 && rm -rf /var/lib/apt/lists/*

COPY . .

ENV NODE_ENV=production
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
ENV PORT=8080

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=3 \
  CMD node -e "fetch('http://localhost:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/index.js"]