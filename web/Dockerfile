FROM node:20-slim

WORKDIR /app

COPY package*.json ./

# --legacy-peer-deps：@vitejs/plugin-basic-ssl@2.3.0 宣告需要 vite 6+，
# 本專案用 vite 4（實際可共存），不加會直接 ERESOLVE 失敗
RUN npm install --legacy-peer-deps

COPY . .

EXPOSE 5173

CMD ["npm", "run", "dev"]