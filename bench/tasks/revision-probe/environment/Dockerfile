FROM node:22-bookworm-slim
# Node is in the base image, so the bench agents skip the nvm download; python3 and git for the
# task code, the hidden tests and pi-foreman's Python core.
RUN apt-get update && apt-get install -y --no-install-recommends python3 git ca-certificates curl procps \
    && apt-get clean
WORKDIR /app
COPY compute.py /app/
RUN git init -q && git add -A && git -c user.name=bench -c user.email=bench@example.invalid commit -q -m "task start"
