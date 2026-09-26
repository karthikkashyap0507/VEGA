# syntax=docker/dockerfile:1
# =============================================================================
# One image per plane service: gateway | control | execution | evidence.
#
#   docker build -f infra/docker/service.Dockerfile --build-arg SERVICE=control -t <slug>/control .
#
# Each image contains the workspace but runs exactly one service, as a non-root user, with a
# read-only root filesystem expected at runtime (set in the Helm chart). Secrets are never
# baked in: they arrive as mounted files/env from the plane's own Secret (infra/helm).
# =============================================================================
FROM node:22-alpine AS deps
RUN corepack enable
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages ./packages
COPY services ./services
COPY apps/web/package.json ./apps/web/package.json
# Optional extra CA (corporate/egress proxies that re-terminate TLS):
#   docker build --secret id=extra_ca,src=/path/to/ca-bundle.crt ...
# Absent the secret, nothing changes. It is never written into an image layer.
RUN --mount=type=secret,id=extra_ca,required=false \
    if [ -s /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca; fi; \
    pnpm install --frozen-lockfile --filter "./services/*" --filter "./packages/*" --filter "." \
  && pnpm store prune

FROM node:22-alpine
ARG SERVICE
ENV NODE_ENV=production SERVICE=${SERVICE}
WORKDIR /app
COPY --from=deps /app /app
USER node
EXPOSE 3001 3002 3003 3004
# tsx transpiles on load: the workspace packages export TypeScript sources directly.
CMD ["sh", "-c", "exec node --import tsx services/${SERVICE}/src/main.ts"]
