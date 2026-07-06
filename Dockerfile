FROM node:22-alpine AS builder

WORKDIR /app
COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

FROM node:22-alpine AS runtime

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist
COPY bin/ ./bin/
COPY toprope.config.yaml ./

RUN mkdir -p data

EXPOSE 8080

CMD ["node", "bin/index.js", "start"]
