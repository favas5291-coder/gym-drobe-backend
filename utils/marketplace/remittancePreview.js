"use strict";

const { M, D, actorRequired } = require("./service");

function statementRows(input) {
  D.object(input, ["currency", "rows"], "Courier statement");
  if (input.currency !== "INR") D.fail("Only INR statements are supported.");
  if (!Array.isArray(input.rows) || input.rows.length < 1 || input.rows.length > 200) {
    D.fail("Submit between 1 and 200 statement rows.");
  }
  return input.rows.map(row => {
    D.object(row, ["reference", "remittedPaise", "feePaise"], "Statement row");
    return {
      reference: D.text(row.reference, "collection reference", 200, 3),
      remittedPaise: D.integer(row.remittedPaise, "Net remittance in paise"),
      feePaise: D.integer(row.feePaise, "Courier fee in paise"),
    };
  });
}

function compare(rows, collections) {
  const byReference = new Map(collections.map(record => [record.reference, record]));
  const occurrences = new Map();
  for (const { reference } of rows) occurrences.set(reference, (occurrences.get(reference) || 0) + 1);
  const counts = { matched: 0, difference: 0, duplicate: 0, unknown: 0, invalid_record: 0 };
  const lines = rows.map((row, index) => {
    const record = byReference.get(row.reference);
    const line = { rowNumber: index + 1, ...row, statementGrossPaise: row.remittedPaise + row.feePaise };
    if (occurrences.get(row.reference) > 1) line.status = "duplicate";
    else if (!record) line.status = "unknown";
    else if (!Number.isSafeInteger(record.amount) || record.amount < 1 || !record.order) line.status = "invalid_record";
    else {
      line.orderId = String(record.order);
      line.recordedCollectionPaise = record.amount;
      line.differencePaise = line.statementGrossPaise - record.amount;
      line.status = line.differencePaise === 0 ? "matched" : "difference";
    }
    counts[line.status]++;
    return line;
  });
  return { currency: "INR", scope: "submitted_marketplace_collection_references", counts, lines };
}

async function preview(actor, input) {
  actorRequired(actor, true);
  const rows = statementRows(input);
  const references = [...new Set(rows.map(row => row.reference))];
  const records = await M.Collection.find({ reference: { $in: references } }).select("reference amount order -_id").lean();
  return { preview: compare(rows, records) };
}

module.exports = { preview, statementRows, compare };
