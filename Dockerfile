# ---- build ----
# devDeps (tsc, prisma CLI) are only needed to compile and generate the client.
FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build            # prisma generate && tsc

# ---- runtime ----
# Slim, production-only image. Migrations are NOT run here — Railway runs
# `prisma migrate deploy` once via the pre-deploy/release step (see railway.json),
# so scaling out never races multiple `migrate deploy` on boot.
FROM node:20-alpine
ENV NODE_ENV=production TZ=America/Chicago
RUN apk add --no-cache tzdata
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
# dist = compiled JS, .prisma = generated client, prisma/ = schema+migrations,
# public/ = static web assets served by the app.
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
COPY prisma ./prisma
COPY public ./public
# Drop root; node:20-alpine ships a non-root `node` user.
USER node
EXPOSE 3000
CMD ["node", "dist/index.js"]
