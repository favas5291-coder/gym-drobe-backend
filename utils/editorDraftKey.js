const { randomBytes } = require("node:crypto");
const EditorDraftKey = require("../models/EditorDraftKey");

async function editorDraftKey(req, res, next) {
  const id = JSON.stringify([String(req.user._id), req.user.role]);
  res.set("Cache-Control", "private, no-store");
  try {
    const record = await EditorDraftKey.findOneAndUpdate(
      { _id: id },
      { $setOnInsert: { material: randomBytes(32).toString("base64") } },
      { upsert: true, new: true },
    ).select("+material").lean();
    return res.json({ success: true, key: record.material });
  } catch (error) {
    return next(error);
  }
}

module.exports = editorDraftKey;
