# agy-gateway: LAN HTTP gateway wrapping the headless `agy` CLI.
#
# Unlike opencode/claude (npm-installable, version-pinned), agy was never
# freshly installed here — the binary was copied from the LXC this replaces
# (build-context/agy, itself originally copied from plex-watcher — see
# README.md "agy bootstrap"), since there's no public package for it. agy
# self-updates on use, so there is no version to pin anyway.
#
# Auth/state (~/.gemini, 612MB — conversation cache, brain, crash logs, the
# actual OAuth token buried in there) is NOT baked in or Secret-mounted
# (612MB is far past a k8s Secret's practical size) — it's a hostPath volume
# on the target node instead, copied there directly via the same tar-pipe
# pattern README.md documents for LXC-to-LXC transfer, just targeting a k3s
# node this time. See repos/k3s-cluster/agy-gateway/deployment.yaml.
FROM node:22-bookworm-slim

WORKDIR /opt/gateway
COPY build-context/agy /usr/local/bin/agy
RUN chmod +x /usr/local/bin/agy
COPY package.json ./
COPY server.js ./
COPY src ./src

ENV HOME=/root
EXPOSE 8100

CMD ["node", "server.js"]
