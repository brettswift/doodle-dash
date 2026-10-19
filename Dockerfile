FROM node:22-alpine
WORKDIR /app
COPY package.json server.js game.js ws.js words.js ./
COPY public ./public
ENV NODE_ENV=production PORT=8080
ARG GIT_SHA=dev
ENV GIT_SHA=$GIT_SHA
USER node
EXPOSE 8080
CMD ["node", "server.js"]
