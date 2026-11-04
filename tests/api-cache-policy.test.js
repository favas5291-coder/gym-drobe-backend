const { test } = require("node:test");
const assert = require("node:assert/strict");
const { app } = require("../server");

test("actual API routes never cache auth, validation, webhook or not-found replies", { timeout: 10000 }, async () => {
  // Importing app does not boot the database or outbound workers. All private
  // requests below have no token and must fail before any customer lookup.
  const server = app.listen(0, "127.0.0.1");
  try {
    await new Promise(resolve => server.once("listening", resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    for (const route of ["/api/health", "/api/auth/me", "/api/addresses", "/api/orders", "/api/support", "/api/admin", "/api/unknown-cache-fixture"]) {
      const response = await fetch(origin + route, { signal: AbortSignal.timeout(2000) });
      await response.arrayBuffer();
      assert.equal(response.headers.get("cache-control"), "no-store", route);
      if (["/api/auth/me", "/api/addresses", "/api/orders"].includes(route)) assert.equal(response.status, 401, route);
    }
    for (const route of ["/api/addresses", "/api/payment-webhooks/razorpay"]) {
      const response = await fetch(origin + route, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: "{invalid-json", signal: AbortSignal.timeout(2000),
      });
      await response.arrayBuffer();
      assert.equal(response.headers.get("cache-control"), "no-store", route);
      assert.ok(response.status >= 400, "An invalid unauthenticated fixture must not mutate data");
    }
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
