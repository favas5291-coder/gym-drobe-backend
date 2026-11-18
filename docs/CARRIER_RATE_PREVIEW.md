# Courier rate preview

Baseline audit at e07fb781: checkoutShipping.js uses the store's shipping settings; kitShipping.js validates packages against purchased profiles. courierTracking.js validates tracking URLs. None establishes a live booking contract. Supplier agreements determine who books a parcel. This change adds an operator-only, read-only comparison with Shiprocket. It leaves customer pricing, pickup and sales untouched.

Run the command in an approved carrier account environment with a short-lived bearer token injected as SHIPROCKET_QUOTE_TOKEN and SHIPROCKET_QUOTE_ENABLED=true. Never put a token on the command line. Supply one parcel as JSON through stdin:

    echo '{"pickupPincode":"673001","deliveryPincode":"560001","weightGrams":500,"lengthMm":200,"widthMm":140,"heightMm":100,"payment":"cod","declaredValuePaise":55000}' | node scripts/previewCourierRates.cjs

The command returns eligible carrier IDs, names, the provider's quoted INR rate in paise and provider-estimated days when available. A rate is advisory. Check the provider contract for GST, COD charges, volumetric rules, surcharges and pickup availability before using it for customer pricing. An empty response means no qualifying service. An error means availability is unknown. Operators can retry a read after a timeout. The command has no booking method, persistent token storage or customer identifiers.

Shiprocket documents pincode-to-pincode serviceability, carrier IDs, estimates and rates. Its published pricing includes per-shipment costs even on its free subscription tier. Delhivery documents a staging client portal for pincode checks and forward/reverse flows. Compare actual contracted rates, COD remittance timing, reliability, pickup coverage and return charges for representative parcels from each supplier before selecting a carrier. None of those account-specific values has been verified here.

Sources: https://apidocs.shiprocket.in/ · https://www.shiprocket.in/pricing/ · https://help.delhivery.com/home/docs/client-developer-portal-1

Before booking automation: approved carrier account, service areas and commercial terms, verified pickup and return locations, approved shipment payloads, an authenticated tracking contract and duplicate-booking recovery by merchant shipment reference. Verify all against the provider's authorized test environment. Keep this CLI out of storefront request handling. Disable by clearing SHIPROCKET_QUOTE_ENABLED. No migration or new runtime dependency.
