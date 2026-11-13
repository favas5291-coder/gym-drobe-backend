"use strict";
const mongoose = require("mongoose");
const crypto = require("node:crypto");
const jwt = require("jsonwebtoken");
const M = require("../../models/Marketplace");
const Supplier = require("../../models/Supplier");
const User = require("../../models/User");
const Product = require("../../models/Product");
const D = require("./domain");

const enabled = () => process.env.MARKETPLACE_ENABLED === "true";
const plain = d => d?.toObject ? d.toObject({transform:false}) : d;
const revision = d => d.__v || 0;
const PRIVATE_SUPPLIER = "+contact +verification +fulfillment +notes +portalWorkspace +marketplaceAccount";
async function transaction(work) {
  const session = await mongoose.startSession();
  try { let result; await session.withTransaction(async()=>{ result=await work(session); },{readConcern:{level:"snapshot"},writeConcern:{w:"majority"},readPreference:"primary",maxCommitTimeMS:10000});return result; }
  finally { await session.endSession(); }
}
function actorRequired(actor, admin=false) { if(!actor?._id||actor.isActive===false)D.fail("Sign in to continue.",401);if(admin&&actor.role!=="admin")D.fail("Admin access required.",403); }
function expect(document, n) { D.integer(n,"Revision");if(revision(document)!==n)D.fail("This record changed. Reload before saving.",409,"MARKETPLACE_REVISION_CONFLICT"); }
async function audit(actor,supplier,entity,action,before,after,reason,session) { await M.Audit.create([{actor:actor?._id,supplier,entity:String(entity),action,before,after,reason}],{session}); }
async function account(actor, accountId, session, active=false) {
  actorRequired(actor);const filter=accountId?{_id:D.id(accountId)}:{owner:actor._id};if(actor.role!=="admin")filter.owner=actor._id;
  const a=await M.Account.findOne(filter).session(session||null);if(!a)D.fail("Supplier workspace not found.",404,"MARKETPLACE_ACCOUNT_NOT_FOUND");
  if(active&&a.status!=="active")D.fail("Admin approval and active supplier status are required.",403,"MARKETPLACE_SUPPLIER_INACTIVE");return a;
}
async function lockAccount(id,session) { const a=await M.Account.findOneAndUpdate({_id:id},{$inc:{lockVersion:1}},{new:true,session});if(!a)D.fail("Supplier not found.",404);return a; }
function safeAccount(a,admin=false) {const d=plain(a);return {id:String(d._id),supplierId:String(d.supplier),ownerId:d.owner?String(d.owner):null,email:d.email,status:d.status,business:d.business,terms:d.terms,termsDigest:d.termsDigest,acceptance:d.acceptance,paymentVersion:d.paymentVersion,revision:revision(d),...(admin?{notes:d.notes||""}:{}),createdAt:d.createdAt,updatedAt:d.updatedAt};}
function safeListing(l) {const d=plain(l);return {id:String(d._id),supplierId:String(d.supplier),productId:d.product?String(d.product):null,status:d.status,draft:d.draft,live:d.live,approvedCandidate:d.approvedCandidate,feedback:d.feedback,offerRevision:d.offerRevision,revision:revision(d),submittedAt:d.submittedAt,reviewedAt:d.reviewedAt,updatedAt:d.updatedAt};}
function sessionFor(user) { if(!process.env.JWT_SECRET)D.fail("Session service unavailable.",503);const u=plain(user);return {token:jwt.sign({userId:String(u._id),authVersion:u.authVersion||0,authMethod:"supplier-password"},process.env.JWT_SECRET,{algorithm:"HS256",expiresIn:"7d"}),user:{id:String(u._id),name:u.name,email:u.email,phone:u.phone||"",role:u.role}}; }
async function reauthenticate(actor,input) {
  const u=await User.findById(actor._id).select("+password +googleId +authVersion");if(!u||u.isActive===false)D.fail("Sign in again.",401);
  if(input.currentPassword&&await u.comparePassword(input.currentPassword))return u;
  if(typeof input.reauthToken==="string"&&u.googleId){
    try {const p=jwt.verify(input.reauthToken,process.env.JWT_SECRET,{algorithms:["HS256"]});const age=Math.floor(Date.now()/1000)-p.iat;if(p.userId===String(u._id)&&(p.authVersion??0)===(u.authVersion||0)&&age>=0&&age<=120)return u;}catch{ /* Uniform failure without token details. */ }
  }
  D.fail("Confirm your supplier password or complete a fresh Google sign-in before this sensitive action.",403,"MARKETPLACE_REAUTH_REQUIRED");
}
async function createAccount(actor,input) {
  actorRequired(actor,true);D.object(input,["email","business","terms","notes","supplierId"],"Supplier onboarding");const business=D.business(input.business),terms=D.terms(input.terms),email=D.email(input.email);
  const token=crypto.randomBytes(32).toString("hex");
  return transaction(async session=>{
    let supplier;
    if(input.supplierId){supplier=await Supplier.findById(D.id(input.supplierId)).select(PRIVATE_SUPPLIER).session(session);if(!supplier||supplier.status!=="draft")D.fail("Choose an existing draft supplier.",409);if(await M.Account.exists({supplier:supplier._id}).session(session))D.fail("Supplier already enrolled.",409);}
    else supplier=new Supplier({name:business.legalName,status:"draft",contact:{name:business.contactName,email,phone:business.phone}});
    const a=new M.Account({supplier:supplier._id,email,business,terms,termsDigest:D.digest(terms),notes:D.text(input.notes||"","internal notes",2000),invitation:{hash:D.digest(token),expiresAt:new Date(Date.now()+48*3600000)}});
    supplier.marketplaceAccount=a._id;await supplier.save({session});await a.save({session});
    await audit(actor,a._id,a._id,"supplier-created",null,{status:a.status,termsDigest:a.termsDigest},"Admin-controlled invitation; no message sent.",session);
    return {account:safeAccount(a,true),invitationCode:token,invitationExpiresAt:a.invitation.expiresAt,message:"Private invitation generated. No email was sent. The supplier sets their own password."};
  });
}
async function activate(actor,input) {
  D.object(input,["code","password","name","acceptTerms","termsDigest"],"Activation");if(!/^[a-f\d]{64}$/i.test(input.code||""))D.fail("Invitation is invalid or expired.",400);
  return transaction(async session=>{
    const a=await M.Account.findOne({"invitation.hash":D.digest(input.code),"invitation.expiresAt":{$gt:new Date()}}).select("+invitation").session(session);
    if(!a||a.owner)D.fail("Invitation is invalid, expired or already used.",409);
    if(input.acceptTerms!==true||input.termsDigest!==a.termsDigest)D.fail("Read and explicitly accept the exact current commercial terms.",409);
    let u=await User.findOne({email:a.email}).select("+authVersion").session(session);
    if(u){if(!actor||String(actor._id)!==String(u._id))D.fail("Sign in to your existing GymDrobe account before claiming this invitation. Its password will not be changed.",409,"MARKETPLACE_EXISTING_ACCOUNT");if(u.isActive===false)D.fail("Account disabled.",403);}
    else{u=new User({name:D.text(input.name,"your name",60,2),email:a.email,password:D.password(input.password),role:"customer"});await u.save({session});}
    a.owner=u._id;a.status="pending";a.acceptance={actor:String(u._id),digest:a.termsDigest,acceptedAt:new Date(),method:"explicit-invitation-acceptance-v1"};a.invitation=undefined;await a.save({session});
    await audit(u,a._id,a._id,"supplier-activated",null,{termsDigest:a.termsDigest,status:a.status},"Supplier claimed invitation and accepted terms; admin approval still required.",session);
    return {...sessionFor(u),account:safeAccount(a)};
  });
}
async function invitationInfo(code){if(!/^[a-f\d]{64}$/i.test(code||""))D.fail("Invalid invitation.");const a=await M.Account.findOne({"invitation.hash":D.digest(code),"invitation.expiresAt":{$gt:new Date()}});if(!a||a.owner)D.fail("Invitation is invalid or expired.",404);return {businessName:a.business.legalName,terms:a.terms,termsDigest:a.termsDigest};}
async function login(input) {D.object(input,["email","password"],"Supplier sign-in");const e=D.email(input.email);const a=await M.Account.findOne({email:e,owner:{$exists:true},status:{$ne:"archived"}});const u=a?await User.findById(a.owner).select("+password +authVersion"):null;if(!u||u.isActive===false||!await u.comparePassword(input.password))D.fail("Supplier email or password is incorrect.",401);return {...sessionFor(u),account:safeAccount(a)};}
async function regenerateInvitation(actor,aid,input) {actorRequired(actor,true);return transaction(async s=>{const a=await account(actor,aid,s);expect(a,input.revision);if(a.owner)D.fail("This supplier already activated their account.",409);const code=crypto.randomBytes(32).toString("hex");a.invitation={hash:D.digest(code),expiresAt:new Date(Date.now()+48*3600000)};await a.save({session:s});await audit(actor,a._id,a._id,"invitation-reissued",null,{expiresAt:a.invitation.expiresAt},"Previous invitation revoked; no email sent.",s);return {account:safeAccount(a,true),invitationCode:code,invitationExpiresAt:a.invitation.expiresAt};});}
async function updateAccount(actor,aid,input,admin=false) {
  actorRequired(actor,admin);D.object(input,admin?["revision","business","terms","notes","reason"]:["revision","business"],"Supplier profile");
  return transaction(async s=>{const a=await account(actor,aid,s);expect(a,input.revision);const before={business:a.business,termsDigest:a.termsDigest,status:a.status};
    if(input.business)a.business=D.business(input.business);
    if(admin&&input.notes!==undefined)a.notes=D.text(input.notes,"internal notes",2000);
    if(admin&&input.terms){a.terms=D.terms(input.terms);a.termsDigest=D.digest(a.terms);if(a.acceptance?.digest!==a.termsDigest)a.acceptance=null;}
    if(input.business||input.terms){a.status=a.owner?"pending":"invited";await Product.updateMany({marketplaceAccount:a._id},{$set:{isActive:false}},{session:s});}
    await a.save({session:s});await audit(actor,a._id,a._id,"supplier-profile-updated",before,{business:a.business,termsDigest:a.termsDigest,status:a.status},D.text(input.reason||"Business changes await admin review.","reason",1000),s);return {account:safeAccount(a,admin)};});
}
async function acceptTerms(actor,input){return transaction(async s=>{const a=await account(actor,null,s);expect(a,input.revision);if(input.accept!==true||input.digest!==a.termsDigest)D.fail("Accept the exact current terms.",409);a.acceptance={actor:String(actor._id),digest:a.termsDigest,acceptedAt:new Date(),method:"explicit-authenticated-acceptance-v1"};await a.save({session:s});await audit(actor,a._id,a._id,"terms-accepted",null,{digest:a.termsDigest},"Explicit supplier acceptance; admin approval remains separate.",s);return {account:safeAccount(a)};});}
async function setStatus(actor,aid,input) {
  actorRequired(actor,true);D.object(input,["revision","status","reason"],"Supplier status");if(!["active","suspended","archived","pending"].includes(input.status))D.fail("Choose supplier status.");const reason=D.text(input.reason,"status reason",1000,5);
  return transaction(async s=>{const a=await account(actor,aid,s);expect(a,input.revision);const before=a.status;
    if(input.status==="active"&&(!a.owner||a.acceptance?.digest!==a.termsDigest))D.fail("Supplier must activate and accept current terms before approval.",409);
    a.status=input.status;const supplier=await Supplier.findById(a.supplier).select(PRIVATE_SUPPLIER).session(s);if(!supplier)D.fail("Linked supplier missing.",409);
    if(a.status==="active"){supplier.name=a.business.legalName;supplier.status="active";supplier.contact={name:a.business.contactName,email:a.email,phone:a.business.phone};supplier.verification={status:"verified",verifiedBy:actor._id,verifiedAt:new Date(),notes:reason};supplier.fulfillment={dispatchToCustomer:true,sendToPackingLocation:false,preparationDaysMin:a.terms.dispatchDaysMin,preparationDaysMax:a.terms.dispatchDaysMax};}
    else{supplier.status=a.status==="archived"?"archived":"blocked";await Product.updateMany({marketplaceAccount:a._id},{$set:{isActive:false}},{session:s});}
    await supplier.save({session:s});await a.save({session:s});await audit(actor,a._id,a._id,"supplier-status",{status:before},{status:a.status},reason,s);return {account:safeAccount(a,true)};});
}
async function listAccounts(actor,q={}) {actorRequired(actor,true);const filter={};if(q.status)filter.status=D.text(q.status,"status",30);if(q.search){const escaped=D.text(q.search,"search",100).replace(/[.*+?^${}()|[\]\\]/g,"\\$&");filter.$or=[{"business.legalName":new RegExp(escaped,"i")},{email:new RegExp(escaped,"i")}];}const page=Math.max(1,Math.min(10000,Number(q.page)||1));const [rows,total]=await Promise.all([M.Account.find(filter).select("+notes").sort({_id:-1}).skip((page-1)*20).limit(20),M.Account.countDocuments(filter)]);return {accounts:rows.map(a=>safeAccount(a,true)),page,total,pages:Math.max(1,Math.ceil(total/20))};}
async function listingFor(actor,lid,s,active=false){const l=await M.Listing.findById(D.id(lid)).session(s||null);if(!l)D.fail("Listing not found.",404);const a=await account(actor,String(l.supplier),s,active);return {l,a};}
async function saveDraft(actor,lid,input) {
  D.object(input,["revision","draft"],"Listing save");const d=D.draft(input.draft);
  return transaction(async s=>{const a=await account(actor,null,s,true);await validateMedia(d,a.owner,s);let l;if(lid){({l}=await listingFor(actor,lid,s,true));expect(l,input.revision);if(l.status==="submitted")D.fail("Withdraw or wait for the current review before editing.",409);l.draft=d;l.status="draft";}else l=new M.Listing({supplier:a._id,draft:d});await l.save({session:s});await audit(actor,a._id,l._id,"listing-draft",null,{revision:revision(l)},"Draft saved; approved live content is unchanged.",s);return {listing:safeListing(l)};});
}
async function submit(actor,lid,input){return transaction(async s=>{const {l,a}=await listingFor(actor,lid,s,true);expect(l,input.revision);if(!["draft","changes-requested","rejected"].includes(l.status))D.fail("Save a draft before submission.",409);l.draft=D.draft(l.draft,true);if(!a.business.categories.includes(l.draft.category))D.fail("This category is not in the approved business profile.",409);await validateMedia(l.draft,a.owner,s);if(!a.business.brands.includes(l.draft.brand))D.fail("This brand is not in the supplier's approved business profile.",409);l.status="submitted";l.submittedAt=new Date();l.feedback="";await l.save({session:s});await audit(actor,a._id,l._id,"listing-submitted",null,{revision:revision(l)},"Supplier prices and promotion contributions submitted for explicit admin review.",s);return {listing:safeListing(l)};});}
function stockShape(rows){const colors=[...new Set(rows.map(v=>v.color).filter(Boolean))],sizes=[...new Set(rows.map(v=>v.size).filter(Boolean))];const variants={};for(const v of rows){if(colors.length){if(sizes.length){variants[v.color] ||= {};variants[v.color][v.size]=v.stock;}else variants[v.color]=v.stock;}else if(sizes.length)variants[v.size]=v.stock;}return {colors,sizes,variants,stock:rows.reduce((n,v)=>n+v.stock,0)};}
async function review(actor,lid,input) {
  actorRequired(actor,true);
  D.object(input,["revision","decision","reason","prices","content"],"Listing review");
  if(!["approved","published","changes-requested","rejected","paused","archived"].includes(input.decision))D.fail("Choose review decision.");
  const reason=D.text(input.reason,"review reason",1000,3);
  return transaction(async session=>{
    const {l,a}=await listingFor(actor,lid,session);expect(l,input.revision);
    const before={live:l.live,approvedCandidate:l.approvedCandidate,status:l.status};
    if(["approved","published"].includes(input.decision)){
      const publicFulfilmentName = D.text(input.content?.publicFulfilmentName ?? l.approvedCandidate?.publicFulfilmentName ?? l.live?.publicFulfilmentName ?? "", "public fulfilment name", 100);
      if(a.status!=="active"||a.acceptance?.digest!==a.termsDigest)D.fail("Activate supplier with accepted terms first.",409);
      if(!["submitted","approved","paused","published"].includes(l.status))D.fail("Submit content before approval or publication.",409);
      let draft=D.draft(l.draft,true);await validateMedia(draft,a.owner,session);
      if(input.content){D.object(input.content,["name","description","specifications","careInstructions","returnConditions","publicFulfilmentName"],"Customer content edit");const { publicFulfilmentName: _publicName, ...content } = input.content;draft=D.draft({...draft,...content},true);}
      const prices=D.reviewPrices(draft,input.prices);
      const candidate={...draft,publicFulfilmentName,variants:prices,terms:a.terms,termsDigest:a.termsDigest,approvedBy:String(actor._id),approvedAt:new Date(),offerRevision:l.offerRevision+1};
      l.approvedCandidate=candidate;
      if(input.decision==="published"){
        const product=l.product?await Product.findById(l.product).select("+marketplaceCommercial +marketplaceAccount").session(session):new Product();
        if(!product)D.fail("The published product requires administrator review.",409);
        // Sales may have reduced stock while a commercial edit awaited review.
        // Preserve current stock for existing variants; never restore a stale draft count.
        const oldRows=product.marketplaceCommercial?.variants||[];
        const rows=prices.map(row=>oldRows.some(old=>D.key(old)===D.key(row))?{...row,stock:require("../orderInventory").getVariantStock(product,row.size,row.color)}:row);
        const shape=stockShape(rows);
        const min=Math.min(...rows.map(row=>row.customerUnitAmount));
        Object.assign(product,{
          name:draft.name,slug:product.slug||`${draft.name.toLowerCase().replace(/[^a-z0-9]+/g,"-").slice(0,100)}-${product._id}`,
          brand:draft.brand,category:draft.category,description:draft.description,images:draft.images,image:draft.images[0],colorImages:draft.variantImages,
          material:draft.material,specifications:{...draft.specifications,"Size chart":draft.sizeChart,Manufacturer:draft.manufacturer,Origin:draft.origin,Warranty:draft.warranty,"Packaged weight (grams)":String(draft.weightGrams),"Package dimensions (cm)":`${draft.dimensionsCm.length} × ${draft.dimensionsCm.width} × ${draft.dimensionsCm.height}`,...(draft.batch?{Batch:draft.batch,Expiry:draft.expiryDate}:{})},
          careInstructions:draft.careInstructions,returnPolicy:draft.returnConditions,returnConditions:draft.returnConditions,returnsEligible:draft.returnsEligible,returnWindowDays:draft.returnWindowDays,returnRequestTypes:draft.returnRequestTypes,
          ...shape,publicFulfilmentName,price:min/100,discount:0,isActive:true,supplier:a.supplier,marketplaceAccount:a._id,marketplaceListing:l._id,
          marketplaceCommercial:{...candidate,variants:rows,supplierId:String(a.supplier)},
          variantPrices:rows.map(row=>({size:row.size,color:row.color,customerUnitAmount:row.customerUnitAmount,mrpUnitAmount:row.mrpUnitAmount,taxInclusive:true})),
          variantSkus:rows.map(row=>({size:row.size||"",color:row.color||"",sku:`MS-${String(a._id).slice(-8)}-${String(l._id).slice(-8)}-${D.digest(row.supplierSku).slice(0,12)}`})),
          fulfillment:{stockSource:"supplier",dispatchBy:"supplier",preparationDaysMin:draft.shippingLeadDays,preparationDaysMax:draft.shippingLeadDays,supplierStockConfirmedAt:new Date()}
        });
        product.$locals.marketplaceWrite=true;await product.save({session});l.product=product._id;l.live={...candidate,variants:rows};l.offerRevision=candidate.offerRevision;
      }
    }else if(["paused","archived"].includes(input.decision)&&l.product){await Product.updateOne({_id:l.product},{$set:{isActive:false}},{session});}
    else if(!["submitted","draft","changes-requested"].includes(l.status))D.fail("Request changes on a submitted draft.",409);
    l.status=input.decision;l.feedback=reason;l.reviewedBy=actor._id;l.reviewedAt=new Date();await l.save({session});
    await audit(actor,a._id,l._id,"listing-review",before,{live:l.live,approvedCandidate:l.approvedCandidate,status:l.status},reason,session);
    return {listing:safeListing(l)};
  });
}

