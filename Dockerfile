FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build
# D6：构建阶段裁剪生产依赖，供运行镜像使用
RUN npm prune --omit=dev

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/server/database/migrations ./server/database/migrations
# L10：仅拷贝运行期必需脚本，避免把本地 DB/隧道等开发工具带入镜像
COPY --from=build /app/scripts/db-migrate.mjs ./scripts/db-migrate.mjs
COPY --from=build /app/scripts/start.mjs ./scripts/start.mjs

# A7：上传目录属主为 node，避免卷挂载后 EACCES
RUN mkdir -p /app/data/uploads \
  && chown -R node:node /app
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

EXPOSE 3000
CMD ["node", "dist/server/main.js"]
