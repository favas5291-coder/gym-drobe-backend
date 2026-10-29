const test = require("node:test");
const assert = require("node:assert/strict");
const initializeIndexes = require("../utils/initializeIndexes");
const { attachReviews } = require("../utils/productReviews");

test("required collections begin together and startup waits for all of them", async () => {
  const started = [];
  const release = [];
  let ready = false;
  const models = Array.from({ length: 7 }, (_, index) => ({
    createIndexes() {
      started.push(index);
      return new Promise((resolve) => { release[index] = resolve; });
    },
  }));
  const startup = initializeIndexes(models).then(() => { ready = true; });
  await Promise.resolve();
  assert.deepEqual(started, [0, 1, 2, 3, 4, 5, 6]);
  for (let index = 0; index < 6; index++) release[index]();
  await Promise.resolve();
  assert.equal(ready, false, "Do not serve traffic before the last index is ready");
  release[6]();
  await startup;
  assert.equal(ready, true);
});

test("a failed required index blocks startup after remaining operations settle", async () => {
  let finish;
  let rejected = false;
  const failure = new Error("index unavailable");
  const startup = initializeIndexes([
    { createIndexes() { throw failure; } },
    { createIndexes: () => new Promise((resolve) => { finish = resolve; }) },
  ]);
  const checked = assert.rejects(startup, (error) => {
    rejected = true;
    assert.equal(error, failure);
    return true;
  });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(rejected, false);
  finish();
  await checked;
});

test("empty catalogues do not need a reviews query", async () => {
  assert.deepEqual(await attachReviews([]), []);
});
