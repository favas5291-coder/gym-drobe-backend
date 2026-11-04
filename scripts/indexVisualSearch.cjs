require('dotenv').config();
const mongoose=require('mongoose'),{randomUUID}=require('node:crypto');
const Product=require('../models/Product'),Index=require('../models/VisualSearchIndex'),State=require('../models/VisualSearchState');
const{MODEL,sources,fingerprint}=require('../utils/visualSearch/domain'),{normalizeImage}=require('../utils/visualSearch/image'),{download}=require('../utils/visualSearch/catalogueImage'),model=require('../utils/visualSearch/model');
(async()=>{
 if(!model.configured()||!process.env.VISUAL_SEARCH_IMAGE_HOSTS||!process.env.VISUAL_SEARCH_CATALOGUE_ORIGIN||!process.env.MONGO_URI)throw new Error('Configuration required');
 const generation=randomUUID();await mongoose.connect(process.env.MONGO_URI,{serverSelectionTimeoutMS:10000});
 try{await State.updateOne({_id:'catalogue'},{$setOnInsert:{count:0}},{upsert:true});}catch(e){if(e.code!==11000)throw e;}
 const lock=await State.findOneAndUpdate({_id:'catalogue',$or:[{leaseUntil:{$lt:new Date()}},{leaseUntil:null}]},{$set:{owner:generation,leaseUntil:new Date(Date.now()+120000)}},{new:true});if(!lock)throw new Error('Indexer busy');
 let lost=false;const heartbeat=setInterval(async()=>{try{const r=await State.updateOne({_id:'catalogue',owner:generation},{$set:{leaseUntil:new Date(Date.now()+120000)}});if(!r.matchedCount)lost=true;}catch{lost=true;}},30000);
 try{
  const products=await Product.find({isActive:true}).select('_id image images colorImages').lean();let count=0;
  for(const p of products)for(const source of sources(p)){
   if(lost||++count>20000)throw new Error('Lease lost or index capacity exceeded');
   const vector=await model.embed(await normalizeImage(await download(source)));
   await Index.create({generation,model:MODEL,productId:p._id,fingerprint:fingerprint(p),vector,indexedAt:new Date()});
  }
  if(!count||lost)throw new Error('Empty index or lease lost');
  const published=await State.updateOne({_id:'catalogue',owner:generation,leaseUntil:{$gt:new Date()}},{$set:{generation,model:MODEL,indexedAt:new Date(),count}});if(!published.matchedCount)throw new Error('Publication lease lost');
  // Keep old generations for in-flight searches. Failed rebuilds never publish.
  await Index.deleteMany({generation:{$ne:generation},indexedAt:{$lt:new Date(Date.now()-48*3600000)}});
  console.log(JSON.stringify({indexedImages:count,ready:true}));
 }finally{clearInterval(heartbeat);await State.updateOne({_id:'catalogue',owner:generation},{$unset:{owner:'',leaseUntil:''}});}
})().catch(()=>{console.error('Visual search indexing failed. Previous snapshot retained. Check model, approved image hosts, image availability and database configuration.');process.exitCode=1;}).finally(async()=>{await model.close();await mongoose.disconnect();});
