const { test } = require("node:test");
const assert = require("node:assert/strict");
const { quoteParcel } = require("../utils/logistics/shiprocketRates");
const parcel = { pickupPincode:"673001", deliveryPincode:"560001", weightGrams:500, lengthMm:200,
  widthMm:140, heightMm:100, payment:"cod", declaredValuePaise:55000 };
const env = { SHIPROCKET_QUOTE_TOKEN:"fixture-token", SHIPROCKET_QUOTE_ENABLED:"true" };
const row = {courier_company_id:7, courier_name:"Fixture", rate:"44.05", cod:1, estimated_delivery_days:"3"};

test("one read converts declared units, restricts COD, preserves integer paise", async () => {
  const fetchImpl = async (url, options) => {
    assert.equal(options.method, "GET"); assert.equal(options.redirect, "error");
    assert.equal(new URL(url).searchParams.get("declared_value"), "550.00");
    assert.equal(new URL(url).searchParams.get("weight"), "0.5");
    assert.equal(new URL(url).searchParams.get("breadth"), "14");
    return Response.json({data:{available_courier_companies:[row,{...row,cod:0}]}});
  };
  assert.deepEqual(await quoteParcel(parcel,{env,fetchImpl}),[
    {carrierId:7,name:"Fixture",ratePaise:4405,estimatedDeliveryDays:3}
  ]);
});
test("unconfigured provider and invalid parcel make zero network calls", async () => {
  let calls=0;
  const fetchImpl=async()=>{calls++;};
  await assert.rejects(quoteParcel(parcel,{env:{},fetchImpl}),/not configured/);
  await assert.rejects(quoteParcel({...parcel,weightGrams:0},{env,fetchImpl}),/positive/);
  assert.equal(calls,0);
});
test("failed lookup differs from no service, and bad pricing fails closed", async () => {
  const lookup = response => quoteParcel(parcel,{env,fetchImpl:async()=>response});
  assert.deepEqual(await lookup(Response.json({data:{available_courier_companies:[]}})),[]);
  await assert.rejects(lookup(Response.json({}, {status:429})),/HTTP 429/);
  await assert.rejects(lookup(Response.json({})),/missing/);
  await assert.rejects(lookup(Response.json({data:{available_courier_companies:[{...row,rate:null}]}})),/invalid rate/);
});
