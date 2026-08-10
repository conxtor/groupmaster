FROM node:20-alpine
WORKDIR /app
COPY . .
RUN npm install --ignore-scripts
RUN npm run build --workspace=@wagi/contracts && npm run build --workspace=@wagi/connector-sdk && npm run build --workspace=@wagi/wa-connector
EXPOSE 3001
CMD ["npm", "run", "start", "--workspace=@wagi/wa-connector"]
