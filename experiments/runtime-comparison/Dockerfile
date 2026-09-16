# syntax=docker/dockerfile:1.7
# Build the existing production target as arm-rental-comparison-node:local first.
FROM arm-rental-comparison-node:local AS minimal
FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS assemble
ARG RUNTIME
COPY --from=minimal / /runtime/
COPY replay /usr/local/bin/replay
# The minimal production root already contains curl, certificates, licenses,
# resolver/account configuration and its native closure. Resolve the port's
# additional libraries against the same Debian generation.
RUN test "$RUNTIME" = go -o "$RUNTIME" = rust \
    && rm -rf /runtime/app /runtime/usr/local/bin/node /runtime/usr/local/LICENSE \
    && mkdir -p /runtime/app/.data \
    && cp /usr/local/bin/replay /runtime/usr/local/bin/replay \
    && ldd /usr/local/bin/replay > /tmp/libraries \
    && ! grep -q 'not found' /tmp/libraries \
    && awk '/=> \// {print $3} $1 ~ /^\// {print $1}' /tmp/libraries | \
       while IFS= read -r library; do cp --dereference --parents "$library" /runtime; done \
    && chown 1000:1000 /runtime/app/.data
COPY licenses/ /runtime/usr/local/share/licenses/replay/
FROM scratch
ARG RUNTIME
LABEL org.opencontainers.image.title="arm-rental experimental replay" \
      com.rental-apartments.experiment.runtime=$RUNTIME
COPY --from=assemble /runtime/ /
USER 1000:1000
WORKDIR /app
ENTRYPOINT ["/usr/local/bin/replay"]
