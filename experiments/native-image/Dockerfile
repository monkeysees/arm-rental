# syntax=docker/dockerfile:1.7
FROM rust:1.94.0-bookworm@sha256:365468470075493dc4583f47387001854321c5a8583ea9604b297e67f01c5a4f AS assemble
COPY curl-impersonate /usr/local/bin/curl-impersonate
COPY curl-licenses/ /licenses/curl-impersonate/
COPY replay /usr/local/bin/replay
COPY licenses/ /licenses/replay/
COPY components.json /components.json
COPY assemble /assemble
RUN bash /assemble /runtime
FROM scratch
LABEL org.opencontainers.image.title="arm-rental experimental minimal native service" \
      com.rental-apartments.experiment.runtime="rust"
COPY --from=assemble /runtime/ /
USER 1000:1000
WORKDIR /app
ENV CURL_IMPERSONATE_PATH=/usr/local/bin/curl-impersonate
ENTRYPOINT ["/usr/local/bin/replay"]
