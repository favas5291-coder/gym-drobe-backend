"use strict";
// Item-level, admin-controlled resolution. This records obligations and already
// completed external refunds; it never submits a provider refund or bank call.
const S=require("./service"),F=require("./settlement"),{M,D}=S;
const Order=require("../../models/Order"),Product=require("../../models/Product");
const {calculateItemRefundPaise}=require("../orderRefundAllocation"),{restoreVariantStock}=require("../orderInventory");
const safe=r=>({scope:r.scope||"supplier",id:String(r._id),orderId:String(r.order),itemIndex:r.itemIndex,kind:r.kind,quantity:r.quantity,customerCreditPaise:r.customerCreditPaise,customerRefundPaise:r.customerRefundPaise,supplierReversalPaise:r.supplierReversalPaise,status:r.status,reference:r.reference,refundedAt:r.refundedAt,revision:r.__v||0});
const paise=n=>D.integer(Math.round(Number(n||0)*100),"Reconciled order amount");
function effectiveTotal(order){return Math.max(0,paise(order.pricing.finalTotal)-(order.marketplaceResolutions||[]).reduce((n,r)=>n+(r.customerCreditPaise||0),0));}
function collection(order,fullyPaid=true){const p=order.payment,gross=paise(p.grossCollected),refund=paise(p.refundedAmount),retained=paise(p.amountPaid);if(p.amountsReconciled!==true||gross!==refund+retained||!['paid','partially-paid','partially-refunded','refunded'].includes(p.status)||fullyPaid&&(paise(p.amountDue)!==0||gross<effectiveTotal(order)))D.fail("Reconcile the actual customer collection and outstanding COD balance before this resolution.",409,"MARKETPLACE_COLLECTION_REQUIRED");return {gross,refund,retained};}
async function mirror(order,session){const rows=await M.Resolution.find({order:order._id}).sort({_id:1}).session(session);order.marketplaceResolutions=rows.map(r=>({key:String(r._id),itemIndex:r.itemIndex,kind:r.kind,quantity:r.quantity,customerCreditPaise:r.customerCreditPaise,customerRefundPaise:r.customerRefundPaise,status:r.status,reference:r.reference||"",refundedAt:r.refundedAt||null}));const groups=await M.Fulfilment.find({order:order._id}).sort({_id:1}).session(session);order.supplierShipments=groups.map(g=>({key:String(g._id),itemIndices:g.itemIndices,status:g.status,carrier:g.carrier||"",trackingNumber:g.trackingNumber||"",trackingUrl:g.trackingUrl||"",deliveredAt:g.deliveredAt||null}));}
async function applyItemCredit(order,itemIndex,quantity,kind,before,session){
  const customerCreditPaise=calculateItemRefundPaise(order,[{index:itemIndex,quantity,refundedUnitsBefore:before}]);
  const outstanding=await M.Resolution.find({order:order._id,status:'refund-pending'}).session(session),money=collection(order,kind==="return"),pending=outstanding.reduce((n,r)=>n+r.customerRefundPaise,0);
  const netAfterCancellation=Math.max(0,effectiveTotal(order)-(kind==="cancellation"?customerCreditPaise:0));
  const customerRefundPaise=kind==='return'?customerCreditPaise:Math.min(customerCreditPaise,Math.max(0,money.retained-pending-netAfterCancellation));
  if(pending+customerRefundPaise>money.retained)D.fail("The refund exceeds unallocated retained customer money.",409);
  if(kind==='cancellation'){order.payment.amountDue=Math.max(0,netAfterCancellation-(money.retained-pending-customerRefundPaise))/100;if(order.payment.amountDue===0){order.payment.balanceStatus="not-applicable";if(order.payment.status==="partially-paid")order.payment.status="paid";}}
  return {customerCreditPaise,customerRefundPaise};
}
async function lockOrderAccounts(orderId,session){
  const groups=await M.Fulfilment.find({order:orderId}).sort({supplier:1}).session(session);
  if(!groups.length)D.fail("Use existing ordinary-order resolution controls for this purchase.",409);
  const accounts=[];
  for(const group of groups)accounts.push(await S.lockAccount(group.supplier,session));
  return accounts;
}
function legacyItem(order,index){
  const item=order.items[index];
  if(!item)D.fail("Purchased item not found.",404);
  if(item.marketplace)D.fail("Use this supplier item's purchased earning controls.",409);
  return item;
}
function itemIndex(value){
  if(!/^(0|[1-9]\d*)$/.test(String(value)))D.fail("Choose a valid purchased item index.");
  return D.integer(Number(value),"Purchased item index",0,999);
}
async function inspectLegacy(actor,orderId){
  S.actorRequired(actor,true);
  const order=await Order.findById(D.id(orderId)).select("+items.marketplace");
  if(!order)D.fail("Order not found.",404);
  if(!await M.Fulfilment.exists({order:order._id}))D.fail("Use existing ordinary-order resolution controls for this purchase.",409);
  const rows=await M.Resolution.find({order:order._id}).sort({_id:1}).lean();
  const entitlements=await M.Entitlement.find({order:order._id}).select("itemIndex").lean();
  const items=[];
  for(let index=0;index<order.items.length;index++){
    const item=order.items[index];if(item.marketplace)continue;
    if(entitlements.some(e=>e.itemIndex===index))D.fail("Purchased supplier ownership requires reconciliation.",409);
    items.push({id:String(index),itemIndex:index,orderId:String(order._id),name:item.name,quantity:item.quantity,resolvedQuantity:rows.filter(r=>r.itemIndex===index).reduce((n,r)=>n+r.quantity,0),unitPricePaise:paise(item.price)});
  }
  return {order:{id:String(order._id),orderNumber:order.orderNumber,status:order.status},items,resolutions:rows.filter(r=>r.scope==="legacy").map(safe)};
}
async function createLegacy(actor,orderId,index,input){
  S.actorRequired(actor,true);D.object(input,["requestKey","kind","quantity","reason","restockQuantity"],"Unassigned item resolution");
  const requestKey=D.text(input.requestKey,"request key",100,16),reason=D.text(input.reason,"resolution evidence",2000,10),quantity=D.integer(input.quantity,"Affected quantity",1,99),restockQuantity=D.integer(input.restockQuantity??0,"Restock quantity",0,quantity),purchasedIndex=itemIndex(index),oid=D.id(orderId);
  if(!["cancellation","return"].includes(input.kind))D.fail("Choose cancellation or completed return.");
  return S.transaction(async session=>{
    const accounts=await lockOrderAccounts(oid,session);
    const order=await Order.findById(oid).select("+items.marketplace").session(session);if(!order)D.fail("Order not found.",404);
    const item=legacyItem(order,purchasedIndex);
    if(await M.Entitlement.exists({order:oid,itemIndex:purchasedIndex}).session(session))D.fail("Purchased supplier ownership requires reconciliation.",409);
    const prior=await M.Resolution.findOne({order:oid,requestKey}).session(session);
    if(prior){if(prior.scope!=="legacy"||prior.itemIndex!==purchasedIndex||prior.kind!==input.kind||prior.quantity!==quantity||prior.reason!==reason||prior.restockedQuantity!==restockQuantity)D.fail("Resolution key already used with different details.",409);return {resolution:safe(prior),replayed:true};}
    collection(order,input.kind==="return");
    if(order.status==="cancelled"||!["not-requested","rejected"].includes(order.returnRequest?.status||"not-requested")||!["not-requested","not-applicable","refunded"].includes(order.refund?.status||"not-requested"))D.fail("Resolve the existing whole-order cancellation/return/refund first; do not overlap resolution paths.",409);
    const rows=await M.Resolution.find({order:oid,itemIndex:purchasedIndex}).session(session),before=rows.reduce((n,r)=>n+r.quantity,0);
    if(before+quantity>item.quantity)D.fail("Affected quantities exceed the remaining purchased units.",409);
    if(input.kind==="cancellation"&&!["confirmed","processing"].includes(order.status))D.fail("Dispatched items require a completed return, not cancellation.",409);
    if(input.kind==="return"&&order.status!=="delivered")D.fail("Confirm actual delivery and receipt/inspection before a returned-item resolution.",409);
    const {customerCreditPaise,customerRefundPaise}=await applyItemCredit(order,purchasedIndex,quantity,input.kind,before,session);
    if(restockQuantity){
      if(order.metadata?.inventoryReserved!==true)D.fail("No stock reservation is recorded; manual stock review is required before restoration.",409);
      const product=await Product.findById(item.product).select("+marketplaceAccount").session(session);
      if(!product||product.marketplaceAccount)D.fail("Historical product or ownership changed; reconcile stock manually.",409);
      restoreVariantStock(product,restockQuantity,item.selectedSize,item.selectedColor);await product.save({session});
    }
    const [r]=await M.Resolution.create([{scope:"legacy",supplier:null,entitlement:null,order:oid,itemIndex:purchasedIndex,requestKey,kind:input.kind,quantity,customerCreditPaise,customerRefundPaise,supplierReversalPaise:0,reason,restockedQuantity:restockQuantity,status:customerRefundPaise?"refund-pending":"refunded",actor:actor._id}],{session});
    await mirror(order,session);await order.save({session});
    for(const account of accounts)await F.refreshSupplier(account,session,actor);
    await S.audit(actor,null,r._id,"legacy-item-resolution-created",{resolvedQuantity:before},{orderId:String(oid),itemIndex:purchasedIndex,resolvedQuantity:before+quantity,customerRefundPaise},reason,session);
    return {resolution:safe(r),message:"Unassigned purchased item resolved. No supplier ownership was assigned and no refund was executed."};
  });
}
async function create(actor,earningId,input){
 S.actorRequired(actor,true);D.object(input,["requestKey","kind","quantity","reason","restockQuantity"],"Item resolution");const requestKey=D.text(input.requestKey,"request key",100,16),reason=D.text(input.reason,"resolution evidence",2000,10),quantity=D.integer(input.quantity,"Affected quantity",1,99),restockQuantity=D.integer(input.restockQuantity??0,"Restock quantity",0,quantity);if(!['cancellation','return'].includes(input.kind))D.fail("Choose cancellation or completed return.");
 return S.transaction(async session=>{
  const e=await M.Entitlement.findById(D.id(earningId)).session(session);if(!e)D.fail("Purchased supplier earning not found.",404);const a=await S.lockAccount(e.supplier,session),order=await Order.findById(e.order).session(session),g=await M.Fulfilment.findOne({order:e.order,supplier:e.supplier}).session(session);if(!order||!g)D.fail("Order requires reconciliation.",409);
  const prior=await M.Resolution.findOne({order:order._id,requestKey}).session(session);if(prior){if(String(prior.entitlement)!==String(e._id)||prior.kind!==input.kind||prior.quantity!==quantity||prior.reason!==reason||prior.restockedQuantity!==restockQuantity)D.fail("Resolution key already used with different details.",409);return {resolution:safe(prior),replayed:true};}
  collection(order,input.kind==="return");if(order.status==="cancelled"||!['not-requested','rejected'].includes(order.returnRequest?.status||'not-requested')||!['not-requested','not-applicable','refunded'].includes(order.refund?.status||'not-requested'))D.fail("Resolve the existing whole-order cancellation/return/refund first; do not overlap resolution paths.",409);
  const q=e.snapshot.quantity,before=e.resolvedQuantity||0;if(before+quantity>q)D.fail("Affected quantities exceed the remaining purchased units.",409);
  if(input.kind==='cancellation'&&['shipped','delivered','cancelled'].includes(g.status))D.fail("Dispatched items require a completed return, not cancellation.",409);
  if(input.kind==='return'&&g.status!=='delivered'&&order.status!=='delivered')D.fail("Confirm actual delivery and receipt/inspection before a returned-item resolution.",409);
  const {customerCreditPaise,customerRefundPaise}=await applyItemCredit(order,e.itemIndex,quantity,input.kind,before,session);
  const oldReversed=e.snapshot.supplierPayablePaise-Number(BigInt(e.snapshot.supplierPayablePaise)*BigInt(q-before)/BigInt(q)),newReversed=e.snapshot.supplierPayablePaise-Number(BigInt(e.snapshot.supplierPayablePaise)*BigInt(q-before-quantity)/BigInt(q));
  if(restockQuantity){if(order.metadata?.inventoryReserved!==true)D.fail("No stock reservation is recorded; manual stock review is required before restoration.",409);const p=await Product.findById(order.items[e.itemIndex].product).select('+marketplaceAccount').session(session);if(!p)D.fail("Historical product missing; do not invent replacement stock.",409);const item=order.items[e.itemIndex];restoreVariantStock(p,restockQuantity,item.selectedSize,item.selectedColor);p.$locals.marketplaceWrite=true;await p.save({session});}
  const [r]=await M.Resolution.create([{scope:"supplier",supplier:a._id,order:order._id,entitlement:e._id,itemIndex:e.itemIndex,requestKey,kind:input.kind,quantity,customerCreditPaise,customerRefundPaise,supplierReversalPaise:newReversed-oldReversed,reason,restockedQuantity:restockQuantity,status:customerRefundPaise?'refund-pending':'refunded',actor:actor._id}],{session});
  e.resolvedQuantity+=quantity;e.refundPending=customerRefundPaise>0||e.refundPending;await e.save({session});const groupEntries=await M.Entitlement.find({order:order._id,supplier:a._id}).session(session);if(groupEntries.every(row=>row.resolvedQuantity>=row.snapshot.quantity)){g.status="cancelled";g.history.push({status:"cancelled",at:new Date(),actor:String(actor._id),reason:"All supplier quantities resolved."});await g.save({session});}await mirror(order,session);await order.save({session});await F.refreshSupplier(a,session,actor);await S.audit(actor,a._id,r._id,"item-resolution-created",{resolvedQuantity:before},{resolvedQuantity:e.resolvedQuantity,customerRefundPaise,supplierReversalPaise:r.supplierReversalPaise},reason,session);return {resolution:safe(r),message:"Item resolution recorded. No refund or bank transfer was executed."};
 });
}
async function recordRefund(actor,rid,input){
 S.actorRequired(actor,true);D.object(input,["revision","reference","refundedAt","confirmExternalRefund"],"External refund record");if(input.confirmExternalRefund!==true)D.fail("Confirm the item refund already completed outside this dashboard.");const reference=D.text(input.reference,"actual refund reference",200,3),date=new Date(input.refundedAt);if(!Number.isFinite(date.getTime())||date.getTime()>Date.now()+60000)D.fail("Enter the actual refund date.");
 return S.transaction(async session=>{const r=await M.Resolution.findById(D.id(rid)).session(session);if(!r)D.fail("Resolution not found.",404);const accounts=r.scope==="legacy"?await lockOrderAccounts(r.order,session):[await S.lockAccount(r.supplier,session)];if(r.status==='refunded'){if(r.reference!==reference||r.refundedAt?.getTime()!==date.getTime())D.fail("A different completed refund is already recorded.",409);return {resolution:safe(r),replayed:true};}S.expect(r,input.revision);const order=await Order.findById(r.order).session(session);const money=collection(order,false);if(r.customerRefundPaise>money.retained)D.fail("Insufficient reconciled customer funds. Review provider and other refunds.",409);
  if(await M.Resolution.exists({reference,_id:{$ne:r._id}}).session(session)||await Order.exists({"refund.reference":reference}).session(session))D.fail("Refund reference already recorded.",409);
  order.payment.refundedAmount=(money.refund+r.customerRefundPaise)/100;order.payment.amountPaid=(money.retained-r.customerRefundPaise)/100;order.payment.status=money.gross===money.refund+r.customerRefundPaise?'refunded':order.payment.amountDue>0?'partially-paid':'partially-refunded';r.status='refunded';r.reference=reference;r.refundedAt=date;r.recordedBy=actor._id;await r.save({session});
  if(r.scope!=="legacy"){const e=await M.Entitlement.findById(r.entitlement).session(session);if(!e)D.fail("Purchased earning requires reconciliation.",409);e.refundPending=Boolean(await M.Resolution.exists({entitlement:e._id,status:'refund-pending'}).session(session));await e.save({session});}await mirror(order,session);await order.save({session});for(const account of accounts)await F.refreshSupplier(account,session,actor);await S.audit(actor,r.supplier||null,r._id,"external-item-refund-recorded",{status:'refund-pending'},{status:'refunded',reference,amount:r.customerRefundPaise},"Already completed external refund recorded; no money moved by GymDrobe.",session);return {resolution:safe(r),message:"External refund recorded. No refund was executed by GymDrobe."};
 });
}
async function recordCollection(actor,orderId,input){
 S.actorRequired(actor,true);D.object(input,["requestKey","amount","reference","collectedAt","reason","confirmExternalCollection"],"COD collection record");if(input.confirmExternalCollection!==true)D.fail("Confirm the actual remaining COD payment was already collected.");const requestKey=D.text(input.requestKey,"request key",100,16),reference=D.text(input.reference,"collection reference",200,3),amount=D.integer(input.amount,"Collected paise",1),reason=D.text(input.reason,"collection evidence",2000,10),date=new Date(input.collectedAt);if(!Number.isFinite(date.getTime())||date.getTime()>Date.now()+60000)D.fail("Enter the actual collection date.");
 return S.transaction(async session=>{const order=await Order.findById(D.id(orderId)).session(session);if(!order)D.fail("Order not found.",404);const groups=await M.Fulfilment.find({order:order._id}).sort({supplier:1}).session(session);if(!groups.length)D.fail("Use existing ordinary-order collection controls.",409);for(const group of groups)await S.lockAccount(group.supplier,session);const prior=await M.Collection.findOne({requestKey}).session(session);if(prior){if(String(prior.order)!==String(order._id)||prior.amount!==amount||prior.reference!==reference||prior.collectedAt.getTime()!==date.getTime()||prior.reason!==reason)D.fail("Collection key already used with different details.",409);return {collectionId:String(prior._id),replayed:true};}
  const money=collection(order,false);if(order.payment.method!=="cod-partial"||order.status==="cancelled"||paise(order.payment.amountDue)!==amount||!order.payment.verifiedAt||!order.payment.razorpayPaymentId)D.fail("Reconcile the verified COD advance and exact current balance first.",409);if(await M.Resolution.exists({order:order._id,status:"refund-pending"}).session(session))D.fail("Record pending customer refunds before collecting a remaining balance.",409);
  const expected=effectiveTotal(order);if(money.retained+amount!==expected)D.fail("Collected amount does not reconcile with purchased cancellation credits.",409);const [entry]=await M.Collection.create([{order:order._id,requestKey,amount,reference,collectedAt:date,reason,actor:actor._id}],{session});order.payment.grossCollected=(money.gross+amount)/100;order.payment.amountPaid=(money.retained+amount)/100;order.payment.amountDue=0;order.payment.status=money.refund?"partially-refunded":"paid";order.payment.balanceStatus="collected";order.payment.balanceCollectedAt=date;await order.save({session});for(const group of groups){const a=await M.Account.findById(group.supplier).session(session);await F.refreshSupplier(a,session,actor);}await S.audit(actor,null,entry._id,"external-cod-collection-recorded",null,{orderId:String(order._id),amount,reference,collectedAt:date},reason,session);return {collectionId:String(entry._id),message:"Actual external COD collection recorded. No money was collected by this dashboard."};
 });
}
module.exports={create,createLegacy,inspectLegacy,recordRefund,recordCollection,collection,effectiveTotal};
