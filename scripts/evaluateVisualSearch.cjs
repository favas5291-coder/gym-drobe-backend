// Read-only catalogue smoke evaluation. Cropped references are NOT independent camera photos.
const fs=require('node:fs'),sharp=require('sharp');
const{sources,fingerprint,rank}=require('../utils/visualSearch/domain'),{normalizeImage}=require('../utils/visualSearch/image'),{download}=require('../utils/visualSearch/catalogueImage'),model=require('../utils/visualSearch/model');
(async()=>{
 const products=JSON.parse(fs.readFileSync(process.argv[2],'utf8')).products.map(p=>({...p,_id:p._id||p.id})),rows=[],checks=[],errors=[];
 for(const p of products.slice(0,12)){try{
  const bytes=await normalizeImage(await download(sources(p)[0]));rows.push({productId:p._id,fingerprint:fingerprint(p),vector:await model.embed(bytes)});
  const m=await sharp(bytes).metadata(),crop=await sharp(bytes).extract({left:Math.floor(m.width*.08),top:Math.floor(m.height*.08),width:Math.floor(m.width*.84),height:Math.floor(m.height*.84)}).jpeg({quality:75}).toBuffer();
  checks.push({product:p,query:await model.embed(crop)});console.log('Evaluated public catalogue photo',checks.length);
 }catch{errors.push({id:String(p._id),error:'Catalogue photo unavailable'});}}
 const results=checks.map(({product,query})=>{const matches=rank(query,rows,products,.78);return{productId:String(product._id),rank:matches.findIndex(r=>String(r.product._id)===String(product._id))+1,topScore:matches[0]?.score??null,returned:matches.length};});
 const blank=await normalizeImage(await sharp({create:{width:500,height:500,channels:3,background:'#888'}}).jpeg().toBuffer()),negativeMatches=rank(await model.embed(blank),rows,products,.78).length;
 const report={model:'CLIP patch16 fp32, pinned SHA b5170b47',runtime:'onnxruntime-web/wasm 1.31.1',threshold:.78,queryType:'cropped catalogue references, not independent photos',indexedReferences:rows.length,results,errors,top1:results.filter(r=>r.rank===1).length,blankImageMatches:negativeMatches};fs.writeFileSync(process.argv[3],JSON.stringify(report,null,2));console.log(JSON.stringify({tested:results.length,top1:report.top1,blankImageMatches:negativeMatches,errors:errors.length}));
})().catch(()=>{console.error('Visual-search evaluation failed');process.exitCode=1;}).finally(model.close);
