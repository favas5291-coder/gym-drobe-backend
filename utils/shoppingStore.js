"use strict";
const crypto = require("node:crypto");
const mongoose = require("mongoose");
const User = require("../models/User");
const State = require("../models/ShoppingState");
const Operation = require("../models/ShoppingOperation");

const receiptId = (user, id) => crypto.createHash("sha256").update(user + "\0" + id).digest("hex");

module.exports = {
  read(user) { return State.findById(user).read("primary").maxTimeMS(3000).lean(); },
  async transaction(user, work) {
    const session = await mongoose.startSession();
    try {
      let result;
      await session.withTransaction(async () => {
        result = await work({
          async touchAccount() {
            // A write to the same account serializes against permanent deletion.
            const saved = await User.updateOne({ _id: user, isActive: { $ne: false } },
              { $inc: { shoppingSyncVersion: 1 } }, { session });
            return saved.matchedCount === 1;
          },
          read: () => State.findById(user).session(session).lean(),
          receipt: id => Operation.findById(receiptId(user, id)).session(session).lean(),
          save: next => State.updateOne({ _id: user }, { $set: next }, { session, upsert: true, runValidators: true }),
          record: (id, receipt) => Operation.create([{ _id: receiptId(user, id), user, ...receipt }], { session }),
        });
      }, { maxCommitTimeMS: 10000 });
      return result;
    } finally { await session.endSession(); }
  },
};