async function updateStock(actor,lid,input){D.object(input,["revision","variants","stockDigest"],"Stock update");return transaction(async s=>{const {l,a}=await listingFor(actor,lid,s,true);expect(l,input.revision);if(l.live&&(await hydratedListing(l,s)).stockDigest!==input.stockDigest)D.fail("Stock changed after the page loaded. Reload before updating live quantities.",409,"MARKETPLACE_STOCK_CHANGED");if(!Array.isArray(input.variants))D.fail("Provide stock rows.");const source=l.live?.variants||l.draft.variants;const rows=source.map(v=>{const n=input.variants.find(n=>D.key(n)===D.key(v));if(!n)D.fail("Update every existing stock variant.");D.object(n,["size","color","stock"],"Stock row");return {...v,stock:D.integer(n.stock,"Stock",0,1000000)};});if(input.variants.length!==rows.length)D.fail("Stock updates cannot introduce variants.");const shape=stockShape(rows);if(shape.stock>1000000)D.fail("Combined stock exceeds limit.");
  if(l.live){l.live={...l.live,variants:rows};const p=await Product.findById(l.product).select("+marketplaceAccount").session(s);if(!p)D.fail("Product missing.",409);Object.assign(p,shape);p.$locals.marketplaceWrite=true;await p.save({session:s});}
  l.draft={...l.draft,variants:l.draft.variants.map(v=>{const r=rows.find(n=>D.key(n)===D.key(v));return r?{...v,stock:r.stock}:v;})};await l.save({session:s});await audit(actor,a._id,l._id,"stock-updated",null,{variants:rows.map(v=>({size:v.size,color:v.color,stock:v.stock}))},"Routine stock update; prices and content unchanged.",s);return {listing:safeListing(l)};});}
