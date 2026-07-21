FROM node:22-alpine
WORKDIR /app
COPY package.json production-server.mjs server.mjs index.html README.md ./
COPY src ./src
RUN npm install --omit=dev
CMD ["npm", "start"]
