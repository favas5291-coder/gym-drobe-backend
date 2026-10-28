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
  Product.find = query => {
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
