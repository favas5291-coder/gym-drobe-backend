const mongoose = require("mongoose");

const schema = new mongoose.Schema({
  _id: String,
  material: { type: String, required: true, select: false },
}, { versionKey: false });

module.exports = mongoose.model("EditorDraftKey", schema);
