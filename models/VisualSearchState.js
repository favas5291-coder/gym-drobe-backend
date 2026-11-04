const mongoose=require('mongoose');
module.exports=mongoose.model('VisualSearchState',new mongoose.Schema({_id:String,generation:String,model:String,indexedAt:Date,count:Number,leaseUntil:Date,owner:String}));
