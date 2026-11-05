"use strict";
const S = require("./service");
const {M,D,transaction,actorRequired,account,lockAccount,audit,plain,expect}=S;
const Product=require("../../models/Product");
const Order=()=>require("../../models/Order");
const {getVariantStock}=require("../orderInventory");

// This helper returns new items. Customer quote objects are never mutated with
// commercial fields; only the internal payment/order snapshot stores them.
async function snapshotItems(items,products,pricing) {
  const map=new Map(products.map(p=>[String(p._id||p.id),p]));
  if(!items.some(i=>map.get(String(i.product||i.id))?.marketplaceAccount))return items;
  if(!S.enabled())D.fail("Supplier marketplace checkout is not enabled.",409,"MARKETPLACE_DISABLED");
  const weights=items.map(i=>Math.round(i.price*100)*i.quantity);
  const discounts=D.allocateExact(Math.round((pricing.couponDiscount||0)*100),weights);
  const shipping=D.allocateExact(Math.round((pricing.shipping||0)*100),weights);
  // Shipping can exceed merchandise; it is a separate weighted allocation.
  const cache=new Map();const result=[];
  for(let index=0;index<items.length;index++){
    const item=items[index],p=map.get(String(item.product||item.id));
    if(!p?.marketplaceAccount){result.push(item);continue;}
    let a=cache.get(String(p.marketplaceAccount));if(!a){a=await M.Account.findById(p.marketplaceAccount);cache.set(String(p.marketplaceAccount),a);}
    if(!a||a.status!=="active"||!a.acceptance||a.acceptance.digest!==p.marketplaceCommercial?.termsDigest||p.isActive===false)D.fail("Supplier availability or commercial terms changed. Refresh checkout.",409,"MARKETPLACE_SUPPLIER_UNAVAILABLE");
    const c=p.marketplaceCommercial;if(c.expiryDate&&new Date(c.expiryDate).getTime()<=Date.now())D.fail("This batch has expired. Choose another product.",409);const v=c.variants.find(v=>D.key(v)===D.key({size:item.selectedSize,color:item.selectedColor}));if(!v)D.fail("Supplier variant requires review.",409);
    if(Math.round(item.price*100)!==v.customerUnitAmount)D.fail("Variant price changed. Refresh checkout.",409);
    const discount=item.priceAllocation?item.priceAllocation.kitDiscountPaise+item.priceAllocation.couponDiscountPaise:discounts[index];
    const amounts=D.lineFinance(v,item.quantity,discount);
    result.push({...item,marketplace:{version:1,accountId:String(a._id),supplierId:String(a.supplier),supplierName:a.business.legalName,listingId:String(p.marketplaceListing),offerRevision:c.offerRevision,termsDigest:c.termsDigest,terms:c.terms,supplierSku:v.supplierSku,variant:{size:v.size,color:v.color},quantity:item.quantity,supplierUnitAmount:v.supplierUnitAmount,customerUnitAmount:v.customerUnitAmount,mrpUnitAmount:v.mrpUnitAmount,taxInclusive:true,taxRateBps:v.taxRateBps,shippingAllocationPaise:shipping[index],promotionAgreement:v.promotionAgreement||null,...amounts}});
  }
  return result;
}
function supplierTarget(order,entitlement,group,now=new Date()){
  const s=entitlement.snapshot,q=s.quantity;let cancelled=entitlement.resolvedQuantity||0;
  if(order.status==="cancelled")cancelled=q;
  const r=order.returnRequest||{},rows=r.items||[];const match=rows.find(row=>row.index===entitlement.itemIndex);
  const returned=r.type==="return"&&r.status==="completed"&&match?match.quantity:0;
  const validQuantity=Math.max(0,q-Math.min(q,cancelled+returned));
  const amount=Number(BigInt(s.supplierPayablePaise)*BigInt(validQuantity)/BigInt(q));
  const hasOpenReturn=Boolean(match&&!['not-requested','rejected','completed'].includes(r.status));
  const delivered=group?.deliveredAt||order.delivery?.deliveredAt;
  const hold=Math.max(s.terms.settlementHoldHours,(s.returnWindowDays||0)*24)*3600000;
  const deliveredTime=delivered?new Date(delivered).getTime():NaN;
  const refundPending=Boolean(entitlement.refundPending||order.refund&&!["not-requested","not-applicable","refunded"].includes(order.refund.status));
  const total=Math.max(0,Math.round(Number(order.pricing?.finalTotal||0)*100)-(order.marketplaceResolutions||[]).reduce((n,r)=>n+(r.customerCreditPaise||0),0));
  const collected=Math.round(Number(order.payment?.grossCollected??order.payment?.amountPaid??0)*100);
  const due=Math.round(Number(order.payment?.amountDue||0)*100);
  const completePayment=order.payment?.amountsReconciled===true&&collected>=total&&due===0&&["paid","partially-refunded","refunded"].includes(order.payment.status);
  const deliveryComplete=group?.status==="delivered"||order.status==="delivered";
  const eligible=amount>0&&completePayment&&deliveryComplete&&Number.isFinite(deliveredTime)&&deliveredTime<=now.getTime()&&now.getTime()>deliveredTime+hold&&!hasOpenReturn&&!refundPending;
  return {amount:eligible?amount:0,pending:eligible?0:amount,reversed:s.supplierPayablePaise-amount,reason:!validQuantity?"Cancelled or returned quantity":!completePayment?"Full collection must be reconciled":!deliveryComplete?"Delivery not confirmed":hasOpenReturn||refundPending?"Return/refund resolution pending":!eligible?"Purchased return window / settlement hold":"Eligible after confirmed delivery, collection and hold"};
}
async function ledgerRow({supplier,order,entitlement,payout,key,kind,amount,reason,actor,detail},session){await M.Ledger.create([{supplier,order,entitlement,payout,key,kind,amount,reason,actor:actor?._id,detail}],{session});}
async function initializeOrder(order,session){
  const rows=(order.items||[]).map((item,index)=>({item,index})).filter(r=>r.item.marketplace);
  if(!rows.length)return;
  if(!S.enabled()||!session?.inTransaction())D.fail("Supplier order creation requires the enabled transactional marketplace.",503);
  const accounts=[...new Set(rows.map(r=>r.item.marketplace.accountId))].sort();
  for(const id of accounts){const a=await lockAccount(id,session);if(a.status!=="active")D.fail("Supplier became unavailable.",409);}
  for(const{item,index}of rows){
    const s=item.marketplace,p=await Product.findById(item.product).select("+marketplaceCommercial +marketplaceAccount").session(session);
    if(!p||p.isActive===false||String(p.marketplaceAccount)!==s.accountId||p.marketplaceCommercial?.offerRevision!==s.offerRevision||getVariantStock(p,item.selectedSize,item.selectedColor)<item.quantity)D.fail("Supplier product, price or stock changed. Refresh checkout.",409,"MARKETPLACE_ORDER_CHANGED");
    const e=new M.Entitlement({supplier:s.accountId,order:order._id,itemIndex:index,snapshot:{...s,productId:String(item.product),name:item.name,sku:item.sku,returnWindowDays:item.returnWindowDays},pendingAmount:s.supplierPayablePaise});await e.save({session});
    await ledgerRow({supplier:e.supplier,order:order._id,entitlement:e._id,key:`order:${order._id}:${index}:pending`,kind:"pending",amount:s.supplierPayablePaise,reason:"Immutable supplier amount captured; collection/delivery/return eligibility not yet satisfied."},session);
  }
  for(const aid of accounts){await M.Fulfilment.create([{order:order._id,supplier:aid,itemIndices:rows.filter(r=>r.item.marketplace.accountId===aid).map(r=>r.index)}],{session});}
}
async function refreshSupplier(a,session,actor,now=new Date()){
  const entries=await M.Entitlement.find({supplier:a._id}).session(session);
  if(entries.length>5000)D.fail("Supplier statement needs paginated reconciliation before payout.",409);
  for(const e of entries){
    const order=await Order().findById(e.order).session(session);if(!order)D.fail("An earning's order requires administrator reconciliation.",409);
    const group=await M.Fulfilment.findOne({order:e.order,supplier:a._id}).session(session);
    const t=supplierTarget(order,e,group,now);const stamp=D.digest(t);
    if(e.stateDigest===stamp)continue;
    const before=e.targetAmount;
    e.targetAmount=t.amount;e.pendingAmount=t.pending;e.reversedAmount=t.reversed;e.stateDigest=stamp;
    await e.save({session});
    await ledgerRow({supplier:a._id,order:e.order,entitlement:e._id,key:`earning:${e._id}:${e.__v}`,kind:t.amount<before?"reversal":"eligibility",amount:t.amount-before,reason:t.reason,actor,detail:{pendingAmount:t.pending,reversedAmount:t.reversed,recoverableAmount:Math.max(0,e.paidAmount+e.reservedAmount-t.amount)}},session);
  }
  return entries;
}
function totals(entries){return entries.reduce((r,e)=>{r.pending+=e.pendingAmount;r.eligible+=e.targetAmount;r.paid+=e.paidAmount;r.reserved+=e.reservedAmount;r.available+=e.targetAmount-e.paidAmount-e.reservedAmount-(e.withheldAmount||0)+(e.recoverySettledAmount||0);r.recoverable+=Math.max(0,e.paidAmount+e.reservedAmount+(e.withheldAmount||0)-e.targetAmount-(e.recoverySettledAmount||0));r.reversed+=e.reversedAmount;return r;},{pending:0,eligible:0,paid:0,reserved:0,available:0,recoverable:0,reversed:0});}
function safeEarning(e){return {id:String(e._id),orderId:String(e.order),itemIndex:e.itemIndex,name:e.snapshot.name,quantity:e.snapshot.quantity,resolvedQuantity:e.resolvedQuantity||0,supplierUnitAmount:e.snapshot.supplierUnitAmount,supplierPayablePaise:e.snapshot.supplierPayablePaise,customerUnitAmount:e.snapshot.customerUnitAmount,markupBeforeExpensesPaise:e.snapshot.markupBeforeExpensesPaise,discountFunding:{supplier:e.snapshot.supplierFundedDiscountPaise,platform:e.snapshot.platformFundedDiscountPaise,agreement:e.snapshot.promotionAgreement},taxIncludedPaise:e.snapshot.taxIncludedPaise,shippingAllocationPaise:e.snapshot.shippingAllocationPaise,pendingAmount:e.pendingAmount,eligibleAmount:e.targetAmount,paidAmount:e.paidAmount,reservedAmount:e.reservedAmount,recoverableAmount:Math.max(0,e.paidAmount+e.reservedAmount+(e.withheldAmount||0)-e.targetAmount-(e.recoverySettledAmount||0)),withheldAmount:e.withheldAmount||0,recoverySettledAmount:e.recoverySettledAmount||0,availableAmount:e.targetAmount-e.paidAmount-e.reservedAmount-(e.withheldAmount||0)+(e.recoverySettledAmount||0),createdAt:e.createdAt};}
async function earnings(actor,aid){return transaction(async s=>{const a0=await account(actor,aid,s);const a=await lockAccount(a0._id,s);const rows=await refreshSupplier(a,s,actor);const ledger=await M.Ledger.find({supplier:a._id}).sort({_id:-1}).limit(100).session(s).lean();return {balance:totals(rows),earnings:rows.map(safeEarning),ledger:ledger.map(e=>({id:String(e._id),kind:e.kind,amount:e.amount,reason:e.reason,createdAt:e.createdAt,payoutId:e.payout?String(e.payout):null}))};});}
function safePayout(p){const d=plain(p);return {id:String(d._id),supplierId:String(d.supplier),items:d.items,adjustments:d.adjustments||[],amount:d.amount,status:d.status,destinationId:String(d.destination),destinationMasked:d.destinationMasked,reference:d.reference||null,transferDate:d.transferDate||null,recordedAt:d.recordedAt||null,createdAt:d.createdAt,revision:d.__v||0,proofId:d.proof?String(d.proof):null};}
async function reservePayout(actor,aid,input){actorRequired(actor,true);D.object(input,["requestKey","earningIds","destinationId"],"Payout reservation");const requestKey=D.text(input.requestKey,"payout request key",100,16);if(!Array.isArray(input.earningIds)||!input.earningIds.length||input.earningIds.length>100||new Set(input.earningIds).size!==input.earningIds.length)D.fail("Select one to 100 distinct earnings.");input.earningIds.forEach(D.id);return transaction(async s=>{
  const a=await lockAccount(D.id(aid),s);if(a.status!=="active")D.fail("Supplier is not active. Resolve suspension before reserving a new payout.",409);
  const prior=await M.Payout.findOne({supplier:a._id,requestKey}).session(s);if(prior){if(prior.destination.toString()!==input.destinationId||D.digest(prior.items.map(i=>i.earningId).sort())!==D.digest([...input.earningIds].sort()))D.fail("Idempotency key was used with different payout items.",409);return {payout:safePayout(prior),replayed:true};}
  const dest=await M.Destination.findOne({_id:D.id(input.destinationId),supplier:a._id,version:a.paymentVersion,status:"verified"}).session(s);if(!dest)D.fail("Reverify the current payment destination before payout.",409);
  const all=await refreshSupplier(a,s,actor);const balance=totals(all);const selected=input.earningIds.map(id=>all.find(e=>String(e._id)===id));if(selected.some(e=>!e||e.reservedAmount||e.targetAmount<=e.paidAmount))D.fail("Selected earnings are unavailable, already reserved or no longer eligible.",409,"MARKETPLACE_PAYOUT_CONFLICT");
  const items=selected.map(e=>({earningId:String(e._id),orderId:String(e.order),itemIndex:e.itemIndex,name:e.snapshot.name,quantity:e.snapshot.quantity,grossAmount:e.targetAmount-e.paidAmount-(e.withheldAmount||0)+(e.recoverySettledAmount||0),offsetAmount:0,amount:e.targetAmount-e.paidAmount-(e.withheldAmount||0)+(e.recoverySettledAmount||0)}));const gross=items.reduce((n,i)=>n+i.amount,0);
  if(items.some(i=>i.amount<1)||balance.available<1)D.fail("No positive balance remains after recoverable adjustments. Resolve reservations or wait for further eligible earnings.",409);
  let offset=Math.max(0,gross-balance.available,all.filter(e=>!e.reservedAmount).reduce((sum,e)=>sum+Math.max(0,e.paidAmount+(e.withheldAmount||0)-e.targetAmount-(e.recoverySettledAmount||0)),0));const adjustments=[];
  for(const debt of all.filter(e=>!e.reservedAmount&&e.paidAmount+(e.withheldAmount||0)>e.targetAmount+(e.recoverySettledAmount||0))){
    let left=Math.min(offset,debt.paidAmount+(debt.withheldAmount||0)-debt.targetAmount-(debt.recoverySettledAmount||0));
    for(const row of items){if(!left)break;const n=Math.min(left,row.amount);if(!n)continue;row.amount-=n;row.offsetAmount+=n;left-=n;offset-=n;debt.recoverySettledAmount=(debt.recoverySettledAmount||0)+n;const earning=selected.find(e=>String(e._id)===row.earningId);earning.withheldAmount=(earning.withheldAmount||0)+n;adjustments.push({sourceEarningId:String(debt._id),earningId:row.earningId,amount:n});}
    await debt.save({session:s});
  }
  if(offset)D.fail("A changed reservation or unallocated recovery requires admin reconciliation.",409);
  const sum=items.reduce((n,i)=>n+i.amount,0);if(sum<1)D.fail("Recovery uses all selected earnings; select enough eligible items for a positive payout.",409);
  const p=new M.Payout({supplier:a._id,requestKey,items,adjustments,amount:sum,destination:dest._id,destinationMasked:dest.masked});await p.save({session:s});
  for(const e of selected){e.reservedAmount=items.find(i=>i.earningId===String(e._id)).amount;await e.save({session:s});}
  if(adjustments.length)await ledgerRow({supplier:a._id,payout:p._id,key:`payout:${p._id}:recovery-offset`,kind:"recovery-offset",amount:-adjustments.reduce((n,r)=>n+r.amount,0),reason:"Prior paid return/cancellation recovery offset against future eligible earnings. Original payout unchanged; offsets are released if this reservation is cancelled.",actor,detail:{adjustments}},s);
  await ledgerRow({supplier:a._id,payout:p._id,key:`payout:${p._id}:reserved`,kind:"reserved",amount:-sum,reason:"Eligible items reserved atomically. No bank transfer executed.",actor},s);await audit(actor,a._id,p._id,"payout-reserved",null,{amount:sum,destinationId:String(dest._id),items},"Manual payout reservation; transfer must be performed outside GymDrobe.",s);return {payout:safePayout(p)};
});}
async function payoutFor(actor,pid,s){const p=await M.Payout.findById(D.id(pid)).session(s||null);if(!p)D.fail("Payout not found.",404);await account(actor,String(p.supplier),s);return p;}
async function completePayout(actor,pid,input){actorRequired(actor,true);D.object(input,["revision","reference","transferDate","confirmExternalTransfer","proofId","reason"],"Completed transfer record");if(input.confirmExternalTransfer!==true)D.fail("Confirm an already completed external transfer; this action does not execute one.");const reference=D.text(input.reference,"transfer reference",150,3),date=new Date(input.transferDate);if(!Number.isFinite(date.getTime())||date.getTime()>Date.now()+60000)D.fail("Enter the actual completed transfer date.");return transaction(async s=>{
  const p=await payoutFor(actor,pid,s);const a=await lockAccount(p.supplier,s);
  if(p.status==="paid"){if(p.reference!==reference||p.transferDate.getTime()!==date.getTime())D.fail("A different completed transfer is already recorded.",409);return {payout:safePayout(p),replayed:true};}
  expect(p,input.revision);if(p.status!=="reserved")D.fail("Only reserved payouts can be recorded.",409);
  if(await M.Payout.exists({reference,_id:{$ne:p._id}}).session(s))D.fail("Transfer reference already used.",409);
  if(input.proofId){const proof=await M.Media.findOne({_id:D.id(input.proofId),owner:actor._id,kind:"payout-proof"}).session(s);if(!proof)D.fail("Choose an authorized private payout proof.");p.proof=proof._id;}
  await refreshSupplier(a,s,actor);
  for(const row of p.items){const e=await M.Entitlement.findById(row.earningId).session(s);if(!e||e.reservedAmount!==row.amount)D.fail("Payout reservation requires reconciliation.",409);e.reservedAmount=0;e.paidAmount+=row.amount;await e.save({session:s});}
  p.status="paid";p.reference=reference;p.transferDate=date;p.recordedBy=actor._id;p.recordedAt=new Date();p.reason=D.text(input.reason||"Externally completed transfer recorded.","recording note",1000);await p.save({session:s});
  await ledgerRow({supplier:a._id,payout:p._id,key:`payout:${p._id}:paid`,kind:"paid",amount:-p.amount,reason:"External transfer recorded, not executed or provider-confirmed by GymDrobe. Any later refund is an explicit recoverable adjustment.",actor,detail:{reference,transferDate:date}},s);await audit(actor,a._id,p._id,"external-payout-recorded",{status:"reserved"},{status:"paid",reference,transferDate:date},p.reason,s);return {payout:safePayout(p),message:"External transfer recorded. GymDrobe did not execute or independently confirm a bank transfer."};
});}
async function cancelPayout(actor,pid,input){actorRequired(actor,true);const reason=D.text(input.reason,"cancellation reason",1000,5);return transaction(async s=>{const p=await payoutFor(actor,pid,s);await lockAccount(p.supplier,s);if(p.status==="cancelled")return {payout:safePayout(p),replayed:true};expect(p,input.revision);if(p.status!=="reserved")D.fail("Completed payouts cannot be rewritten. Record a recoverable adjustment instead.",409);for(const row of p.items){const e=await M.Entitlement.findById(row.earningId).session(s);if(!e||e.reservedAmount!==row.amount)D.fail("Reservation needs reconciliation.",409);e.reservedAmount=0;await e.save({session:s});}for(const row of p.adjustments||[]){const source=await M.Entitlement.findById(row.sourceEarningId).session(s),earning=await M.Entitlement.findById(row.earningId).session(s);if(!source||!earning||source.recoverySettledAmount<row.amount||earning.withheldAmount<row.amount)D.fail("Recovery offset requires reconciliation.",409);source.recoverySettledAmount-=row.amount;earning.withheldAmount-=row.amount;await source.save({session:s});await earning.save({session:s});}p.status="cancelled";p.reason=reason;await p.save({session:s});await ledgerRow({supplier:p.supplier,payout:p._id,key:`payout:${p._id}:released`,kind:"released",amount:p.amount,reason,actor},s);await audit(actor,p.supplier,p._id,"payout-cancelled",{status:"reserved"},{status:"cancelled"},reason,s);return {payout:safePayout(p)};});}
async function listPayouts(actor,aid){const a=await account(actor,aid);return {payouts:(await M.Payout.find({supplier:a._id}).sort({_id:-1}).limit(100)).map(safePayout)};}
async function statement(actor,pid){const p=await payoutFor(actor,pid);const rows=[["GymDrobe supplier payout statement — recording is not execution"],["Payout",String(p._id)],["Status",p.status],["Amount INR",(p.amount/100).toFixed(2)],["Masked destination",JSON.stringify(p.destinationMasked)],["Reference",p.reference||"Not recorded"],["Transfer date",p.transferDate?.toISOString()||"Not recorded"],["Order","Item","Quantity","Gross eligible INR","Prior recovery withheld INR","Cash payout INR"],...p.items.map(i=>[i.orderId,i.name,i.quantity,((i.grossAmount??i.amount)/100).toFixed(2),((i.offsetAmount||0)/100).toFixed(2),(i.amount/100).toFixed(2)]),["Recovery source earning","Future earning","Offset INR"],...(p.adjustments||[]).map(r=>[r.sourceEarningId,r.earningId,(r.amount/100).toFixed(2)])];return D.csv(rows);}
async function supplierOrders(actor,aid){const a=await account(actor,aid);const groups=await M.Fulfilment.find({supplier:a._id}).sort({_id:-1}).limit(100);const result=[];for(const g of groups){const o=await Order().findById(g.order);if(!o)continue;const resolutions=await M.Resolution.find({order:o._id,supplier:a._id}).sort({_id:1}).lean();const allowed=g.itemIndices.map(index=>{const i=o.items[index];return {itemIndex:index,name:i.name,sku:i.sku,quantity:Math.max(0,i.quantity-resolutions.filter(r=>r.itemIndex===index).reduce((n,r)=>n+r.quantity,0)),purchasedQuantity:i.quantity,selectedSize:i.selectedSize,selectedColor:i.selectedColor,image:i.image};});const needsFulfilment=["accepted","preparing","shipped"].includes(g.status)||["paid","partially-paid"].includes(o.payment?.status);result.push({id:String(g._id),orderId:String(o._id),orderNumber:o.orderNumber,status:g.status,revision:g.__v||0,items:allowed,resolutions:resolutions.map(r=>({id:String(r._id),itemIndex:r.itemIndex,kind:r.kind,quantity:r.quantity,customerRefundPaise:r.customerRefundPaise,status:r.status,reference:r.reference,refundedAt:r.refundedAt,revision:r.__v||0})),shippingAddress:needsFulfilment?Object.fromEntries(["fullName","addressLine","city","state","pincode","phone"].map(key=>[key,o.shippingAddress?.[key]||""])):null,carrier:g.carrier||"",trackingNumber:g.trackingNumber||"",trackingUrl:g.trackingUrl||"",deliveredAt:g.deliveredAt||null,history:g.history,customerPaymentState:o.payment?.status,balanceDuePaise:Math.round((o.payment?.amountDue||0)*100),paymentMethod:o.payment?.method});}return {orders:result};}
async function updateFulfilment(actor,gid,input){D.object(input,["revision","status","carrier","trackingNumber","trackingUrl","reason"],"Supplier fulfilment");return transaction(async s=>{const g=await M.Fulfilment.findById(D.id(gid)).session(s);if(!g)D.fail("Shipment not found.",404);const a=await account(actor,String(g.supplier),s);await lockAccount(a._id,s);expect(g,input.revision);const o=await Order().findById(g.order).session(s);if(!o||o.status==="cancelled"||!["paid","partially-paid","partially-refunded"].includes(o.payment?.status))D.fail("Order payment or cancellation must be resolved before fulfilment.",409);
  const next={pending:["accepted"],accepted:["preparing"],preparing:["shipped"],shipped:actor.role==="admin"?["delivered"]:[],delivered:[],cancelled:[]};if(!next[g.status].includes(input.status))D.fail("This shipment transition is not permitted.",409);
  if(input.status==="shipped"){g.carrier=D.text(input.carrier,"carrier",100,2);g.trackingNumber=D.text(input.trackingNumber,"tracking number",150,3);g.trackingUrl=input.trackingUrl?D.image(input.trackingUrl):"";g.shippedAt=new Date();}
  if(input.status==="delivered"){D.text(input.reason,"delivery evidence",1000,5);g.deliveredAt=new Date();}
  g.status=input.status;g.history.push({status:g.status,actor:String(actor._id),at:new Date(),reason:D.text(input.reason||"Supplier fulfilment update.","shipment note",1000)});await g.save({session:s});
  const all=await M.Fulfilment.find({order:o._id}).session(s);o.supplierShipments=all.map(row=>({key:String(row._id),itemIndices:row.itemIndices,status:row.status,carrier:row.carrier||"",trackingNumber:row.trackingNumber||"",trackingUrl:row.trackingUrl||"",deliveredAt:row.deliveredAt||null}));if(await M.Entitlement.countDocuments({order:o._id}).session(s)===o.items.length){const live=all.filter(row=>row.status!=="cancelled");if(live.length&&live.every(row=>row.status==="delivered")){o.status="delivered";o.delivery.deliveredAt=new Date(Math.max(...live.map(row=>new Date(row.deliveredAt).getTime())));}else if(live.length&&live.every(row=>["shipped","delivered"].includes(row.status)))o.status="shipped";else if(live.some(row=>["accepted","preparing","shipped","delivered"].includes(row.status)))o.status="processing";}await o.save({session:s});await audit(actor,a._id,g._id,"shipment-updated",null,{status:g.status},input.reason||"Existing supplier order fulfilment; no courier or customer message sent.",s);return {shipment:{id:String(g._id),status:g.status,revision:g.__v||0}};
});}
async function overview(actor,aid){const a=await account(actor,aid);const rawLists=await M.Listing.find({supplier:a._id});const lists=await Promise.all(rawLists.map(l=>S.hydratedListing(l)));const groups=await M.Fulfilment.countDocuments({supplier:a._id,status:{$in:["pending","accepted","preparing"]}});const e=await earnings(actor,String(a._id));return {account:S.safeAccount(a,actor.role==="admin"),counts:{approvedProducts:lists.filter(l=>l.live).length,awaitingReview:lists.filter(l=>l.status==="submitted").length,ordersRequiringAction:groups,lowStockProducts:lists.filter(l=>(l.live?.variants||[]).some(v=>v.stock<=10)).length},balance:e.balance,recentActivity:await M.Audit.find({supplier:a._id}).sort({_id:-1}).limit(15).select("action reason createdAt").lean()};}

