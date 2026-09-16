# syntax=docker/dockerfile:1.7

ARG NODE_VERSION=24.18.0

# The digest pins the complete multi-platform Node image, including Debian.
FROM node:${NODE_VERSION}-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS build

ARG NODE_VERSION
ARG CURL_IMPERSONATE_VERSION=2.2.2
ARG TARGETARCH
ARG DEBIAN_SNAPSHOT=20260905T234553Z
ARG SOURCE_REVISION
ARG PACKAGE_LOCK_SHA256
ARG DEBIAN_FRONTEND=noninteractive

WORKDIR /app

COPY package.json package-lock.json ./
RUN test "$(printf '%s' "${SOURCE_REVISION}" | wc -c)" -eq 40 \
    && printf '%s' "${SOURCE_REVISION}" | grep --quiet --extended-regexp '^[a-f0-9]+$' \
    && test "${PACKAGE_LOCK_SHA256}" = "$(sha256sum package-lock.json | cut -d ' ' -f 1)"
RUN npm ci --omit=dev && npm cache clean --force

# Build-time installation verifies the release archive checksum and retains licenses.
COPY scripts/install-curl-impersonate scripts/curl-impersonate-version /tmp/curl-install/
RUN sed -i \
      -e "s|http://deb.debian.org/debian-security|http://snapshot.debian.org/archive/debian-security/${DEBIAN_SNAPSHOT}|g" \
      -e "s|http://deb.debian.org/debian|http://snapshot.debian.org/archive/debian/${DEBIAN_SNAPSHOT}|g" \
      -e '/^Signed-By:/a Check-Valid-Until: no' \
      /etc/apt/sources.list.d/debian.sources \
    && apt-get update \
    && apt-get install --yes --no-install-recommends \
      ca-certificates curl libpcre2-8-0=10.42-1+deb12u1 \
    && test "${CURL_IMPERSONATE_VERSION}" = "$(. /tmp/curl-install/curl-impersonate-version; printf '%s' "$CURL_IMPERSONATE_VERSION")" \
    && /tmp/curl-install/install-curl-impersonate /usr/local "${TARGETARCH}"

COPY scripts/assemble-runtime-root /tmp/assemble-runtime-root
RUN /tmp/assemble-runtime-root /runtime

FROM scratch AS production

ARG NODE_VERSION
ARG CURL_IMPERSONATE_VERSION=2.2.2
ARG SOURCE_REVISION
ARG PACKAGE_LOCK_SHA256

LABEL org.opencontainers.image.title="rental-apartments-bot" \
      org.opencontainers.image.revision="${SOURCE_REVISION}" \
      com.rental-apartments.state.backend="sqlite" \
      com.rental-apartments.state.schema.minimum="1" \
      com.rental-apartments.state.schema.maximum="4" \
      org.opencontainers.image.node.version="${NODE_VERSION}" \
      org.opencontainers.image.curl-impersonate.version="${CURL_IMPERSONATE_VERSION}" \
      org.opencontainers.image.package-lock.sha256="${PACKAGE_LOCK_SHA256}"

ENV NODE_ENV=production \
    PATH=/usr/local/bin \
    CURL_IMPERSONATE_PATH=/usr/local/bin/curl-impersonate \
    SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt

COPY --from=build /runtime/ /
WORKDIR /app
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --chown=node:node src ./src

USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=2 \
  CMD ["node", "src/health-check.js", "--restart-unresponsive"]

CMD ["node", "src/index.js"]
