const {Worker}=require('node:worker_threads'),fs=require('node:fs'),path=require('node:path');
let worker,pending,ready=false;
function configured(env=process.env){return env.VISUAL_SEARCH_ENABLED==='true'&&!!env.VISUAL_SEARCH_MODEL_DIR&&fs.existsSync(path.join(env.VISUAL_SEARCH_MODEL_DIR,'onnx','vision_model.onnx'));}
function embed(bytes){
 if(!configured())return Promise.reject(Object.assign(new Error('Photo search is not configured.'),{status:503}));
 if(pending)return Promise.reject(Object.assign(new Error('Photo search is busy. Please retry shortly.'),{status:429}));
 return new Promise((resolve,reject)=>{
  const finish=(error,value)=>{if(!pending)return;clearTimeout(pending.timer);pending=null;error?reject(error):resolve(value);};
  pending={bytes,finish,timer:setTimeout(()=>{const previous=worker;worker=null;ready=false;previous?.terminate();finish(Object.assign(new Error('Photo search timed out. Please retry.'),{status:504}));},60000)};
  if(!worker){
   const instance=worker=new Worker(path.join(__dirname,'modelWorker.js'),{workerData:{directory:process.env.VISUAL_SEARCH_MODEL_DIR}});
   const failed=()=>{if(worker!==instance)return;worker=null;ready=false;instance.terminate();pending?.finish(Object.assign(new Error('Photo search is unavailable. Please search by name.'),{status:503}));};
   instance.on('message',m=>{if(worker!==instance)return;if(m.ready){ready=true;if(pending)instance.postMessage({bytes:pending.bytes});}else if(m.vector)pending?.finish(null,m.vector);else failed();});instance.on('error',failed);instance.on('exit',failed);
  }else if(ready)worker.postMessage({bytes});
 });
}
async function close(){const previous=worker;worker=null;ready=false;pending?.finish(new Error('Stopped'));await previous?.terminate();}
module.exports={configured,embed,close};
