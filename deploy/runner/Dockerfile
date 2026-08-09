FROM node:24-alpine@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd

RUN apk add --no-cache ca-certificates docker-cli

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm audit --omit=dev --audit-level=moderate \
  && rm -rf /root/.npm /tmp/node-compile-cache

COPY src ./src
COPY tsconfig.json ./

ENV NODE_ENV=production
ENV RUNNER_PORT=48090
ARG GIT_SHA=
ENV GIT_SHA=$GIT_SHA
EXPOSE 48090

CMD ["node", "src/runner-main.ts"]
