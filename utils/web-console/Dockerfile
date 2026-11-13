# Server image with a locally built `clickhouse` binary, for example one that includes the web console.
# It reuses the official image of the same release for everything except the binary.
#
#   docker build -f utils/web-console/Dockerfile --build-arg BASE_IMAGE=clickhouse/clickhouse-server:26.10.2.103 \
#       -t clickhouse-server-console:26.10.2.103 <directory with the clickhouse binary>
#
# package_images.sh builds it with the version and revision, and packages it for distribution.
ARG BASE_IMAGE=clickhouse/clickhouse-server:26.10.2.103
FROM ${BASE_IMAGE}
ARG VERSION=dev
ARG REVISION=unknown
LABEL org.opencontainers.image.title="ClickHouse server with the web console" \
      org.opencontainers.image.description="ClickHouse server with the unified web console at /console" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}" \
      org.opencontainers.image.licenses="Apache-2.0"
COPY --chmod=0555 clickhouse /usr/bin/clickhouse
