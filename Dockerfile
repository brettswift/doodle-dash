FROM node:22-alpine
WORKDIR /app
COPY package.json server.js game.js ws.js words.js ./
COPY public ./public
ENV NODE_ENV=production PORT=8080
USER node
EXPOSE 8080
CMD ["node", "server.js"]
