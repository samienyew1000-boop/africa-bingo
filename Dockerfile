FROM node:18-alpine
WORKDIR /app
RUN apk add --no-cache python3 py3-pip
COPY . .
RUN pip install --no-cache-dir --break-system-packages -r requirements.txt || true
ENV PORT=3000
EXPOSE 3000
CMD ["node", "server.js"]

