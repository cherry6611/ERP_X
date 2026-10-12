FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/server/database/migrations ./server/database/migrations
COPY --from=build /app/scripts/db-migrate.mjs ./scripts/db-migrate.mjs
EXPOSE 3000
CMD ["node", "dist/server/main.js"]
