#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
# Docker allocates a fresh container and anonymous volumes. Never target an existing database.
container=$(docker run -d --network none mongo:8.0)
trap 'docker rm -fv "$container" > /dev/null' EXIT
ready=false
for ((attempt=0; attempt<60; attempt++)); do
  if docker exec "$container" mongosh --quiet --eval 'quit(db.adminCommand({ping:1}).ok ? 0 : 1)' > /dev/null 2>&1; then
    ready=true
    break
  fi
  sleep 1
done
if [[ $ready != true ]]; then echo 'Fixture MongoDB did not start' >&2; exit 1; fi
docker cp seed.js "$container:/tmp/seed.js"
docker cp verify.js "$container:/tmp/verify.js"
docker exec "$container" mongosh --quiet /tmp/seed.js
docker exec "$container" mongodump --db gd_fixture_backup --archive=/tmp/gd.archive --gzip --quiet
start=$SECONDS
docker exec "$container" mongorestore --archive=/tmp/gd.archive --gzip --stopOnError --quiet \
  --nsInclude='gd_fixture_backup.*' --nsFrom='gd_fixture_backup.*' --nsTo='gd_fixture_restored.*'
docker exec "$container" mongosh --quiet /tmp/verify.js
echo "Restore and verification elapsed seconds: $((SECONDS-start))"
