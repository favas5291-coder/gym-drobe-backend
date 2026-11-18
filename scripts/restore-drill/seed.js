// mongosh script; the container has no host mounts or published ports.
const source = db.getSiblingDB("gd_fixture_backup");
source.orders.createIndex({ reference: 1 }, { unique: true });
source.entitlements.createIndex({ orderId: 1, line: 1 }, { unique: true });
source.orders.insertOne({
  _id: "order-a", reference: "GD-FIXTURE", payment: "cod", currency: "INR",
  lines: [{ supplier: "supplier-a", units: 1, sellingPaise: 55000 },
          { supplier: "supplier-b", units: 2, sellingPaise: 30000 }],
  paidPaise: 0, duePaise: 115000,
});
source.entitlements.insertMany([
  { _id: "a-1", orderId: "order-a", line: 0, supplier: "supplier-a", payablePaise: 50000 },
  { _id: "a-2", orderId: "order-a", line: 1, supplier: "supplier-b", payablePaise: 54000 },
]);
source.inventory.insertOne({ _id: "sku-a", available: 2, reserved: 1 });
