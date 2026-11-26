# Imagem da sheserve-admin-api
# Build:  docker build -t sheserve-admin-api ./admin-api
# Run:    docker run --init -p 3001:3001 --env-file .env sheserve-admin-api
FROM node:24-bookworm-slim

ENV NODE_ENV=production \
    PORT=3001

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
# Painel administrativo servido em /admin
COPY public ./public

USER node

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
