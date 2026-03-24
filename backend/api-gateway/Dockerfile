FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/package.json
COPY backend/api-gateway/package.json backend/api-gateway/package.json
COPY backend/content-service/package.json backend/content-service/package.json
COPY backend/ai-service/package.json backend/ai-service/package.json
COPY backend/search-service/package.json backend/search-service/package.json
COPY backend/graph-service/package.json backend/graph-service/package.json
COPY backend/worker-service/package.json backend/worker-service/package.json
COPY frontend/web-app/package.json frontend/web-app/package.json
COPY frontend/extension/package.json frontend/extension/package.json
RUN npm ci
COPY . .
CMD ["npm", "--workspace", "backend/api-gateway", "run", "start"]
