# PsyCRM: one image serves the API and the built web app.
#   docker buildx build --platform linux/arm64 -t psycrm-app .
# (ARM64 matches the Fargate task definition in docs/psycrm/INFRA_AWS.md.)

# ---- build: install deps, build the SPA -------------------------------------
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json vite.config.ts index.html ./
COPY src ./src
RUN npm run build

# ---- runtime ----------------------------------------------------------------
FROM node:22-slim AS runtime
ENV NODE_ENV=production \
    PORT=8790 \
    STATIC_DIR=/app/dist \
    # tsx (runs the TypeScript server) keeps a cache; point it at the writable /tmp
    # so the task can run with a read-only root filesystem.
    TMPDIR=/tmp
WORKDIR /app

# AWS RDS root certificates, so DATABASE_URL can use sslmode=verify-full&sslrootcert=...
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && mkdir -p /app/certs \
 && curl -fsSL https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem -o /app/certs/rds-global-bundle.pem \
 && test -s /app/certs/rds-global-bundle.pem \
 && apt-get purge -y curl && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*

# MVP: ship the full node_modules (tsx is a dev dependency). Bundling the server
# to plain JS and dropping dev deps is a post-MVP hardening item.
COPY --from=build /app/node_modules ./node_modules
COPY package.json ./
COPY tsconfig.json ./
COPY server ./server
COPY db ./db
COPY --from=build /app/dist ./dist

# Run as the unprivileged user that ships with the node image.
USER node
EXPOSE 8790
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8790)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["npx", "tsx", "server/index.ts"]
