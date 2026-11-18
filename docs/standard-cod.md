# Standard cash on delivery

## Audit of the starting branch

Account and guest checkout use an owner-scoped checkout token. Before this change the pricing code and payment-creation endpoint accepted only Razorpay prepaid and 10% advance COD. The Order schema already supported a legacy cash payment method. Stock for gateway orders was deducted on verified capture. Marketplace order creation initializes supplier entitlements and fulfilment groups in an order save hook. Kit courier profiles certify advance COD only. Ordinary product delivery records do not confirm courier COD coverage.

## Activation and rollback

Leave STANDARD_COD_ENABLED unset for the default disabled state. In an isolated environment, set STANDARD_COD_ENABLED=true and STANDARD_COD_PINCODES to a comma-separated list of six-digit pincodes approved for ordinary COD by operations. Include only destinations where all enabled ordinary catalogue suppliers and products can fulfil COD at the configured checkout rates. Exclude restricted products or suppliers from the rollout until per-product carrier rules are configured. During this pilot new kits require prepayment. Existing advance-COD kit orders retain their recorded terms.

POST /api/payments/checkout/quote with paymentMethod cod returns zero payable upfront and the full total due. POST /api/payments/cod/order uses existing account or guest authentication, checkoutToken, items, shippingAddress and expectedTotal. Reuse the same request and token after a timeout. Confirmation records pending payment and committed inventory in one MongoDB transaction, and returns the customer-safe order. No gateway is contacted. A MongoDB replica set with transactions and the existing order indexes is required.

Pair this backend with the storefront standard-COD flag. Release the compatible disabled backend and storefront first, then activate the server pilot and storefront switch. When rolling back, switch the storefront to its previous mode and disable new server COD confirmations. Existing COD orders remain retrievable and collectible and original advance-COD payments remain recoverable. Changing the gateway checkout mode on existing orders requires a separate checkout. No historical payment balances are migrated. Do not enter a cash collection until the cash was received and reconciled. The marketplace records one exact whole-order external receipt after all active supplier parcels have dispatched. Multi-parcel pilot operations must agree how the full order amount will be collected and reconciled. Courier remittance is separate.
