FROM node:22-bookworm-slim
# Node is in the base image, so the bench agents skip the nvm download; python3 and git for the
# task code, the hidden tests and pi-foreman's Python core.
RUN apt-get update && apt-get install -y --no-install-recommends python3 git ca-certificates curl procps \
    && apt-get clean
# pi-foreman needs Python 3.13+; the apt python3 (3.11) stays for the task verifiers.
COPY --from=ghcr.io/astral-sh/uv:0.13.5@sha256:32a7bb39b496babbd997b0a39a4d66c126bdaf5661b302bf6f06abda8deca6ff /uv /usr/local/bin/uv
RUN uv python install 3.13 --install-dir /opt/python \
    && ln -s "$(ls -d /opt/python/cpython-3.13*/bin/python3.13 | head -n 1)" /usr/local/bin/python3.13 \
    && python3.13 --version
ENV PI_FOREMAN_PYTHON=/usr/local/bin/python3.13
WORKDIR /app
COPY compute.py /app/
RUN git init -q && git add -A && git -c user.name=bench -c user.email=bench@example.invalid commit -q -m "task start"
