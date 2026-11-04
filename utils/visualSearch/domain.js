const crypto = require('node:crypto');
const MODEL = 'clip-patch16-b5170b47-wasm-v1';
function sources(p) { return [...new Set([p.image,...(p.images||[]),...(p.colorImages||[]).flatMap(r=>r.images||[])].filter(s=>typeof s==='string'&&s.trim()).map(s=>s.trim()))]; }
function fingerprint(p) { return crypto.createHash('sha256').update(JSON.stringify(sources(p))).digest('hex'); }
function unit(v) { if(!Array.isArray(v)||v.length!==512||v.some(n=>!Number.isFinite(n)))throw new Error('Invalid embedding'); const length=Math.hypot(...v); if(length<1e-8)throw new Error('Empty embedding');return v.map(n=>n/length); }
function rank(query,rows,products,threshold,limit=24){
 const q=unit(query), current=new Map(products.map(p=>[String(p._id),p])),best=new Map();
 for(const row of rows){const p=current.get(String(row.productId));if(!p||p.isActive!==true||row.fingerprint!==fingerprint(p))continue;
 let v;try{v=unit(row.vector);}catch{continue;}const score=q.reduce((s,n,i)=>s+n*v[i],0);
 if(score<threshold||score<=(best.get(String(p._id))?.score??-1))continue;best.set(String(p._id),{product:p,score});}
 return [...best.values()].sort((a,b)=>Number(b.product.stock>0)-Number(a.product.stock>0)||b.score-a.score).slice(0,limit);
}
module.exports={MODEL,sources,fingerprint,unit,rank};
