FROM node:20-slim

WORKDIR /app

COPY server/package.json server/package-lock.json* ./server/
RUN cd server && npm install --omit=dev

COPY server ./server
COPY client ./client

WORKDIR /app/server
ENV NODE_ENV=production

CMD ["node", "index.js"]
