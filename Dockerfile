# syntax=docker/dockerfile:1.7

ARG NODE_VERSION=24.18.0

# The digest pins the complete multi-platform Node image, including Debian.
FROM node:${NODE_VERSION}-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS production

ARG NODE_VERSION
ARG CHROME_VERSION=150.0.7871.124
ARG DEBIAN_SNAPSHOT=20260713T000000Z
ARG SOURCE_REVISION
ARG PACKAGE_LOCK_SHA256
ARG DEBIAN_FRONTEND=noninteractive

LABEL org.opencontainers.image.title="rental-apartments-bot" \
      org.opencontainers.image.revision="${SOURCE_REVISION}" \
      org.opencontainers.image.node.version="${NODE_VERSION}" \
      org.opencontainers.image.chrome.version="${CHROME_VERSION}" \
      org.opencontainers.image.package-lock.sha256="${PACKAGE_LOCK_SHA256}"

ENV NODE_ENV=production \
    BROWSER_HEADLESS=true \
    CHROME_EXECUTABLE_PATH=/opt/chrome/chrome/linux-${CHROME_VERSION}/chrome-linux64/chrome

WORKDIR /app

COPY package.json package-lock.json ./
RUN test "$(printf '%s' "${SOURCE_REVISION}" | wc -c)" -eq 40 \
    && printf '%s' "${SOURCE_REVISION}" | grep --quiet --extended-regexp '^[a-f0-9]+$' \
    && test "${PACKAGE_LOCK_SHA256}" = "$(sha256sum package-lock.json | cut -d ' ' -f 1)"
RUN npm ci --omit=dev && npm cache clean --force

# Chrome for Testing ships a deb.deps manifest. Installing it against a dated
# Debian snapshot makes both the exact browser and its shared libraries
# repeatable instead of relying on whatever Chrome happens to exist on a host.
RUN sed -i \
      -e "s|http://deb.debian.org/debian-security|http://snapshot.debian.org/archive/debian-security/${DEBIAN_SNAPSHOT}|g" \
      -e "s|http://deb.debian.org/debian|http://snapshot.debian.org/archive/debian/${DEBIAN_SNAPSHOT}|g" \
      -e '/^Signed-By:/a Check-Valid-Until: no' \
      /etc/apt/sources.list.d/debian.sources \
    && apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates unzip \
    && npx --no-install browsers install "chrome@${CHROME_VERSION}" \
      --path /opt/chrome \
      --install-deps \
    && CHROME_RUNTIME_VERSION="$("${CHROME_EXECUTABLE_PATH}" --version \
      | sed 's/[[:space:]]*$//')" \
    && printf '%s\n' "${CHROME_RUNTIME_VERSION}" \
    && { \
      test "${CHROME_RUNTIME_VERSION}" = "Google Chrome ${CHROME_VERSION}" \
        || test "${CHROME_RUNTIME_VERSION}" = \
          "Google Chrome for Testing ${CHROME_VERSION}"; \
    } \
    && chown root:root \
      "/opt/chrome/chrome/linux-${CHROME_VERSION}/chrome-linux64/chrome_sandbox" \
    && chmod 4755 \
      "/opt/chrome/chrome/linux-${CHROME_VERSION}/chrome-linux64/chrome_sandbox" \
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
