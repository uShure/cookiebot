FROM node:24-alpine

WORKDIR /app

COPY package.json package-lock.json ./
# tsx runs the TypeScript sources directly, so dev dependencies are needed at runtime.
RUN npm ci --include=dev --no-audit --no-fund && npm cache clean --force
ENV NODE_ENV=production

COPY tsconfig.json ./
COPY src ./src

RUN mkdir -p /app/data && chown -R node:node /app/data
USER node

CMD ["npx", "tsx", "src/index.ts"]
