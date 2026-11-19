"use strict";
const dns = require("node:dns").promises;
const https = require("node:https");
const http = require("node:http");
const ipaddr = require("ipaddr.js");

function publicAddress(address) {
  const ip = ipaddr.parse(address);
  return ip.kind() === "ipv4" && ip.range() === "unicast" &&
    !["192.0.0.0/24","192.88.99.0/24","198.18.0.0/15","192.0.2.0/24","198.51.100.0/24","203.0.113.0/24"].some(cidr => ip.match(ipaddr.parseCIDR(cidr)));
}

async function readPublic(input, image = false) {
  const signal = AbortSignal.timeout(8000);
  let url = new URL(input);
  for (let redirects = 0; redirects <= 3; redirects++) {
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.port || url.href.length > 2048)
      throw Error("Enter a public product URL.");
    const records = await Promise.race([dns.lookup(url.hostname, {all:true, family:4}), new Promise((_,reject) =>
      signal.addEventListener("abort", () => reject(Error("Source timed out.")), {once:true}))]);
    signal.throwIfAborted();
    if (!records.length || !records.every(r => publicAddress(r.address))) throw Error("Source unavailable.");
    const response = await new Promise((resolve,reject) => {
      const transport = url.protocol === "https:" ? https : http;
      transport.get(url, {signal, agent:false, family:4, headers:{Accept:image?"image/jpeg,image/png,image/webp":"text/html","Accept-Encoding":"identity"},
        lookup:(_host,opts,cb)=>opts.all?cb(null,[records[0]]):cb(null,records[0].address,4)}, resolve).on("error",reject);
    });
    if ([301,302,303,307,308].includes(response.statusCode)) {
      response.destroy();
      url = new URL(response.headers.location, url);
      continue;
    }
    const type = String(response.headers["content-type"]||"").split(";")[0].trim().toLowerCase();
    if(response.statusCode!==200 || !(image?["image/jpeg","image/png","image/webp"]:["text/html","application/xhtml+xml"]).includes(type)){
      response.destroy();throw Error("Unsupported source.");
    }
    const chunks=[];let bytes=0;
    for await(const part of response){bytes+=part.length;if(bytes>(image?524288:1500000)){response.destroy();throw Error("Source exceeds the download limit.");}chunks.push(part);}
    return {buffer:Buffer.concat(chunks),type,url:url.href};
  }
  throw Error("Too many redirects.");
}

function suggestions(html, base) {
  const nodes=[];
  for(const match of html.matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script\s*>/gi)){
    try{const parsed=JSON.parse(match[1]);for(const item of [].concat(parsed))if(item)nodes.push(...[].concat(item["@graph"]||item));}catch{}
  }
  const product=nodes.find(n=>[].concat(n?.["@type"]).includes("Product"))||{};
  const offers=[].concat(product.offers||[]).filter(Boolean);
  const values=offers.flatMap(o=>[o.price,o.lowPrice,o.highPrice]).filter(p=>p!=null && p!=="" && Number.isFinite(Number(p)) && Number(p)>=0).map(Number);
  const currencies=[...new Set(offers.map(o=>String(o.priceCurrency||"").toUpperCase()))];
  const images=[];
  for(const item of [].concat(product.image||[])){try{const url=new URL(typeof item==="string"?item:item.url||item.contentUrl,base);if(["https:","http:"].includes(url.protocol)&&!url.username&&!url.password)images.push(url.href);}catch{}}
  const str=x=>typeof x==="string"?x.trim().slice(0,200):"";
  return {name:str(product.name),category:str(product.category),images:[...new Set(images)].slice(0,12),currency:currencies.length===1?currencies[0]:"",low:values.length?Math.min(...values):null,high:values.length?Math.max(...values):null};
}
module.exports={readPublic,publicAddress,suggestions};
