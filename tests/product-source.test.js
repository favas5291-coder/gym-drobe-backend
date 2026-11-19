const test = require("node:test");
const assert = require("node:assert/strict");
const { suggestions, publicAddress } = require("../utils/productSource");
const { draft } = require("../utils/marketplace/domain");

test("metadata preserves range and currency and derives no local stock", () => {
  const listing = { "@type": "Product", name: "Shaker", image: "/shaker.jpg", offers: { lowPrice: "499", highPrice: "599", priceCurrency: "INR", availability: "InStock" } };
  const result = suggestions('<script type="application/ld+json">'+JSON.stringify(listing)+'</script>', "https://example.org/item");
  assert.deepEqual(result, { name:"Shaker", category:"", images:["https://example.org/shaker.jpg"], currency:"INR", low:499, high:599 });
});
test("network filter excludes nonpublic and reserved addresses", () => {
  for (const address of ["127.0.0.1","169.254.1.1","192.168.1.3","10.0.0.1","198.18.1.1","100.64.0.1","::1"]) assert.equal(publicAddress(address),false);
});
test("an accessory can enter review before fulfilment is confirmed", () => {
  const item={name:"Shaker",category:"Accessories",brand:"GymDrobe",images:["https://example.org/image.jpg"],variants:[{supplierUnitAmount:49900,stock:0,supplierSku:"fixture"}]};
  const review=draft(item,"submission");
  assert.equal(review.variants[0].stock,0);
  assert.throws(()=>draft(review,true));
  assert.equal(draft({...review,weightGrams:200,dimensionsCm:{length:10,width:10,height:20},returnsEligible:"no",returnConditions:"Final sale"},true).weightGrams,200);
});
