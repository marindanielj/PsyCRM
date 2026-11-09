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
# The product name on the sign-in page (before anyone is signed in there is no practice to take it from).
ARG VITE_APP_NAME=PsyCRM
ENV VITE_APP_NAME=$VITE_APP_NAME
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

# ECS (Fargate) mounts an empty scratch volume on /tmp so the root filesystem can be read-only.
# A mounted volume belongs to root (0755) unless the image declares it with VOLUME *after* setting
# the owner; without this the unprivileged user could not create tsx's cache and every task died
# with "EACCES: permission denied, mkdir '/tmp/tsx-1000'". The path must equal the task's containerPath.
# https://docs.aws.amazon.com/AmazonECS/latest/developerguide/bind-mounts.html
RUN chown node:node /tmp && chmod 1777 /tmp
VOLUME ["/tmp"]

# Run as the unprivileged user that ships with the node image.
USER node
EXPOSE 8790
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8790)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["npx", "tsx", "server/index.ts"]
