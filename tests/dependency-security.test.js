const { test } = require("node:test");
const assert = require("node:assert/strict");
const { fork } = require("node:child_process");
const { once } = require("node:events");
const { gzipSync } = require("node:zlib");
const http = require("node:http");
const vm = require("node:vm");
const path = require("node:path");

test("compressed trailing bytes cannot terminate the request-parser process", { timeout: 10000 }, async () => {
  const child = fork(path.join(__dirname, "helpers/dependencyServer.cjs"), [], { silent: true });
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += chunk; });
  try {
    const [{ port }] = await once(child, "message");
    const response = await fetch(`http://127.0.0.1:${port}/body`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Encoding": "gzip" },
      body: Buffer.concat([gzipSync('{"fixture":true}'), Buffer.from("invalid-trailing-frame")]),
      signal: AbortSignal.timeout(3000),
    }).catch(() => null); // Rejection of the malformed request is acceptable.
    await response?.arrayBuffer();
    // A subsequent real HTTP request proves the process still handles traffic.
    const health = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(3000) });
    assert.equal(health.status, 200, stderr);
    assert.deepEqual(await health.json(), { ok: true });
    assert.equal(child.exitCode, null, stderr);
  } finally {
    if (child.exitCode === null) {
      child.kill();
      await once(child, "exit");
    }
  }
});

test("cross-realm sensitive-header configuration survives a cross-origin redirect", { timeout: 10000 }, async () => {
  const redirectHttp = require(process.env.GYMDROBE_FIXTURE_REDIRECTS || "follow-redirects").http;
  let received;
  const target = http.createServer((req, res) => {
    received = req.headers;
    res.end("fixture target");
  });
  const source = http.createServer((_req, res) => {
    res.writeHead(302, { Location: `http://127.0.0.1:${target.address().port}/target` });
    res.end();
  });
  try {
    await new Promise(resolve => target.listen(0, "127.0.0.1", resolve));
    await new Promise(resolve => source.listen(0, "127.0.0.1", resolve));
    await new Promise((resolve, reject) => {
      const req = redirectHttp.get({
        hostname: "127.0.0.1", port: source.address().port, path: "/redirect",
        headers: { "X-Fixture-Secret": "fixture-only", "X-Fixture-Public": "preserve" },
        sensitiveHeaders: vm.runInNewContext("['X-Fixture-Secret']"),
      }, res => { res.resume(); res.on("end", resolve); });
      req.setTimeout(3000, () => req.destroy(new Error("Fixture redirect timeout")));
      req.on("error", reject);
    });
    assert.ok(received, "The redirect target must actually receive the request");
    assert.equal(received["x-fixture-secret"], undefined, "A cross-origin redirect must strip the configured credential");
    assert.equal(received["x-fixture-public"], "preserve");
  } finally {
    source.closeAllConnections(); target.closeAllConnections();
    await Promise.all([new Promise(resolve => source.close(resolve)), new Promise(resolve => target.close(resolve))]);
  }
});
