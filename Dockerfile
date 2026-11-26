# Imagem da marketplace-api
# Build:  docker build -t sheserve-api .
# Run:    docker run --init -p 3000:3000 --env-file .env sheserve-api
FROM node:24-bookworm-slim

ENV NODE_ENV=production \
    PORT=3000

WORKDIR /app

# Dependências primeiro: a camada fica em cache enquanto package*.json não mudar.
# argon2 já traz binário pré-compilado para Linux (glibc), sem precisar de compilador.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Código (schema.sql é lido em runtime para as migrações)
COPY src ./src

# Não roda como root
USER node

EXPOSE 3000

# A imagem slim não tem curl; o fetch nativo do Node faz o health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
