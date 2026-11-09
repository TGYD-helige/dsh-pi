# Clean-room image for the upstream compatibility gate.
#
#   docker build -f scripts/compat/Dockerfile -t dsh-pi-compat .
#   docker run --rm dsh-pi-compat --host-spec latest
#
# The gate installs its own DSH CLI, npm cache, and pnpm store inside the container, so the
# only thing baked in is the runtime and this checkout.
ARG NODE_VERSION=22.19.0
FROM node:${NODE_VERSION}-bookworm-slim

RUN corepack enable && corepack prepare pnpm@10.28.2 --activate

WORKDIR /work
COPY . /work

ENTRYPOINT ["bash", "scripts/clean-install-smoke.sh"]
