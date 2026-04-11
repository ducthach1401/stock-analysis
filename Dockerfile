# Stage 1: Build
FROM node:22-alpine AS builder

WORKDIR /app

COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile

COPY . .
RUN yarn build

# Stage 2: Production
FROM node:22-alpine AS production

WORKDIR /app

ENV NODE_ENV=production

RUN yarn global add pm2

COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile --production && yarn cache clean

COPY --from=builder /app/dist ./dist
COPY ecosystem.config.js ./

RUN mkdir -p logs

EXPOSE 3000

CMD ["pm2-runtime", "ecosystem.config.js", "--env", "production"]
