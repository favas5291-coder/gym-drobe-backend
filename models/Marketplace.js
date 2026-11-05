"use strict";
const mongoose = require("mongoose");
const { Schema } = mongoose;
const ref = name => ({type:Schema.Types.ObjectId,ref:name});
const money = {type:Number,min:0,validate:Number.isSafeInteger};
const options = {timestamps:true,optimisticConcurrency:true,strict:"throw",minimize:false};
const profile = new Schema({
  supplier:{...ref("Supplier"),required:true,immutable:true}, owner:ref("User"), email:{type:String,required:true,lowercase:true},
  status:{type:String,enum:["invited","pending","active","suspended","archived"],default:"invited"},
  business:{type:Schema.Types.Mixed,required:true}, terms:{type:Schema.Types.Mixed,required:true}, termsDigest:{type:String,required:true},
  acceptance:{type:Schema.Types.Mixed,default:null}, notes:{type:String,select:false,default:""},
  invitation:{type:Schema.Types.Mixed,select:false}, paymentVersion:{type:Number,default:0}, lockVersion:{type:Number,default:0},
},options);
profile.index({supplier:1},{unique:true}); profile.index({owner:1},{unique:true,partialFilterExpression:{owner:{$type:"objectId"}}});
profile.index({email:1},{unique:true});profile.index({"invitation.hash":1},{unique:true,partialFilterExpression:{"invitation.hash":{$type:"string"}}});
profile.index({status:1,updatedAt:-1});
const listing = new Schema({
  supplier:{...ref("MarketplaceAccount"),required:true,immutable:true}, product:ref("Product"),
  status:{type:String,enum:["draft","submitted","changes-requested","approved","published","paused","archived","rejected"],default:"draft"},
  draft:{type:Schema.Types.Mixed,required:true}, live:{type:Schema.Types.Mixed,default:null}, approvedCandidate:{type:Schema.Types.Mixed,default:null},
  offerRevision:{type:Number,default:0}, feedback:{type:String,default:""}, submittedAt:Date, reviewedAt:Date,reviewedBy:ref("User"),
},options);
listing.index({supplier:1,updatedAt:-1});listing.index({status:1,submittedAt:1});listing.index({product:1},{unique:true,partialFilterExpression:{product:{$type:"objectId"}}});
const destination = new Schema({
  supplier:{...ref("MarketplaceAccount"),required:true,immutable:true},version:{type:Number,required:true,immutable:true},
  encrypted:{type:Schema.Types.Mixed,required:true,select:false,immutable:true},masked:{type:Schema.Types.Mixed,required:true,immutable:true},
  status:{type:String,enum:["pending","verified","rejected"],default:"pending"},verifiedBy:ref("User"),verifiedAt:Date,reason:String,
},options);destination.index({supplier:1,version:1},{unique:true});
const fulfilment = new Schema({
  order:{...ref("Order"),required:true,immutable:true},supplier:{...ref("MarketplaceAccount"),required:true,immutable:true},
  itemIndices:{type:[Number],required:true,immutable:true}, status:{type:String,enum:["pending","accepted","preparing","shipped","delivered","cancelled"],default:"pending"},
  carrier:String,trackingNumber:String,trackingUrl:String,shippedAt:Date,deliveredAt:Date,history:{type:[Schema.Types.Mixed],default:[]},
},options);fulfilment.index({order:1,supplier:1},{unique:true});fulfilment.index({supplier:1,status:1,updatedAt:-1});
const entitlement = new Schema({
  order:{...ref("Order"),required:true,immutable:true},itemIndex:{type:Number,required:true,immutable:true},supplier:{...ref("MarketplaceAccount"),required:true,immutable:true},
  snapshot:{type:Schema.Types.Mixed,required:true,immutable:true},targetAmount:{...money,default:0},pendingAmount:{...money,default:0},
  resolvedQuantity:{type:Number,min:0,default:0,validate:Number.isSafeInteger},refundPending:{type:Boolean,default:false},paidAmount:{...money,default:0},reservedAmount:{...money,default:0},reversedAmount:{...money,default:0},stateDigest:String,
},options);entitlement.index({order:1,itemIndex:1},{unique:true});entitlement.index({supplier:1,createdAt:-1});
const payout = new Schema({
  supplier:{...ref("MarketplaceAccount"),required:true,immutable:true},requestKey:{type:String,required:true,immutable:true},
  items:{type:[Schema.Types.Mixed],required:true,immutable:true,default:undefined},amount:{...money,required:true,immutable:true},destination:{...ref("MarketplaceDestination"),required:true,immutable:true},
  destinationMasked:{type:Schema.Types.Mixed,required:true,immutable:true}, status:{type:String,enum:["reserved","paid","cancelled"],default:"reserved"},
  reference:String,transferDate:Date,recordedBy:ref("User"),recordedAt:Date,proof:ref("MarketplaceMedia"),reason:String,
},options);payout.index({supplier:1,requestKey:1},{unique:true});payout.index({reference:1},{unique:true,partialFilterExpression:{reference:{$type:"string"}}});
const ledger = new Schema({
  supplier:{...ref("MarketplaceAccount"),required:true,immutable:true},order:ref("Order"),entitlement:ref("MarketplaceEntitlement"),payout:ref("MarketplacePayout"),
  key:{type:String,required:true,immutable:true},kind:{type:String,required:true,immutable:true},amount:{type:Number,required:true,immutable:true,validate:Number.isSafeInteger},
  reason:{type:String,required:true,immutable:true},actor:ref("User"),detail:{type:Schema.Types.Mixed,immutable:true},
},{timestamps:{createdAt:true,updatedAt:false},strict:"throw"});ledger.index({key:1},{unique:true});ledger.index({supplier:1,createdAt:-1});
const audit = new Schema({actor:ref("User"),supplier:ref("MarketplaceAccount"),entity:String,action:String,before:Schema.Types.Mixed,after:Schema.Types.Mixed,reason:String},{timestamps:{createdAt:true,updatedAt:false},strict:"throw"});audit.index({supplier:1,createdAt:-1});
const media = new Schema({owner:{...ref("User"),required:true,immutable:true},kind:{type:String,enum:["product","payout-proof"],required:true,immutable:true},content:{type:Buffer,select:false,required:true,immutable:true},thumbnail:{type:Buffer,select:false,immutable:true},size:{type:Number,required:true,immutable:true},width:Number,height:Number,digest:{type:String,required:true,immutable:true},mime:{type:String,enum:["image/webp"],default:"image/webp",immutable:true}},options);media.index({owner:1,digest:1,kind:1},{unique:true});
const resolution = new Schema({supplier:{...ref("MarketplaceAccount"),required:true,immutable:true},order:{...ref("Order"),required:true,immutable:true},entitlement:{...ref("MarketplaceEntitlement"),required:true,immutable:true},itemIndex:{type:Number,required:true,immutable:true},requestKey:{type:String,required:true,immutable:true},kind:{type:String,enum:["cancellation","return"],required:true,immutable:true},quantity:{type:Number,required:true,min:1,immutable:true,validate:Number.isSafeInteger},customerRefundPaise:{...money,required:true,immutable:true},supplierReversalPaise:{...money,required:true,immutable:true},reason:{type:String,required:true,immutable:true},restockedQuantity:{type:Number,required:true,immutable:true},status:{type:String,enum:["refund-pending","refunded"],required:true},reference:String,refundedAt:Date,actor:{...ref("User"),required:true,immutable:true},recordedBy:ref("User")},options);resolution.index({order:1,requestKey:1},{unique:true});resolution.index({reference:1},{unique:true,partialFilterExpression:{reference:{$type:"string"}}});
const expense = new Schema({requestKey:{type:String,required:true,unique:true,immutable:true},category:{type:String,required:true,immutable:true},amount:{...money,required:true,immutable:true},date:{type:Date,required:true,immutable:true},reference:{type:String,required:true,immutable:true},reason:{type:String,required:true,immutable:true},paidBy:{type:String,enum:["platform","supplier"],required:true,immutable:true},actor:{...ref("User"),required:true,immutable:true}},options);
const quota = new Schema({_id:String,bytes:{type:Number,default:0}}, {versionKey:false});
const immutable = schema => { schema.pre("save",function(){if(!this.isNew&&this.isModified())throw new Error("Append-only record cannot be rewritten.");});for(const op of ["updateOne","updateMany","findOneAndUpdate","replaceOne","findOneAndReplace","deleteOne","deleteMany","findOneAndDelete"])schema.pre(op,function(){throw new Error("Append-only record cannot be rewritten or removed.");}); };
immutable(ledger);immutable(audit);immutable(expense);
const model=(name,schema)=>mongoose.models[name]||mongoose.model(name,schema);
module.exports={Account:model("MarketplaceAccount",profile),Listing:model("MarketplaceListing",listing),Destination:model("MarketplaceDestination",destination),Fulfilment:model("MarketplaceFulfilment",fulfilment),Entitlement:model("MarketplaceEntitlement",entitlement),Payout:model("MarketplacePayout",payout),Ledger:model("MarketplaceLedger",ledger),Audit:model("MarketplaceAudit",audit),Media:model("MarketplaceMedia",media),Quota:model("MarketplaceQuota",quota),Expense:model("MarketplaceExpense",expense),Resolution:model("MarketplaceResolution",resolution)};
