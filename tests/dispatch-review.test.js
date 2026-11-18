"use strict";
const {test} = require("node:test");
const assert = require("node:assert/strict");
const D = require("../utils/marketplace/domain");
const {reviewGroup} = require("../utils/marketplace/dispatchReview");
const fixture = require("./fixtures/marketplace-data.cjs").terms;
const clock = "elapsed-days-from-payment-verification";
const terms = D.terms({...fixture,dispatchClock:clock});
const item = {quantity:2,marketplace:{accountId:"supplier-a",terms,termsDigest:D.digest(terms)}};
const group = {_id:"g",order:"o",supplier:"supplier-a",status:"accepted",itemIndices:[0]};
const verifiedAt = new Date("2024-04-05T23:59:00Z");
const due = new Date(verifiedAt.getTime() + fixture.dispatchDaysMax * 86400000);
const order = {items:[item],status:"confirmed",payment:{status:"partially-paid",verifiedAt}};

test("contract dispatch clock is explicit and digested with accepted terms",()=>{
  const old = D.terms(fixture);
  assert.equal(Object.hasOwn(old,"dispatchClock"),false);
  assert.notEqual(D.digest(old),D.digest(terms));
  assert.throws(()=>D.terms({...fixture,dispatchClock:"business days"}));
});
test("purchased maximum, verified payment and strict deadline determine overdue status",()=>{
  assert.equal(reviewGroup(group,order,due).timing,"within-window");
  const late = reviewGroup(group,order,new Date(+due + 1));
  assert.equal(late.timing,"overdue");
  assert.equal(late.dueAt,due.toISOString());
  assert.equal(reviewGroup(group,{...order,status:"cancelled"},due),null);
  assert.equal(reviewGroup(group,{...order,payment:{status:"pending"}},due),null);
});
test("ambiguous clocks, future evidence, bad snapshots and mismatched ownership stay unknown",()=>{
  const absent = D.terms(fixture);
  for (const next of [
    {...order,payment:{status:"paid"}}, {...order,payment:{status:"paid",verifiedAt:new Date(+due+1)}},
    {...order,items:[{...item,marketplace:{...item.marketplace,terms:absent,termsDigest:D.digest(absent)}}]},
    {...order,items:[{...item,marketplace:{...item.marketplace,accountId:"supplier-b"}}]},
    {...order,items:[{...item,marketplace:{...item.marketplace,termsDigest:"invalid"}}]},
  ]) assert.equal(reviewGroup(group,next,due).timing,"unknown");
});
test("partial and completed line cancellations and mixed coverage do not generate false breaches",()=>{
  const cancellation = quantity => [{kind:"cancellation",itemIndex:0,quantity}];
  assert.equal(reviewGroup(group,{...order,marketplaceResolutions:cancellation(2)},due),null);
  assert.equal(reviewGroup(group,{...order,marketplaceResolutions:cancellation(3)},due).timing,"unknown");
  assert.equal(reviewGroup(group,{...order,marketplaceResolutions:cancellation(1)},due).timing,"within-window");
  const mixed = {...order,items:[item,{quantity:1}]};
  const two = {...group,itemIndices:[0,1]};
  assert.equal(reviewGroup(two,mixed,due).timing,"unknown");
  assert.equal(reviewGroup(two,mixed,new Date(+due+1)).timing,"overdue");
  assert.equal(reviewGroup(two,mixed,new Date(+due+1)).unknownItems,1);
});
