const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { inspectProduct } = require("../utils/catalogueQuality");
const { run } = require("../scripts/catalogue-quality.cjs");

const valid = { price: 20, brand: "Fixture", stock: 2, stockStatus: "low-stock", image: "/photos/bag.webp" };
const inspect = changes => inspectProduct({ ...valid, ...changes }, 1);

test("ordinary, sold out, explicit zero and legacy colour-only quantities remain valid", () => {
  for (const change of [{}, {stock: 0, stockStatus:"out-of-stock"}, {colors:["Green"], variants:{Green:"2"}},
    {colors:["Blue","Red"], sizes:["M"], variants:{Blue:{M:2}, Red:{M:0}}}]) {
    assert.deepEqual(inspect(change).issues, []);
  }
  assert.deepEqual(inspect({colors:["Blue"], variants:{Yellow:2}}).issues, ["INVENTORY_INVALID"]);
  assert.deepEqual(inspect({stock:-1}).issues, ["INVENTORY_INVALID"]);
  assert.deepEqual(inspect({sizes:["M","L"], variants:{M:4}, stockStatus:"out-of-stock"}).issues,
    ["SPARSE_STOCK_MATRIX","TOTAL_STOCK_MISMATCH","STOCK_STATUS_MISMATCH"]);
});

test("public price rules cover whole rupees and variant paise, including sparse marketplace selections", () => {
  const row = { size:"M", color:null, customerUnitAmount:2000, mrpUnitAmount:2200 };
  const market = { sizes:["M","L"], variants:{ M:2 }, variantPrices:[row], hasMarketplaceListing:true };
  assert.deepEqual(inspect(market).issues, []);
  assert.deepEqual(inspect({...market, variantPrices:[]}).issues, ["VARIANT_PRICES_MISSING"]);
  assert.deepEqual(inspect({...market, stock:3, variants:{M:2,L:1}}).issues, ["IN_STOCK_VARIANT_WITHOUT_PRICE"]);
  assert.deepEqual(inspect({...market, variantPrices:[row,row]}).issues, ["VARIANT_PRICE_SELECTION"]);
  assert.deepEqual(inspect({...market, variantPrices:[{...row,mrpUnitAmount:1900}]}).issues, ["VARIANT_PRICES_INVALID"]);
  assert.deepEqual(inspect({...market,price:22}).issues, ["BASE_VARIANT_PRICE_MISMATCH"]);
  assert.deepEqual(inspect({discount:100}).issues, ["ZERO_SELLING_PRICE"]);
  assert.deepEqual(inspect({price:" ",discount:101}).issues, ["PRICE_INVALID","DISCOUNT_INVALID"]);
});

test("photo rules honour gallery fallbacks and report invalid assigned colours", () => {
  assert.deepEqual(inspect({ image:"", images:["/photos/backup.jpg"] }).issues, []);
  assert.deepEqual(inspect({ image:"", colorImages:[{color:"Orange",images:["/orange.webp"]}] }).issues,
    ["COLOUR_GALLERY_INVALID","DEFAULT_PHOTO_MISSING"]);
  assert.deepEqual(inspect({ image:"file:///photos/bag.jpg" }).issues, ["PRODUCT_PHOTO_INVALID","DEFAULT_PHOTO_MISSING"]);
});

test("brand evidence uses explicit public fields and ignores suppliers, titles and manufacturer names", () => {
  assert.deepEqual(inspect({name:"Rival running shorts", brand:"Fixture", specifications:{Brand:" FIXTURE ", Manufacturer:"Rival"}}).issues, []);
  const source = { ...valid, _id:"f".repeat(24), brand:"Fixture",
    specifications:{"Brand name":"Other fixture",Manufacturer:"private-marker"}, supplier:"private-marker",
    reviews:[{name:"private-marker"}], purchaseCost:123, meeshoProductLink:"private-marker" };
  const before = structuredClone(source);
  const answer=inspectProduct(source,7);
  assert.deepEqual(source,before);
  assert.deepEqual(answer,{id:source._id,position:7, issues:["EXPLICIT_BRAND_CONFLICT"],
    brandEvidence:{brand:"Fixture",conflictingFields:[{field:"specifications.Brand name",value:"Other fixture"}]}});
  assert.ok(!JSON.stringify(answer).includes("private-marker"));
  assert.deepEqual(inspect({ brand:"",specifications:{Brand:"Other fixture"} }).issues, ["BRAND_MISSING"]);
});

test("fixture/file are explicit, bounded, and independent of any database", async () => {
  const fixture = await run(["--fixture"]);
  assert.equal(fixture.scanned,2);
  assert.equal(fixture.withFindings,1);
  assert.equal(fixture.counts.EXPLICIT_BRAND_CONFLICT,1);
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(),"catalogue-quality-"));
  const filename=path.join(tmp,"input.json");
  try {
    await fs.writeFile(filename, JSON.stringify([valid]));
    assert.deepEqual(await run(["--file",filename]),{source:"file",scanned:1,withFindings:0,counts:{},findings:[],nextCursor:null});
    await fs.writeFile(filename, '{"success":false,"products":[]}');
    await assert.rejects(run(["--file",filename]), /unsuccessful catalogue response/);
    await fs.writeFile(filename, JSON.stringify(Array(251).fill(valid)));
    await assert.rejects(run(["--file",filename]), /250 records/);
    await fs.writeFile(filename,Buffer.alloc(4*1024*1024+1));
    await assert.rejects(run(["--file",filename]), /4 MiB/);
    for(const args of [[],["--mongo"],["--mongo","--limit","101"],["--mongo","--limit","1","--after","invalid"]]) {
      await assert.rejects(run(args), /Use --fixture/);
    }
  } finally { await fs.rm(tmp,{recursive:true,force:true}); }
});
