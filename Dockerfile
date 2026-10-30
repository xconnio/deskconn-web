FROM --platform=$BUILDPLATFORM node:22-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN apk add --no-cache git && npm ci

COPY . .

ARG VITE_REGISTRATION_PRIVATE_KEY
ENV VITE_REGISTRATION_PRIVATE_KEY=$VITE_REGISTRATION_PRIVATE_KEY

RUN npm run build

FROM nginx:alpine-slim

COPY --from=builder /app/dist /usr/share/nginx/html/app

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY docker-entrypoint.sh /docker-entrypoint.sh

EXPOSE 80

ENTRYPOINT ["/docker-entrypoint.sh"]
CMD ["nginx", "-g", "daemon off;"]
