const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const Product = require("../models/Product");
const Review = require("../models/Review");
const { getProducts } = require("../middleware/controllers/productController");

test("public catalogue uses lean read and excludes confidential product fields", async () => {
  const originalFind = Product.find;
  const originalReviewFind = Review.find;
  const id = new mongoose.Types.ObjectId();
  let leanCalls = 0;
  let response = null;
  let cacheHeader = "";
  Product.find = (query, projection) => {
    assert.match(projection, /-marketplaceCommercial/);
    assert.match(projection, /-purchaseCost/);
    assert.deepEqual(query, {isActive:true});
    return { lean: async () => {
      leanCalls++;
      return [{_id:id,name:"Gym T-Shirt",isActive:true,stock:5,price:950,
        delivery:{available:true},supplier:new mongoose.Types.ObjectId(),
        purchaseCost:200,fulfillment:{stockSource:"supplier"},meeshoProductLink:"https://example.org/private"}];
    }};
  };
  Review.find = query => {
    assert.equal(String(query.product.$in[0]),String(id));
    return { sort: () => ({lean: async()=>[]}) };
  };
  try {
    await getProducts({},{
      set(name,value){if(name==="Cache-Control") cacheHeader=value;},
      json(body){response=body;return this;}
    });
    assert.equal(leanCalls,1);
    assert.equal(cacheHeader,"no-store","Live stock and prices must not be cached publicly");
    assert.equal(response.success,true);
    assert.equal(response.count,1);
    assert.equal(response.products[0].id,String(id));
    assert.equal(response.products[0].price,950);
    assert.equal(response.products[0].stock,5);
    assert.equal(response.products[0].supplier,undefined);
    assert.equal(response.products[0].purchaseCost,undefined);
    assert.equal(response.products[0].fulfillment,undefined);
    assert.equal(response.products[0].meeshoProductLink,undefined);
  } finally {
    Product.find=originalFind;
    Review.find=originalReviewFind;
  }
});

test("overlapping public pages share one bounded read and later visits read fresh stock", async () => {
  const find = Product.find, reviews = Review.find;
  let reads = 0;
  const rows = Array.from({length:3}, (_,n)=>({_id:new mongoose.Types.ObjectId(),name:"Fixture "+n,stock:n+1}));
  const bodies = [];
  const res = () => ({set(){},json(body){bodies.push(body);},status(){return this;}});
  Product.find = filter => {
    reads++;
    assert.equal(filter.isActive,true);
    return {sort(sort){assert.deepEqual(sort,{_id:1});return this;},limit(limit){assert.equal(limit,3);return this;},async lean(){return rows;}};
  };
  Review.find = () => ({sort:()=>({lean:async()=>[]})});
  try {
    const req = {query:{view:"page",limit:"2"}};
    await Promise.all([getProducts(req,res()),getProducts(req,res())]);
    assert.equal(reads,1); assert.equal(bodies[0].count,2); assert.equal(bodies[0].nextCursor,String(rows[1]._id));
    rows[0].stock=0;
    await getProducts(req,res());assert.equal(reads,2);assert.equal(bodies[2].products[0].stock,0);
    await getProducts({query:{view:"page",after:"invalid"}},res());assert.equal(reads,2);assert.equal(bodies.at(-1).success,false);
  } finally {Product.find=find;Review.find=reviews;}
});
