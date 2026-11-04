const https=require('node:https'),dns=require('node:dns'),net=require('node:net');
const {MAX_BYTES}=require('./image');const blocked=new net.BlockList();
for(const [ip,prefix]of[['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.168.0.0',16],['198.18.0.0',15],['224.0.0.0',4],['240.0.0.0',4]])blocked.addSubnet(ip,prefix,'ipv4');
function publicAddress(ip,family){return family===4?!blocked.check(ip,'ipv4'):/^[23][\da-f]{0,3}:/i.test(ip);}
function catalogueURL(source,env=process.env){const url=new URL(source,env.VISUAL_SEARCH_CATALOGUE_ORIGIN),hosts=String(env.VISUAL_SEARCH_IMAGE_HOSTS||'').split(',').map(s=>s.trim().toLowerCase()).filter(Boolean);if(url.protocol!=='https:'||url.username||url.password||(url.port&&url.port!=='443')||!hosts.includes(url.hostname.toLowerCase()))throw new Error('Unapproved image host');return url;}
function download(source){return new Promise((resolve,reject)=>{
 const request=https.get(catalogueURL(source),{timeout:10000,lookup(host,options,done){dns.lookup(host,{all:true},(error,rows)=>{if(error||!rows?.length||rows.some(r=>!publicAddress(r.address,r.family)))return done(new Error('Blocked image address'));options?.all?done(null,rows):done(null,rows[0].address,rows[0].family);});}},response=>{
  if(response.statusCode!==200){response.resume();reject(new Error('Image unavailable; redirects need canonical URLs'));return;}let size=0;const parts=[];
  response.on('data',part=>{size+=part.length;if(size>MAX_BYTES)request.destroy(new Error('Image too large'));else parts.push(part);});response.on('end',()=>resolve(Buffer.concat(parts)));response.on('error',reject);
 });const timer=setTimeout(()=>request.destroy(new Error('Image timeout')),15000);request.on('close',()=>clearTimeout(timer));request.on('timeout',()=>request.destroy(new Error('Image timeout')));request.on('error',reject);
});}
module.exports={publicAddress,catalogueURL,download};
