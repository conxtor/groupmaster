FROM node:20-alpine
WORKDIR /app
COPY . .
RUN npm install --ignore-scripts
RUN npm run build --workspace=@wagi/contracts && npm run build --workspace=@wagi/tg-connector
EXPOSE 3002
CMD ["npm", "run", "start", "--workspace=@wagi/tg-connector"]
