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

# `agy` is a Go binary, and Go reads the *system* CA store — but the -slim
# base ships no CA bundle at all (Node carries its own, which is why every
# bit of this gateway's JS worked while agy's TLS silently failed with
# `x509: certificate signed by unknown authority`). That broke agy's OAuth
# token exchange AND its background token refresh, so a working credential
# copied in would expire an hour later and never renew. Do not drop this.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/gateway
COPY build-context/agy /usr/local/bin/agy
RUN chmod +x /usr/local/bin/agy
COPY package.json ./
COPY server.js ./
COPY src ./src

ENV HOME=/root
EXPOSE 8100

CMD ["node", "server.js"]