async function listListings(actor,q={}){actorRequired(actor);let filter={};if(actor.role!=="admin"){const a=await account(actor);filter.supplier=a._id;}else if(q.supplier)filter.supplier=D.id(q.supplier);if(q.status)filter.status=D.text(q.status,"status",30);const page=Math.max(1,Number(q.page)||1);const rows=await M.Listing.find(filter).sort({_id:-1}).skip((page-1)*20).limit(20);return {listings:await Promise.all(rows.map(l=>hydratedListing(l))),total:await M.Listing.countDocuments(filter),page};}
async function savePayment(actor,input){D.object(input,["details","currentPassword","reauthToken"],"Payment destination");await reauthenticate(actor,input);const details=D.paymentDetails(input.details);return transaction(async s=>{const a0=await account(actor,null,s);const a=await lockAccount(a0._id,s);a.paymentVersion++;const encrypted=D.seal(details,process.env.MARKETPLACE_DATA_KEY,`${a._id}:${a.paymentVersion}`);const dest=new M.Destination({supplier:a._id,version:a.paymentVersion,encrypted,masked:D.maskPayment(details)});await dest.save({session:s});await a.save({session:s});await audit(actor,a._id,dest._id,"payment-destination-changed",null,{version:dest.version,status:"pending",masked:dest.masked},"Reauthenticated supplier submission. Previous destinations retained; admin reverification required.",s);return {destination:safeDestination(dest)};});}
function safeDestination(d){const p=plain(d);return {id:String(p._id),supplierId:String(p.supplier),version:p.version,masked:p.masked,status:p.status,verifiedAt:p.verifiedAt,reason:p.reason||"",revision:revision(p)};}
async function getPayment(actor,aid){const a=await account(actor,aid);const d=await M.Destination.findOne({supplier:a._id,version:a.paymentVersion});return {destination:d?safeDestination(d):null};}
async function verifyPayment(actor,did,input){actorRequired(actor,true);D.object(input,["revision","status","reason"],"Destination verification");if(!["verified","rejected"].includes(input.status))D.fail("Choose verification result.");const reason=D.text(input.reason,"verification evidence",1000,5);return transaction(async s=>{const d=await M.Destination.findById(D.id(did)).session(s);if(!d)D.fail("Destination missing.",404);expect(d,input.revision);const a=await lockAccount(d.supplier,s);if(d.version!==a.paymentVersion)D.fail("The destination changed. Review the latest version.",409);if(d.status!=="pending")D.fail("This verification is already recorded.",409);d.status=input.status;d.verifiedBy=actor._id;d.verifiedAt=new Date();d.reason=reason;await d.save({session:s});await audit(actor,a._id,d._id,"payment-destination-verified",null,{status:d.status,version:d.version},reason,s);return {destination:safeDestination(d)};});}
async function revealPayment(actor,did,input){actorRequired(actor,true);await reauthenticate(actor,input);const reason=D.text(input.reason,"access purpose",1000,5);return transaction(async s=>{const d=await M.Destination.findById(D.id(did)).select("+encrypted").session(s);if(!d)D.fail("Destination missing.",404);await audit(actor,d.supplier,d._id,"private-payment-destination-viewed",null,{version:d.version},reason,s);return {destinationId:String(d._id),version:d.version,details:D.unseal(d.encrypted,process.env.MARKETPLACE_DATA_KEY,`${d.supplier}:${d.version}`)};});}

