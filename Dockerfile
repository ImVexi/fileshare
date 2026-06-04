FROM node:23-alpine
RUN apk add --no-cache ffmpeg
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY server.js .
COPY public ./public
EXPOSE 3001
VOLUME ["/app/data", "/app/uploads", "/app/EMBED"]
CMD ["node", "server.js"]
