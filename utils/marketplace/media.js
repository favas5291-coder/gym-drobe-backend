"use strict";
const {M,D,transaction,actorRequired,audit}=require("./service");
let processing=false;
const origin=()=>process.env.MARKETPLACE_PUBLIC_API_ORIGIN||"https://gym-drobe-backend.onrender.com";
const mediaUrl=id=>`${origin()}/api/marketplace/media/${id}`;
async function upload(actor,input){
  actorRequired(actor);D.object(input,["kind","mime","base64"],"Image upload");
  if(!["product","payout-proof"].includes(input.kind)||!["image/jpeg","image/png","image/webp"].includes(input.mime))D.fail("Upload a JPEG, PNG or WebP image.",415);
  if(input.kind==="payout-proof"&&actor.role!=="admin")D.fail("Admin access required.",403);
  if(actor.role!=="admin"&&!await M.Account.exists({owner:actor._id,status:"active"}))D.fail("Active supplier access required.",403);
  if(typeof input.base64!=="string"||input.base64.length>720000||input.base64.length%4!==0||!/^[A-Za-z0-9+/]*={0,2}$/.test(input.base64))D.fail("Choose an image under 512 KiB; the picker compresses photos before upload.",413);
  const inputBytes=Buffer.from(input.base64,"base64");if(!inputBytes.length||inputBytes.length>524288)D.fail("Choose an image under 512 KiB.",413);
  if(processing)D.fail("Another image is processing. Retry shortly.",429);processing=true;
  let data,thumbnail,width,height;
  try{
    const sharp=require("sharp");sharp.cache(false);sharp.concurrency(1);
    const pipeline=sharp(inputBytes,{failOn:"warning",limitInputPixels:12000000,animated:false}),meta=await pipeline.metadata();
    if(({jpeg:"image/jpeg",png:"image/png",webp:"image/webp"}[meta.format])!==input.mime||!meta.width||!meta.height||meta.width>8000||meta.height>8000||meta.width<32||meta.height<32||(meta.pages||1)!==1)D.fail("Use one photo, at least 32px and at most 12 megapixels.",415);
    const out=await pipeline.rotate().resize(1280,1280,{fit:"inside",withoutEnlargement:true}).webp({quality:80}).toBuffer({resolveWithObject:true});
    data=out.data;width=out.info.width;height=out.info.height;if(data.length>491520)D.fail("Crop this image and retry; it is still too large after compression.",413);
    thumbnail=await sharp(data).resize(180,180,{fit:"inside"}).webp({quality:50}).toBuffer();
  }catch(error){if(error.status)throw error;D.fail("This image could not be decoded. Choose another photo.",415);}finally{processing=false;}
  const hash=D.digest(data.toString("base64"));
  return transaction(async s=>{
    const previous=await M.Media.findOne({owner:actor._id,digest:hash,kind:input.kind}).select("+thumbnail").session(s);if(previous)return {media:serialize(previous)};
    const bytes=data.length+thumbnail.length;
    // All upload transactions share the global quota lock before the owner row.
    const global=await M.Quota.findOneAndUpdate({_id:"global",bytes:{$lte:67108864-bytes}},{$inc:{bytes}},{new:true,session:s});if(!global)D.fail("The free image allowance is full or not initialized. Ask admin to review storage.",413);
    const owner=`owner:${actor._id}`;if(!await M.Quota.exists({_id:owner}).session(s))await M.Quota.create([{_id:owner,bytes:0}],{session:s});
    if(!await M.Quota.findOneAndUpdate({_id:owner,bytes:{$lte:8388608-bytes}},{$inc:{bytes}},{new:true,session:s}))D.fail("Your image allowance is full. Remove unused draft images.",413);
    const m=new M.Media({owner:actor._id,kind:input.kind,content:data,thumbnail,size:bytes,width,height,digest:hash});await m.save({session:s});return {media:serialize(m)};
  });
}
function serialize(m){return {id:String(m._id),url:mediaUrl(m._id),width:m.width,height:m.height,size:m.size,kind:m.kind,preview:m.thumbnail?`data:image/webp;base64,${Buffer.from(m.thumbnail).toString("base64")}`:null};}
async function get(actor,id){const m=await M.Media.findById(D.id(id)).select("+content");if(!m)D.fail("Image not found.",404);
  const published=m.kind==="product"&&await require("../../models/Product").exists({isActive:true,images:mediaUrl(m._id)});
  if(!published&&(!actor||actor.isActive===false||(actor.role!=="admin"&&String(m.owner)!==String(actor._id))))D.fail("Image not found.",404);
  return {buffer:m.content,mime:m.mime,public:Boolean(published)};
}
async function previews(actor,urls){actorRequired(actor);const result={};for(const url of urls||[]){const match=String(url).match(/\/api\/marketplace\/media\/([a-f\d]{24})$/i);if(!match)continue;const filter={_id:match[1],kind:"product"};if(actor.role!=="admin")filter.owner=actor._id;const m=await M.Media.findOne(filter).select("+thumbnail");if(m)result[url]=`data:image/webp;base64,${Buffer.from(m.thumbnail).toString("base64")}`;}return result;}
async function remove(actor,mid){actorRequired(actor);return transaction(async s=>{const filter={_id:D.id(mid)};if(actor.role!=="admin")filter.owner=actor._id;const m=await M.Media.findOne(filter).session(s);if(!m)D.fail("Image not found.",404);const url=mediaUrl(m._id);
  if(await M.Listing.exists({$or:[{"draft.images":url},{"live.images":url},{"draft.variantImages.images":url},{"live.variantImages.images":url}]}).session(s)||await M.Payout.exists({proof:m._id}).session(s))D.fail("Remove the image from drafts first. Published images and payout evidence cannot be removed.",409);
  for(const key of ["global",`owner:${m.owner}`])await M.Quota.updateOne({_id:key},{$inc:{bytes:-m.size}},{session:s});await M.Media.deleteOne({_id:m._id},{session:s});await audit(actor,null,m._id,"unused-media-removed",null,{size:m.size},"Unreferenced upload removed by its owner/admin.",s);return {removed:true};
});}
module.exports={upload,get,previews,remove,mediaUrl};
