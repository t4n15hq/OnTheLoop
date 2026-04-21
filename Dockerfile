FROM node:20-alpine

WORKDIR /app

# Install all deps (devDeps are needed for `tsc` at build time and `prisma`
# CLI at runtime for `migrate deploy`).
COPY package*.json ./
RUN npm ci

# Build: `npm run build` runs `prisma generate && tsc`.
COPY . .
RUN npm run build

EXPOSE 3000

# Railway overrides this via railway.json (`startCommand: npm run start:prod`)
# so migrations run before the server boots. Kept here as a sensible default
# if someone runs the image outside Railway.
CMD ["npm", "run", "start:prod"]
