# Playwright's own image ships Chromium + all headless system deps preinstalled,
# pinned to the exact playwright npm version used by this project (see package.json).
FROM mcr.microsoft.com/playwright:v1.63.0-noble

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

ENV NODE_ENV=production
ENV PREVIEW_PROXY=true
ENV NEXT_TELEMETRY_DISABLED=1

EXPOSE 4000

CMD ["npm", "start"]
