# Dockerfile for Railway (or any Docker host)
FROM node:20-slim

# openssl - Prisma
# ca-certificates - TLS for outbound HTTPS
RUN apt-get update -y && apt-get install -y --no-install-recommends \
    openssl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
COPY prisma ./prisma/
RUN npm install
RUN npx prisma generate

COPY . .
RUN npm run build

CMD ["npm", "run", "telegram"]
