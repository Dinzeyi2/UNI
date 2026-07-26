FROM node:22-alpine
WORKDIR /app
COPY package.json production-server.mjs server.mjs intent-compiler.mjs behavior-schema.mjs index.html README.md ./
COPY src ./src
COPY db ./db
RUN npm install --omit=dev
CMD ["npm", "start"]
