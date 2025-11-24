FROM node:18-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY ./app ./app

EXPOSE 3003

CMD ["node", "app/index.js"]
