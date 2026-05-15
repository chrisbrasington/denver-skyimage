#!/usr/bin/env bash
set -e
git pull
podman compose build --no-cache
podman compose up -d --force-recreate
podman compose ps
