# Stage 1: Build
FROM node:22-alpine AS builder

WORKDIR /app

COPY package.json yarn.lock nest-cli.json tsconfig.json tsconfig.build.json ./
RUN yarn install --frozen-lockfile --non-interactive

COPY src ./src
COPY public ./public
RUN yarn build

# Stage 2: Production
FROM node:22-alpine AS production

WORKDIR /app

ENV NODE_ENV=production

RUN yarn global add pm2

COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile --production --non-interactive && yarn cache clean

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/public ./public
COPY ecosystem.config.js ./

RUN mkdir -p logs

ARG PORT=3000
EXPOSE ${PORT}

CMD ["pm2-runtime", "ecosystem.config.js", "--env", "production"]
