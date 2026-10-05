FROM mcr.microsoft.com/playwright:v1.59.1-jammy

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production
ENV WEB_PROMPTS=1
ENV HEADLESS=1
ENV DATA_DIR=/data
ENV CONFIG_PATH=/data/config.json
ENV TSHIRT_TEMPLATE_PATH=/data/tshirt-template.png
ENV PORT=3000

RUN mkdir -p /data assets

EXPOSE 3000

CMD ["node", "server/index.js"]
