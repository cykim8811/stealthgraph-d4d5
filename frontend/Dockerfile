FROM node:22-alpine AS deps
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

FROM node:22-alpine AS builder
RUN corepack enable
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# `output: "export"` in next.config.ts → static site in ./out
RUN pnpm build

FROM nginx:1.27-alpine AS runner
# Substitute these two variables and nothing else (so nginx's own
# $host / $proxy_add_x_forwarded_for / $scheme stay literal).
ENV NGINX_ENVSUBST_FILTER="BACKEND_URL|NGINX_RESOLVER"
COPY nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=builder /app/out /usr/share/nginx/html
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh
EXPOSE 80
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["nginx", "-g", "daemon off;"]
