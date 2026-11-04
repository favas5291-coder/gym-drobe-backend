// Real indexer + model + Mongo + HTTP contract, using a disposable loopback DB.
// Public catalogue photos only. No production DB, customer photos or paid provider.
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const mongoose = require('mongoose');
const express = require('express');
const Product = require('../../models/Product');
const Index = require('../../models/VisualSearchIndex');
const State = require('../../models/VisualSearchState');
const model = require('../../utils/visualSearch/model');
const { download } = require('../../utils/visualSearch/catalogueImage');
const { normalizeImage } = require('../../utils/visualSearch/image');
const { MODEL } = require('../../utils/visualSearch/domain');
let server, databaseCreated = false;
const checks = [];
(async () => {
  const uri = new URL(process.env.GYMDROBE_TEST_MONGO_URI || '');
  assert.equal(uri.protocol, 'mongodb:');
  assert.equal(uri.hostname, '127.0.0.1');
  assert.equal(uri.port, '27018');
  assert.ok(uri.pathname.startsWith('/gymdrobe_fixture_'));
  assert.equal(uri.username + uri.password, '');
  uri.pathname = '/gymdrobe_visual_fixture_' + randomUUID().replaceAll('-', '');
  Object.assign(process.env, {
    MONGO_URI: uri.href,
    VISUAL_SEARCH_ENABLED: 'true',
    VISUAL_SEARCH_THRESHOLD: '0.78',
    VISUAL_SEARCH_CATALOGUE_ORIGIN: 'https://www.gymdrobe.com',
    VISUAL_SEARCH_IMAGE_HOSTS: 'coitonic.com,cdn.shopify.com',
  });
  assert.ok(model.configured(), 'Provision the pinned local model first');
  await mongoose.connect(uri.href, { serverSelectionTimeoutMS: 10000 });
  databaseCreated = true;
  const tee = 'https://coitonic.com/cdn/shop/files/69_801024fe-72f0-492f-9565-7f2f03f7f186.jpg?v=1774514150&width=900';
  const bag = 'https://cdn.shopify.com/s/files/1/0657/8110/4808/files/1_0755bacb-ecd6-418e-8c9f-1b2b941b6b31.jpg?v=1763548558&width=960&height=1280&crop=center';
  const teeID = new mongoose.Types.ObjectId(), bagID = new mongoose.Types.ObjectId();
  const teeImages = [tee, tee.replace('width=900', 'width=600')];
  const colors = [{ color: 'Fixture black', images: [tee.replace('width=900', 'width=450')] }];
  // Raw insertion deliberately bypasses commercial publication validation in this fixture DB.
  await Product.collection.insertMany([
    { _id: teeID, name: 'Fixture tee', isActive: true, price: 799, discount: 0, stock: 4, image: tee, images: teeImages, colorImages: colors, purchaseCost: 123456 },
    { _id: bagID, name: 'Fixture bag', isActive: true, price: 649, discount: 0, stock: 3, image: bag, images: [bag], colorImages: [] },
  ]);
  function rebuild(overrides = {}, success = true) {
    const result = spawnSync(process.execPath, ['scripts/indexVisualSearch.cjs'], {
      cwd: path.resolve(__dirname, '../..'), env: { ...process.env, ...overrides }, timeout: 180000, encoding: 'utf8',
    });
    assert.equal(result.error, undefined, 'Indexer subprocess must finish within its deadline');
    success ? assert.equal(result.status, 0, 'Actual indexer must succeed') : assert.notEqual(result.status, 0, 'Unsafe or competing rebuild must fail');
  }
  rebuild();
  const state = await State.findById('catalogue').lean();
  assert.equal(state.model, MODEL);
  assert.equal(state.count, 4);
  assert.equal(await Index.countDocuments({ generation: state.generation }), 4);
  const vectors = await Index.find({ generation: state.generation }).lean();
  assert.ok(vectors.every(row => row.vector.length === 512 && row.vector.every(Number.isFinite)));
  checks.push('actual CLI indexes product and variant photos and publishes one complete Mongo generation');
  const bytes = await normalizeImage(await download(tee));
  const app = express();
  app.use('/api/visual-search', require('../../routes/visualSearchRoutes'));
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}/api/visual-search`;
  assert.equal((await (await fetch(endpoint + '/status')).json()).available, true);
  async function search(body = bytes) {
    const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body });
    return { response, data: await response.json() };
  }
  let result = await search();
  assert.equal(result.response.status, 200);
  assert.equal(result.response.headers.get('cache-control'), 'no-store');
  assert.equal(result.data.products[0].id, String(teeID));
  assert.equal(result.data.products.filter(p => p.id === String(teeID)).length, 1);
  assert.equal(result.data.products[0].matchType, 'visually-similar');
  assert.equal(result.data.products[0].purchaseCost, undefined);
  checks.push('HTTP photo search uses the real model, groups multiple images and exposes public product fields');
  await Product.collection.updateOne({ _id: teeID }, { $set: { price: 1099, stock: 2 } });
  result = await search();
  assert.equal(result.data.products[0].price, 1099);
  assert.equal(result.data.products[0].stock, 2);
  checks.push('current Mongo prices and stock replace indexed snapshots');
  await Product.collection.updateOne({ _id: teeID }, { $set: { isActive: false } });
  result = await search();
  assert.equal(result.data.products.some(p => p.id === String(teeID)), false);
  await Product.collection.updateOne({ _id: teeID }, { $set: { isActive: true, image: tee + '&changed=1', images: [], colorImages: [] } });
  result = await search();
  assert.equal(result.data.products.some(p => p.id === String(teeID)), false);
  checks.push('archived products and changed-image fingerprints cannot return stale matches');
  await Product.collection.updateMany({}, { $set: { isActive: false } });
  result = await search();
  assert.deepEqual(result.data.products, []);
  assert.equal(result.data.message, 'No close matches found. Try another photo or search by name.');
  assert.equal((await search(Buffer.from('invalid-image'))).response.status, 400);
  checks.push('empty catalogue matches and invalid decoded uploads fail honestly');
  await Product.collection.updateOne({ _id: teeID }, { $set: { isActive: true, image: tee, images: teeImages, colorImages: colors } });
  rebuild({ VISUAL_SEARCH_IMAGE_HOSTS: 'unapproved.example' }, false);
  assert.equal((await State.findById('catalogue').lean()).generation, state.generation);
  await State.updateOne({ _id: 'catalogue' }, { $set: { owner: 'fixture-lock', leaseUntil: new Date(Date.now() + 120000) } });
  rebuild({}, false);
  assert.equal((await State.findById('catalogue').lean()).generation, state.generation);
  await State.updateOne({ _id: 'catalogue', owner: 'fixture-lock' }, { $unset: { owner: '', leaseUntil: '' } });
  assert.equal(await Index.countDocuments({ generation: state.generation }), 4);
  checks.push('failed and concurrent rebuilds preserve the published generation; photo queries add no vectors');
  process.env.VISUAL_SEARCH_ENABLED = 'false';
  assert.equal((await (await fetch(endpoint + '/status')).json()).available, false);
  assert.equal((await search()).response.status, 503);
  checks.push('operator rollback disables status and query execution');
  console.log(JSON.stringify({ passed: checks.length, failed: 0, checks, database: 'disposable-loopback-only', inference: 'real-pinned-local-WASM', providerCalls: 0 }));
})().catch(error => {
  console.error('Visual-search integration failed:', error.message);
  process.exitCode = 1;
}).finally(async () => {
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  await model.close();
  if (databaseCreated) await mongoose.connection.db.dropDatabase();
  await mongoose.disconnect();
});
