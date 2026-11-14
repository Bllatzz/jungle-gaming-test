FROM oven/bun:1.3
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY tsconfig.json ./
COPY src ./src
USER bun
EXPOSE 3000
# Direto, sem "bun run": o script cria um processo filho e o SIGTERM vira crash (exit 139).
CMD ["bun", "src/main.ts"]
