FROM node:22-alpine
WORKDIR /app
COPY package.json server.js game.js ws.js words.js catalog.js history.js topics.js adapt.js ./
COPY public ./public
ENV NODE_ENV=production PORT=8080 DATA_DIR=/data
ARG GIT_SHA=dev
ENV GIT_SHA=$GIT_SHA
RUN mkdir -p /data && chown node:node /data
VOLUME /data
USER node
EXPOSE 8080
CMD ["node", "server.js"]
