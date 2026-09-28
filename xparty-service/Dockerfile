FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY server.mjs ./
COPY public ./public
USER node
ENV PORT=8787
EXPOSE 8787
CMD ["node", "server.mjs"]
