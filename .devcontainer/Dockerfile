FROM mcr.microsoft.com/vscode/devcontainers/javascript-node:1-22-bookworm

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*
