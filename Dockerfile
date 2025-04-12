FROM node:18-bookworm-slim

RUN apt-get update && apt-get install -y \
  build-essential \
  clang \
  python3 \
  python3-pip \
  libstdc++6 \
  libgcc1 \
  git \
  ca-certificates \
  curl \
  && apt-get clean

WORKDIR /usr/src/app

COPY package*.json ./

# --build-from-source 옵션 꼭 필요
RUN npm install --build-from-source --verbose

COPY . .

RUN npm run build

EXPOSE 4000

CMD ["node", "dist/server.js"]
