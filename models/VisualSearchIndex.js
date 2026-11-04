const mongoose=require('mongoose');
const schema=new mongoose.Schema({generation:{type:String,required:true,index:true},model:{type:String,required:true},productId:{type:mongoose.Schema.Types.ObjectId,required:true},fingerprint:{type:String,required:true},vector:{type:[Number],required:true},indexedAt:{type:Date,required:true}});
module.exports=mongoose.model('VisualSearchImage',schema);
