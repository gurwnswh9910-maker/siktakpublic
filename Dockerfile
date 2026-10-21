FROM node:24-bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
RUN --mount=type=secret,id=proxy_ca --mount=type=cache,target=/root/.npm \
    if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; \
    npm ci --no-audit --no-fund
# .dockerignore is an explicit allow-list: source documents and .env stay out.
COPY . .
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; \
    npx prisma generate && \
    DATABASE_URL=postgresql://build:build@localhost/build BETTER_AUTH_URL=http://localhost:3000 BETTER_AUTH_SECRET=build-only-placeholder-not-a-runtime-secret npm run build && \
    cp -r public .next/standalone/public && \
    cp -r .next/static .next/standalone/.next/static && \
    mkdir -p .next/standalone/.next/cache && \
    chown -R node:node /app

FROM build AS runtime
ENV NODE_ENV=production HOSTNAME=0.0.0.0 PORT=3000
USER node
EXPOSE 3000
CMD ["node", ".next/standalone/server.js"]
