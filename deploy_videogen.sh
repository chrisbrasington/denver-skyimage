#!/usr/bin/env bash
set -e
git pull
podman compose build --no-cache videogen
podman compose up -d --force-recreate videogen
podman compose ps
