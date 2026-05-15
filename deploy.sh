#!/usr/bin/env bash
set -e
git pull
podman compose build --no-cache capture web
podman compose up -d --force-recreate capture web
podman system prune -af
podman compose ps
