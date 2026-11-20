const test = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("node:events");
const jwt = require("jsonwebtoken");
const User = require("../models/User");
const { app } = require("../server");

test("mounted staff customer reads supply the dashboard contract and preserve last-page pagination", async (t) => {
  const adminId = "507f1f77bcf86cd799439010";
  const customer = { _id: "507f1f77bcf86cd799439011", role: "customer", name: "Fixture Buyer", email: "buyer@example.test", isActive: true };
  const secret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = "local-customer-route-test";
  t.after(() => {
    if (secret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = secret;
  });
  t.mock.method(User, "findById", id => ({ select: async () => id === adminId ? { _id: adminId, role: "admin" } : customer }));
  t.mock.method(User, "aggregate", pipeline => ({
    option: async () => {
      const last = pipeline.at(-1);
      if (last.$group) return [{ total: 1, blocked: 0, new30Days: 1 }];
      if (last.$facet) return [{ total: [{ value: 1 }], rows: [] }];
      assert.deepEqual(pipeline.at(-2), { $skip: 0 });
      return [customer];
    },
  }));
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = "http://127.0.0.1:" + server.address().port + "/api/admin/customers";
  const auth = id => ({ headers: { Authorization: "Bearer " + jwt.sign({ userId: id }, process.env.JWT_SECRET) } });

  const response = await fetch(base + "?page=3&limit=1", auth(adminId));
  assert.equal(response.status, 200);
  assert.match(response.headers.get("cache-control"), /no-store/);
  const list = await response.json();
  assert.deepEqual(list.stats, { total: 1, active: 1, blocked: 0, new30Days: 1 });
  assert.equal(list.page, 1);
  assert.equal(list.customers[0].id, customer._id);
  assert.equal((await fetch(base + "/invalid", auth(adminId))).status, 400);
  assert.equal((await fetch(base, auth(customer._id))).status, 403);
  assert.equal((await fetch(base + "/" + customer._id)).status, 401);
});
