# Courier remittance comparison

## Repository audit

The marketplace records a COD customer collection with its order, collection reference, amount in paise and collection date. The collection reference is unique and indexed. The collection recorder requires external evidence from an administrator. Ordinary orders and kit parcels have separate controls. Supplier earnings and recorded payouts describe separate liabilities. These sources do not contain courier deposit confirmations or a bank statement feed.

## Statement review

An authenticated administrator can submit the INR lines of an external statement to `POST /api/marketplace/admin/remittances/preview`. Submit 1–200 rows. Use one row per collection reference and include the courier's net remittance and explicit fee, both in integer paise. Enter zero when the statement shows zero fees. References match the stored collection reference exactly after trimming surrounding whitespace.

```json
{
  "currency": "INR",
  "rows": [
    { "reference": "COD-1007", "remittedPaise": 47000, "feePaise": 3000 }
  ]
}
```

Each row compares the sum of net remittance and fee with the amount recorded as collected. A positive difference means the statement gross exceeds the recorded collection. A negative difference means a shortfall. Duplicate statement references are ambiguous and every occurrence is flagged. Unknown references and invalid internal records require investigation. The response preserves input order and includes status counts.

Coverage is limited to submitted references in the marketplace collection register. Unsubmitted collections, bank deposits, other deductions, standalone orders and kit cash records require separate evidence. The preview performs a single indexed read and creates no financial records, adjustments, payout instructions or external requests.
