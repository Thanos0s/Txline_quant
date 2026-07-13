# Stage 1: Build the frontend React app
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build:web

# Stage 2: Run the unified Express + React app
FROM node:20-alpine
WORKDIR /app
# Install build tools for native packages like better-sqlite3
RUN apk add --no-cache python3 make g++ gcc
COPY package*.json ./
RUN npm ci --only=production
COPY . .
COPY --from=builder /app/dist ./dist

EXPOSE 3001
ENV NODE_ENV=production
ENV PORT=3001
CMD ["npx", "tsx", "src/server.ts"]
