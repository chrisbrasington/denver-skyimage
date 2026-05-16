#!/usr/bin/env bash
set -e
if [ "$(hostname)" = "valhalla" ]; then
  export APP_PORT=8001
  ENGINE=docker
  export ENGINE_SOCK_HOST=/var/run/docker.sock
  export ENGINE_SOCK_CONTAINER=/var/run/docker.sock
else
  ENGINE=podman
  export ENGINE_SOCK_HOST="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/podman/podman.sock"
  export ENGINE_SOCK_CONTAINER=/var/run/podman.sock
fi
git pull
$ENGINE compose build --no-cache capture web
$ENGINE compose up -d --force-recreate capture web
if [ "$(hostname)" != "valhalla" ]; then
  $ENGINE system prune -af
fi
$ENGINE compose ps
