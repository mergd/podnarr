FROM oven/bun:1.3.11

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json bun.lock* tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/package.json
COPY ui/package.json ui/package.json
COPY workers/api/package.json workers/api/package.json
COPY workers/processor/package.json workers/processor/package.json
COPY packages/shared/src packages/shared/src
COPY services/audio/package.json services/audio/package.json
COPY services/audio/src services/audio/src
COPY services/audio/tsconfig.json services/audio/tsconfig.json

RUN bun install --frozen-lockfile || bun install

CMD ["bun", "run", "--cwd", "services/audio", "start"]
