"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { preview, statementRows, compare } = require("../utils/marketplace/remittancePreview");

const row = (reference, remittedPaise = 47000, feePaise = 3000) => ({ reference, remittedPaise, feePaise });
const input = rows => ({ currency: "INR", rows });

test("remittance preview compares a net deposit and explicit fee to recorded cash in integer paise", () => {
  const rows = statementRows(input([row(" REF-1 "), row("REF-2", 46000), row("REF-3", 47900), row("REF-4", 0, 0)]));
  const records = rows.map(({ reference }) => ({ reference, order: "order", amount: 50000 }));
  const result = compare(rows, records);
  assert.deepEqual(result.lines.map(l => [l.reference, l.differencePaise]), [["REF-1", 0], ["REF-2", -1000], ["REF-3", 900], ["REF-4", -50000]]);
  assert.deepEqual(result.counts, { matched: 1, difference: 3, unknown: 0, duplicate: 0, invalid_record: 0 });
});

test("ambiguous and unavailable source data never produce matched results", () => {
  const rows = statementRows(input([row("abc"), row(" abc "), row("ABC"), row("bad")]));
  const result = compare(rows, [{ reference: "abc", order: "order", amount: 50000 }, { reference: "bad", order: "order", amount: null }]);
  assert.deepEqual(result.lines.map(l => l.status), ["duplicate", "duplicate", "unknown", "invalid_record"]);
  assert.ok(result.lines.every(l => l.differencePaise === undefined));
});

test("rejects wrong currency, invalid amounts, ambiguous fields and oversized statements", () => {
  for (const value of [null, {}, input([]), input(Array(201).fill(row("ref"))), { currency: "USD", rows: [row("ref")] },
    input([{ reference: "ref", remittedPaise: 0 }]), input([row("ref", 2.5)]), input([row("ref", "10")]),
    input([row("ref", 2, -1)]), input([row("ref", Number.MAX_SAFE_INTEGER)]), input([row("  ")]),
    input([{ ...row("ref"), approved: true }])]) assert.throws(() => statementRows(value), { status: 400 });
});

test("preview authorizes before touching statement data or the register", async () => {
  await assert.rejects(preview(null, null), { status: 401 });
  await assert.rejects(preview({ _id: "supplier", role: "supplier" }, null), { status: 403 });
});
