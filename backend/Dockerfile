# syntax=docker/dockerfile:1.7
FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@10.7.0 --activate
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
RUN pnpm build && pnpm prune --prod

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/migrations ./migrations
# the compiled code resolves the Fluent files relative to dist/ (render.ts, core/i18n.ts)
COPY --from=build /app/libs/telegram/src/i18n ./dist/libs/telegram/src/i18n
COPY package.json ./
USER node
CMD ["node", "dist/apps/api/src/main.js"]