async function validateMedia(draft,owner,session){
  for(const url of [...draft.images,...draft.variantImages.flatMap(row=>row.images)]){
    const match=String(url).match(/\/api\/marketplace\/media\/([a-f\d]{24})$/i);if(!match)continue;
    if(!await M.Media.exists({_id:match[1],owner,kind:"product"}).session(session||null))D.fail("This upload does not belong to the supplier. Choose an authorized product image.",403);
  }
}
async function hydratedListing(l,session){
  const safe=safeListing(l);if(!l.live||!l.product)return safe;
  const p=await Product.findById(l.product).session(session||null);if(!p)return safe;
  safe.live={...safe.live,variants:safe.live.variants.map(row=>({...row,stock:require("../orderInventory").getVariantStock(p,row.size,row.color)}))};safe.publiclyAvailable=p.isActive===true;safe.stockDigest=D.digest(safe.live.variants.map(({size,color,stock})=>({size,color,stock})));return safe;
}
async function changePassword(actor,input){
  D.object(input,["currentPassword","reauthToken","newPassword"],"Password change");await account(actor);await reauthenticate(actor,input);const next=D.password(input.newPassword);
  return transaction(async session=>{const user=await User.findById(actor._id).select("+password +authVersion").session(session);if(!user)D.fail("Sign in again.",401);user.password=next;user.authVersion=(user.authVersion||0)+1;await user.save({session});await audit(actor,null,user._id,"supplier-password-changed",null,{sessionsRevoked:true},"Reauthenticated supplier changed their own password.",session);return sessionFor(user);});
}
async function financialPreview(actor,lid,input){
  actorRequired(actor,true);D.object(input,["prices","coupon"],"Financial preview");const {l}=await listingFor(actor,lid);const rows=D.reviewPrices(D.draft(l.draft,true),input.prices),P=require("../orderPricing");
  const subtotal=rows.reduce((sum,row)=>sum+row.customerUnitAmount,0);if(input.coupon&&!P.resolveCoupon(input.coupon))D.fail("Coupon is not configured on the server.");
  const discounts=D.allocateExact(Math.round(P.calculateCouponDiscount(subtotal/100,input.coupon)*100),rows.map(row=>row.customerUnitAmount));
  const values=rows.map((row,i)=>D.lineFinance(row,1,discounts[i]));const preview=values.reduce((sum,row)=>{for(const key of Object.keys(row))sum[key]=(sum[key]||0)+row[key];return sum;},{});
  return {preview:{...preview,notice:"One unit of each submitted variant. Existing coupon rules and protected supplier amounts applied. No promotion activated; shipping, actual fees and tax liabilities need separate reconciliation."}};
}

module.exports={hydratedListing,changePassword,financialPreview,M,D,enabled,plain,revision,transaction,actorRequired,expect,audit,account,lockAccount,safeAccount,safeListing,safeDestination,reauthenticate,createAccount,activate,invitationInfo,login,regenerateInvitation,updateAccount,acceptTerms,setStatus,listAccounts,listingFor,saveDraft,submit,review,updateStock,listListings,savePayment,getPayment,verifyPayment,revealPayment,stockShape};
