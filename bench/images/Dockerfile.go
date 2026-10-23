# Generic Go task image for the bench rig. Build context: a task's environment/ dir with
#   src.tar.gz         the module snapshot
#   known-limits.md    rig facts (required by COPY; may be empty) for `/retro --known-limits` (see docs/bench.md)
# gofmt and go vet ship with the toolchain and work for the non-root agent user (checked);
# staticcheck and golangci-lint are not installed.
FROM golang:1.27

# bash and git come with the base image (Harbor needs bash; the agent can diff).
# pi-foreman needs Python 3.13+; the base image carries none.
COPY --from=ghcr.io/astral-sh/uv:0.13.5@sha256:32a7bb39b496babbd997b0a39a4d66c126bdaf5661b302bf6f06abda8deca6ff /uv /usr/local/bin/uv
RUN uv python install 3.13 --install-dir /opt/python \
    && ln -s "$(ls -d /opt/python/cpython-3.13*/bin/python3.13 | head -n 1)" /usr/local/bin/python3.13 \
    && python3.13 --version
ENV PI_FOREMAN_PYTHON=/usr/local/bin/python3.13

RUN git config --global user.name bench && git config --global user.email bench@example.invalid \
    && git config --global init.defaultBranch main

WORKDIR /app
COPY src.tar.gz /tmp/src.tar.gz
RUN tar xzf /tmp/src.tar.gz -C /app
COPY known-limits.md /opt/known-limits.md

# Module cache and build cache prefilled; no network is needed afterwards.
ENV GOTOOLCHAIN=local GOFLAGS=-buildvcs=false
RUN go mod download && go test -count=1 -run '^$' ./...
ENV GOPROXY=off GOSUMDB=off

# Fresh single-commit repo at the snapshot (no upstream history).
RUN git init -q && git add -A && git commit -q -m "snapshot" --author="bench <bench@example.invalid>"
