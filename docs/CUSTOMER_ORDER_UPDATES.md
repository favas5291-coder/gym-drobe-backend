# Customer order updates

An administrator can record a public fulfilment partner name when approving or publishing a marketplace listing. Confirm permission to publish the name. Existing products and orders have no inferred public name. Keep legal names, contacts, dispatch addresses, financial data and ownership identifiers private. New marketplace orders snapshot the name and assigned item indices on their package. Old assignments remain immutable. A supplier transfer requires a separate finance and inventory reconciliation workflow.

The order inbox and guest order timeline use existing saved order and shipment milestones. No provider is required. The inbox shows up to 50 recent updates and stores its read watermark per order. A supplier can record dispatch only on its assigned package. An administrator records courier-confirmed out-for-delivery, delivered and delivery date changes through the marketplace order screen. No courier account or webhook is assumed.

## WhatsApp setup

Keep both flags disabled until the GymDrobe owner approves costs, the sender and message template are approved, and delivery works with a test recipient. Payment staging rejects live sending.

On the backend use secure environment settings. Configure:

- `WHATSAPP_ORDER_DELIVERY_ENABLED=true` only after acceptance and explicit approval
- `WHATSAPP_ORDER_DELIVERY_START_AT` as the approved ISO UTC activation timestamp
- `WHATSAPP_GRAPH_VERSION` as the supported Graph API version for the Meta app
- `WHATSAPP_PHONE_NUMBER_ID` as the registered GymDrobe sender ID
- `WHATSAPP_ACCESS_TOKEN` as the server-side WhatsApp messaging token
- `WHATSAPP_APP_SECRET` for signature verification
- `WHATSAPP_WEBHOOK_VERIFY_TOKEN` as a separate random verification secret
- `WHATSAPP_ORDER_TEMPLATE` as the approved English utility template name

The English template requires two positional body variables in this order, order number and order update. Example body wording is “GymDrobe order {{1}}. Here is the latest order update. {{2}} Open GymDrobe to see your order details.” Use a dynamic button at index 0 pointing to `https://www.gymdrobe.com/orders/{{1}}` and label it “View order”. The button supplies the order number only. The existing account or guest checkout session still controls access. Have Meta approve the exact template and samples before use.

Subscribe the Meta app to WhatsApp message status events at `/api/whatsapp/order-status` on the GymDrobe backend. Check signed status callbacks for the configured phone ID with a permitted test recipient. An API acceptance is distinct from a delivery receipt. Verify the webhook and template against the current Meta documentation and check the India utility rate in WhatsApp Manager. [Meta pricing](https://business.whatsapp.com/products/platform-pricing)

Set `VITE_WHATSAPP_ORDER_OPT_IN=true` only when customer delivery is ready. Rebuild the web, Android and iPhone clients to expose checkout consent. The checkbox defaults off. Customers can revoke consent for each order from their order page. Demo orders and events outside the activation window are excluded. A lost response becomes uncertain and awaits a signed callback. The sender retries explicit rate-limit responses at most four times. Delivery records are retained for up to 30 days. Admins can inspect their status from the order manager.

Enable the backend PR before publishing the frontend PR. Keep the marketplace and push flags on their existing release gates. Set `WHATSAPP_ORDER_DELIVERY_ENABLED=false` and remove the frontend opt-in flag to stop the rollout. Check the existing host's uptime and MongoDB scan load before relying on periodic sending. A sleeping instance cannot deliver in real time.
