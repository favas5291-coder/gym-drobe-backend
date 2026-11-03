const {parentPort,workerData}=require('node:worker_threads');
const fs=require('node:fs'),path=require('node:path'),{createHash}=require('node:crypto'),sharp=require('sharp');
// Pure WASM: no native ONNX runtime, external inference provider or telemetry.
const ort=require('onnxruntime-web/wasm');
(async()=>{
 const weights=fs.readFileSync(path.join(workerData.directory,'onnx','vision_model.onnx'));
 if(createHash('sha256').update(weights).digest('hex')!=='b5170b47c0ecc667c9af5b42ed460c341377706d1466d177798c65fe49ea1e6b')throw new Error('Unapproved model');
 ort.env.wasm.numThreads=1;ort.env.wasm.proxy=false;ort.env.wasm.wasmPaths=path.dirname(require.resolve('onnxruntime-web'))+'/';
 const session=await ort.InferenceSession.create(weights,{executionProviders:['wasm'],graphOptimizationLevel:'all',enableProfiling:false});
 const mean=[0.48145466,0.4578275,0.40821073],std=[0.26862954,0.26130258,0.27577711];
 parentPort.on('message',async({bytes})=>{try{
  // Pinned CLIP preprocessing: bicubic shorter edge, centre crop, RGB, NCHW.
  const pixels=await sharp(Buffer.from(bytes)).resize(224,224,{fit:'cover',position:'centre',kernel:'cubic'}).removeAlpha().raw().toBuffer();
  const data=new Float32Array(3*224*224);for(let i=0;i<224*224;i++)for(let c=0;c<3;c++)data[c*224*224+i]=(pixels[i*3+c]/255-mean[c])/std[c];
  const input=new ort.Tensor('float32',data,[1,3,224,224]);
  const output=await session.run({pixel_values:input});const vector=Array.from(output.image_embeds.data);
  input.dispose();for(const tensor of Object.values(output))tensor.dispose();
  if(vector.length!==512)throw new Error();parentPort.postMessage({vector});
 }catch{parentPort.postMessage({error:true});}});
 parentPort.postMessage({ready:true});
})().catch(()=>parentPort.postMessage({error:true}));
