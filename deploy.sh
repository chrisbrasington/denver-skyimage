#!/usr/bin/env bash
set -e
if [ "$(hostname)" = "valhalla" ]; then
  export APP_PORT=8001
  ENGINE=docker
  export CONTAINER_SOCK=/var/run/docker.sock
else
  ENGINE=podman
  export CONTAINER_SOCK="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/podman/podman.sock"
fi
git pull
$ENGINE compose build --no-cache capture web
$ENGINE compose up -d --force-recreate capture web
$ENGINE system prune -af
$ENGINE compose ps
