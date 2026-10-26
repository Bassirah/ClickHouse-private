# Server image with a locally built `clickhouse` binary, for example one that includes the web console.
# It reuses the official image of the same release for everything except the binary.
#
#   docker build -f utils/web-console/Dockerfile --build-arg BASE_IMAGE=clickhouse/clickhouse-server:26.9.8.3 \
#       -t clickhouse-server-console:26.9.8.3 <directory with the clickhouse binary>
ARG BASE_IMAGE=clickhouse/clickhouse-server:26.9.8.3
FROM ${BASE_IMAGE}
COPY --chmod=0555 clickhouse /usr/bin/clickhouse
