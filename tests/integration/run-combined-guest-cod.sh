#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
: "${MONGOD_BIN:?Set MONGOD_BIN to a local mongod executable.}"
fixture_dir=$(mktemp -d)
cleanup() {
  if [[ -s "$fixture_dir/daemon.pid" ]]; then
    local fixture_pid
    read -r fixture_pid < "$fixture_dir/daemon.pid" || true
    if [[ "$fixture_pid" =~ ^[0-9]+$ ]]; then
      kill -TERM "$fixture_pid" 2>/dev/null || true
      for ((i=0; i<80; i++)); do
        [[ ! -f "$fixture_dir/daemon.pid" ]] && break
        kill -0 "$fixture_pid" 2>/dev/null || break
        sleep 0.1
      done
    fi
  fi
  rm -rf -- "$fixture_dir"
}
trap cleanup EXIT
# Select an unused port. A bind collision between selection and startup fails the
# fork command below before replica initialization can touch an existing server.
port=$(node -e 'const s=require("node:net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')
"$MONGOD_BIN" --fork --bind_ip 127.0.0.1 --port "$port" --dbpath "$fixture_dir" --replSet rs0 \
  --nounixsocket --pidfilepath "$fixture_dir/daemon.pid" --logpath "$fixture_dir/mongo.log"
env -i PATH="$PATH" FIXTURE_PORT="$port" node - <<'JS'
const mongoose = require("mongoose");
(async () => {
  const host = "127.0.0.1:" + process.env.FIXTURE_PORT;
  const conn = await mongoose.createConnection("mongodb://" + host + "/admin?directConnection=true",
    { serverSelectionTimeoutMS: 8000 }).asPromise();
  try {
    await conn.db.admin().command({ replSetInitiate: { _id: "rs0", members: [{ _id: 0, host }] } });
    for (let i = 0; i < 100; i++) {
      if ((await conn.db.admin().command({ hello: 1 })).isWritablePrimary) return;
      await new Promise(resolve => setTimeout(resolve,100));
    }
    throw new Error("Fixture replica set did not become writable");
  } finally { await conn.close(); }
})().catch(error => {console.error(error); process.exitCode = 1;});
JS
env -i PATH="$PATH" GYMDROBE_TEST_MONGO_URI="mongodb://127.0.0.1:$port/gymdrobe_fixture_combined?replicaSet=rs0" \
  node tests/integration/combined-guest-cod.cjs
