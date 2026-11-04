const express=require('express'),Product=require('../models/Product'),Index=require('../models/VisualSearchIndex'),State=require('../models/VisualSearchState');
const {configured,embed}=require('../utils/visualSearch/model'),{normalizeImage,MAX_BYTES}=require('../utils/visualSearch/image'),{MODEL,rank}=require('../utils/visualSearch/domain');
const router=express.Router(),buckets=new Map();
function limit(req,res,next){const now=Date.now(),key=req.ip;for(const[ip,b]of buckets)if(b.until<now)buckets.delete(ip);if(!buckets.has(key)&&buckets.size>=10000)return res.status(429).json({message:'Photo search is busy. Try again shortly.'});const b=buckets.get(key)||{until:now+60000,count:0};buckets.set(key,b);if(++b.count>10){res.set('Retry-After','60');return res.status(429).json({message:'Please wait a minute before trying again.'});}next();}
async function snapshot(){if(!configured())return null;const state=await State.findOne({_id:'catalogue',model:MODEL,count:{$gt:0}}).lean();return state&&Date.now()-state.indexedAt.getTime()<48*3600000?state:null;}
router.use((req,res,next)=>{res.set('Cache-Control','no-store');next();});
router.get('/status',limit,async(req,res)=>{try{res.json({available:Boolean(await snapshot()),maxBytes:MAX_BYTES,formats:['image/jpeg','image/png','image/webp']});}catch{res.status(503).json({available:false,message:'Photo search is unavailable. Please search by name.'});}});
router.post('/',limit,async(req,res,next)=>{try{if(!await snapshot())return res.status(503).json({message:'Photo search is not available yet. Please search by name.'});next();}catch{res.status(503).json({message:'Photo search is unavailable. Please search by name.'});}},express.raw({type:['image/jpeg','image/png','image/webp'],limit:MAX_BYTES,inflate:false}),async(req,res)=>{
 try{
  const state=await snapshot();if(!state)return res.status(503).json({message:'Photo search is unavailable. Please search by name.'});
  const query=await embed(await normalizeImage(req.body));
  const[rows,products]=await Promise.all([Index.find({generation:state.generation,model:MODEL}).limit(20000).lean(),Product.find({isActive:true}).select('_id name slug price originalPrice discount stock stockStatus image images colorImages isActive colors sizes variants category brand').lean()]);
  const threshold=Number(process.env.VISUAL_SEARCH_THRESHOLD||'0.78');if(!Number.isFinite(threshold)||threshold<0.5||threshold>1)throw new Error();
  const results=rank(query,rows,products,threshold).map(({product,score})=>({...product,id:String(product._id),similarity:Math.round(score*1000)/1000,matchType:'visually-similar'}));
  res.json({products:results,matchType:'visually-similar',message:results.length?'Visually similar products. An exact match has not been verified.':'No close matches found. Try another photo or search by name.'});
 }catch(e){res.status(e.status||503).json({message:e.status?e.message:'Photo search failed. Please retry or search by name.'});}
});
router.use((error,req,res,next)=>res.status(error.type==='entity.too.large'?413:400).json({message:'Choose a JPEG, PNG or WebP photo under 8 MB.'}));
module.exports=router;
