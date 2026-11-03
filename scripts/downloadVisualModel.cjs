// Explicit setup only; never called by startup or customer searches.
const fs=require('node:fs'),path=require('node:path'),{createHash,randomUUID}=require('node:crypto'),{Readable,Transform}=require('node:stream'),{pipeline}=require('node:stream/promises');
(async()=>{
 const directory=process.argv[2];if(!directory||!path.isAbsolute(directory))throw new Error('Absolute model directory required');
 const target=path.join(directory,'onnx','vision_model.onnx'),temporary=target+'.'+randomUUID()+'.download';fs.mkdirSync(path.dirname(target),{recursive:true});
 const response=await fetch('https://huggingface.co/Xenova/clip-vit-base-patch16/resolve/342fdf2f67aded64d138ff074745fb4a5d2bba5f/onnx/vision_model.onnx',{signal:AbortSignal.timeout(300000)});if(!response.ok||!response.body)throw new Error('Download failed');
 const hash=createHash('sha256');let size=0;
 try{await pipeline(Readable.fromWeb(response.body),new Transform({transform(chunk,encoding,done){size+=chunk.length;if(size>400000000)return done(new Error('Model too large'));hash.update(chunk);done(null,chunk);}}),fs.createWriteStream(temporary,{flags:'wx',mode:0o600}));
 if(hash.digest('hex')!=='b5170b47c0ecc667c9af5b42ed460c341377706d1466d177798c65fe49ea1e6b')throw new Error('Checksum mismatch');fs.renameSync(temporary,target);console.log('Pinned visual-search model downloaded and verified.');
 }catch(e){fs.rmSync(temporary,{force:true});throw e;}
})().catch(()=>{console.error('Model setup failed. Check destination, disk space and access to the official Hugging Face model host.');process.exitCode=1;});