async function addExpense(actor,input){
  actorRequired(actor,true);D.object(input,["requestKey","category","amount","date","reference","reason","paidBy"],"Actual expense");
  const row={requestKey:D.text(input.requestKey,"request key",100,16),category:D.text(input.category,"expense category",100,2),amount:D.integer(input.amount,"Actual expense paise",1),date:new Date(input.date),reference:D.text(input.reference,"invoice/reference",200,3),reason:D.text(input.reason,"expense evidence",2000,5),paidBy:input.paidBy};
  if(!["platform","supplier"].includes(row.paidBy)||!Number.isFinite(row.date.getTime())||row.date.getTime()>Date.now()+60000)D.fail("Check the expense date and cost payer.");
  return transaction(async session=>{const prior=await M.Expense.findOne({requestKey:row.requestKey}).session(session);if(prior){const stored=Object.fromEntries(Object.keys(row).map(k=>[k,k==="date"?prior.date.toISOString():prior[k]]));if(D.digest(stored)!==D.digest({...row,date:row.date.toISOString()}))D.fail("Expense key already used with different details.",409);return {expense:{id:String(prior._id)},replayed:true};}const [e]=await M.Expense.create([{...row,actor:actor._id}],{session});await audit(actor,null,e._id,"expense-recorded",null,row,"Actual cost recorded separately; no supplier deduction or money transfer.",session);return {expense:{id:String(e._id)}};});
}
async function reporting(actor){
  actorRequired(actor,true);const accounts=await M.Account.find({});if(accounts.length>500)D.fail("Use a paginated financial export before expanding beyond 500 suppliers.",409);
  const report={grossCollectedPaise:0,refundedPaise:0,retainedPaise:0,orderedMarkupBeforeExpensesPaise:0,platformExpensesPaise:0,supplierPendingPaise:0,supplierEligiblePaise:0,supplierPaidPaise:0};
  for(const a of accounts){const e=await earnings(actor,String(a._id));report.supplierPendingPaise+=e.balance.pending;report.supplierEligiblePaise+=e.balance.eligible;report.supplierPaidPaise+=e.balance.paid;}
  const entries=await M.Entitlement.find({}).select("snapshot").lean();for(const e of entries)report.orderedMarkupBeforeExpensesPaise+=e.snapshot.markupBeforeExpensesPaise;
  const orderIds=await M.Entitlement.distinct("order");const orders=await Order().find({_id:{$in:orderIds}}).select("payment pricing").lean();for(const o of orders){if(o.payment?.amountsReconciled!==true)continue;report.grossCollectedPaise+=Math.round((o.payment.grossCollected??o.payment.amountPaid??0)*100);report.refundedPaise+=Math.round((o.payment.refundedAmount||0)*100);}report.retainedPaise=report.grossCollectedPaise-report.refundedPaise;
  const expenses=await M.Expense.find({}).sort({_id:-1}).lean();for(const e of expenses)if(e.paidBy==="platform")report.platformExpensesPaise+=e.amount;
  report.notice="Mixed orders include all collected customer money once, including admin-owned items and shipping. Contracted markup is historical before cancellations, returns, fees and tax liabilities. Costs may be incomplete. These are operational balances, not profit. Supplier-paid costs are recorded only and never automatically deducted.";
  return {report,expenses:expenses.slice(0,100).map(e=>({id:String(e._id),category:e.category,amount:e.amount,date:e.date,reference:e.reference,paidBy:e.paidBy}))};
}

module.exports={addExpense,reporting,snapshotItems,supplierTarget,initializeOrder,refreshSupplier,earnings,reservePayout,completePayout,cancelPayout,listPayouts,statement,supplierOrders,updateFulfilment,overview,totals};
