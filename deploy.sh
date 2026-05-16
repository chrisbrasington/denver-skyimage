#!/usr/bin/env bash
set -e
if [ "$(hostname)" = "valhalla" ]; then
  export APP_PORT=8001
  ENGINE=docker
else
  ENGINE=podman
fi
git pull
$ENGINE compose build --no-cache capture web
$ENGINE compose up -d --force-recreate capture web
$ENGINE system prune -af
$ENGINE compose ps
