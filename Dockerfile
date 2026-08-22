# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build && npm prune --omit=dev

# distroless: no shell, no package manager, no busybox. Nothing to pivot to.
FROM gcr.io/distroless/nodejs22-debian12 AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json
# Migrations ship with the image so the pre-deploy job runs the exact same SQL
# that this build was tested against.
COPY --from=build /app/src/db/migrations ./dist/db/migrations

USER 1000
EXPOSE 4000
CMD ["dist/server.js"]
