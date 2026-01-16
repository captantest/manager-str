# Production Dockerfile
FROM node:18-alpine

WORKDIR /app

# Copy package.json
COPY package.json ./

# Install dependencies (production only)
RUN npm install --omit=dev

# Copy all files
COPY . .

# Environment setup
ENV PORT=7860
ENV NODE_ENV=production
# Flattened structure: server.js and index.html are in the same dir (/app)
ENV FRONTEND_PATH=/app

EXPOSE 7860

CMD ["node", "server.js"]
