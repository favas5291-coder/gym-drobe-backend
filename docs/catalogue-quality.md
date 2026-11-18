# Catalogue quality report

Run this operator command from the backend checkout with dependencies installed. It prints JSON and performs no writes, network requests to photo hosts, messaging, or automatic corrections.

```sh
npm run --silent catalogue:quality -- --fixture
npm run --silent catalogue:quality -- --file /path/to/public-products.json
npm run --silent catalogue:quality -- --mongo --limit 50
npm run --silent catalogue:quality -- --mongo --limit 50 --after 0123456789abcdef01234567
```

Choose exactly one input. The bundled fixture includes a clean product and one product with deliberate defects. A local file may contain a product array or the public API envelope with a `products` array. Supply a complete snapshot of each product, including stock, options, prices and photo fields. The file limit is 4 MiB, 250 products and 2 MiB per product.

Database mode requires an explicit `MONGO_URI` in the process environment, including the intended database name. Use a read-only database account. It selects active products just like the public catalogue, orders them by immutable document ID, and scans one page of at most 100 products or 4 MiB. Continue with `nextCursor` until it is null. A page of a changing catalogue is a point-in-time observation. Reviews, customers, suppliers, internal commercial terms and purchase costs are outside the database projection. Output contains product IDs, input positions, issue codes, stock totals and slot counts for mismatches, and the conflicting public brand values when relevant. A file without private marketplace metadata cannot establish whether an entire price table was lost.

| Issue | Owner review |
| --- | --- |
| INVENTORY_INVALID | Compare declared sizes and colours to checkout's supported stock shapes. Check whole, nonnegative quantities, option names and the one-million-unit product limit. |
| SPARSE_STOCK_MATRIX | A declared size/colour combination lacks an explicit quantity on a legacy product. Confirm the actual offer and record zero for unavailable options when using a full matrix. Legacy sparse stock may be intentional. |
| TOTAL_STOCK_MISMATCH / STOCK_STATUS_MISMATCH | Check product stock and its availability label against the sum of the checkout inventory slots. |
| PRICE_INVALID / DISCOUNT_INVALID | Check the recorded base price in rupees and discount from 0 through 100 percent. |
| ZERO_SELLING_PRICE | Verify whether a zero selling price after GymDrobe's normal rounding and discount is intentional. |
| VARIANT_PRICES_MISSING / VARIANT_PRICES_INVALID | Review the marketplace price table, positive integer selling amounts in paise and MRP at least the selling amount when provided. |
| VARIANT_PRICE_SELECTION / IN_STOCK_VARIANT_WITHOUT_PRICE | Correct any duplicate or undeclared price selection and verify every in-stock option has a price. |
| BASE_VARIANT_PRICE_MISMATCH | Compare the public base price to the lowest valid variant selling amount. |
| PRODUCT_PHOTO_INVALID / COLOUR_GALLERY_INVALID / DEFAULT_PHOTO_MISSING | Review the default photo and gallery, supported URL/path format, and colour assignments. An empty main image can use a valid gallery fallback. |
| BRAND_MISSING / EXPLICIT_BRAND_CONFLICT | Compare the brand field with the explicitly labelled Brand or Brand name specification. Verify conflicting declarations against the supplier's documented product information before editing. |

Each finding is counted once per product and issue code. The scan checks photo-source syntax and recorded metadata. It cannot determine image reachability, what a photo depicts, actual warehouse quantities, ownership of a brand, or an unrecorded correct price. Manufacturer, seller, title keywords and logos do not establish the product's brand. No ad publication, product edit, or stock reservation is triggered.

Exit status 0 means the page has no findings, 1 means it has findings, and 2 means the command could not complete the scan. The fixture intentionally exits 1.
