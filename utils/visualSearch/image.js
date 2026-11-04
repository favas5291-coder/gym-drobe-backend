const MAX_BYTES=8*1024*1024;
async function normalizeImage(bytes){
 if(!Buffer.isBuffer(bytes)||!bytes.length||bytes.length>MAX_BYTES)throw Object.assign(new Error('Choose a JPEG, PNG or WebP photo under 8 MB.'),{status:400});
 try { const sharp=require('sharp'),image=sharp(bytes,{limitInputPixels:24000000,animated:false,failOn:'warning'}),m=await image.metadata();
 if(!['jpeg','png','webp'].includes(m.format)||m.pages>1||m.width<32||m.height<32||m.width>12000||m.height>12000)throw new Error();
 return await image.rotate().resize({width:1024,height:1024,fit:'inside',withoutEnlargement:true}).flatten({background:'#fff'}).jpeg({quality:88}).toBuffer();
 }catch{throw Object.assign(new Error('This photo could not be read. Use JPEG, PNG or WebP, between 32 pixels and 24 megapixels.'),{status:400});}
}
module.exports={MAX_BYTES,normalizeImage};
