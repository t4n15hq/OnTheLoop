FROM node:20-alpine

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci

# Copy source code
COPY . .
COPY prisma ./prisma/

# Build
RUN npx prisma generate
RUN npm run build

# Expose port
EXPOSE 3000

# Start application
CMD ["npm", "start"]

