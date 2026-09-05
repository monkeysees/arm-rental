# syntax=docker/dockerfile:1.7

ARG NODE_VERSION=24.18.0

# The digest pins the complete multi-platform Node image, including Debian.
FROM node:${NODE_VERSION}-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS production

ARG NODE_VERSION
ARG CHROME_VERSION=152.0.7977.75
ARG CHROMIUM_PACKAGE_VERSION=152.0.7977.75-1~deb12u1
ARG DEBIAN_SNAPSHOT=20260904T011450Z
ARG SOURCE_REVISION
ARG PACKAGE_LOCK_SHA256
ARG DEBIAN_FRONTEND=noninteractive

LABEL org.opencontainers.image.title="rental-apartments-bot" \
      org.opencontainers.image.revision="${SOURCE_REVISION}" \
      com.rental-apartments.state.backend="sqlite" \
      com.rental-apartments.state.schema.minimum="1" \
      com.rental-apartments.state.schema.maximum="1" \
      org.opencontainers.image.node.version="${NODE_VERSION}" \
      org.opencontainers.image.chrome.version="${CHROME_VERSION}" \
      org.opencontainers.image.package-lock.sha256="${PACKAGE_LOCK_SHA256}"

ENV NODE_ENV=production \
    BROWSER_HEADLESS=true \
    CHROME_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app

COPY package.json package-lock.json ./
RUN test "$(printf '%s' "${SOURCE_REVISION}" | wc -c)" -eq 40 \
    && printf '%s' "${SOURCE_REVISION}" | grep --quiet --extended-regexp '^[a-f0-9]+$' \
    && test "${PACKAGE_LOCK_SHA256}" = "$(sha256sum package-lock.json | cut -d ' ' -f 1)"
RUN npm ci --omit=dev && npm cache clean --force

# Pin Chromium and its sandbox helper from a dated Debian snapshot so both the
# exact browser and its shared libraries are reproducible.
RUN sed -i \
      -e "s|http://deb.debian.org/debian-security|http://snapshot.debian.org/archive/debian-security/${DEBIAN_SNAPSHOT}|g" \
      -e "s|http://deb.debian.org/debian|http://snapshot.debian.org/archive/debian/${DEBIAN_SNAPSHOT}|g" \
      -e '/^Signed-By:/a Check-Valid-Until: no' \
      /etc/apt/sources.list.d/debian.sources \
    && apt-get update \
    && apt-get install --yes --no-install-recommends \
      ca-certificates \
      "chromium=${CHROMIUM_PACKAGE_VERSION}" \
      "chromium-sandbox=${CHROMIUM_PACKAGE_VERSION}" \
    && test "${CHROMIUM_PACKAGE_VERSION%%-*}" = "${CHROME_VERSION}" \
    && test "$(dpkg-query --show --showformat='${Version}' chromium)" = \
      "${CHROMIUM_PACKAGE_VERSION}" \
    && test "$(dpkg-query --show --showformat='${Version}' chromium-sandbox)" = \
      "${CHROMIUM_PACKAGE_VERSION}" \
    && test "$(stat -c '%U:%G:%a' /usr/lib/chromium/chrome-sandbox)" = \
      "root:root:4755" \
    && rm -rf \
      /var/lib/apt/lists/* \
      /usr/local/lib/node_modules/npm \
      /usr/local/lib/node_modules/corepack \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack

COPY --chown=node:node src ./src
RUN install -d -o node -g node -m 0700 /app/.data

USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=2 \
  CMD ["node", "src/health-check.js", "--restart-unresponsive"]

CMD ["node", "src/index.js"]
