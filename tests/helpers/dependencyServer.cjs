// Disposable loopback process: a decompression crash must fail the parent test,
// never a production server or the test runner itself.
const express = require(process.env.GYMDROBE_FIXTURE_EXPRESS || "express");
if (!process.send) throw new Error("Run only as an isolated IPC test fixture");
const app = express();
app.use(express.json({ limit: "1mb" }));
app.post("/body", (_req, res) => res.json({ ok: true }));
app.get("/health", (_req, res) => res.json({ ok: true }));
app.use((_error, _req, res, _next) => res.status(400).json({ error: "Invalid fixture body" }));
const server = app.listen(0, "127.0.0.1", () => process.send({ port: server.address().port }));
process.on("message", message => {
  if (message === "stop") server.close(() => process.exit(0));
});
