# iOS account integrations — development branch

These additions are disabled until configured. No production migration, customer deletion or real Apple authorization was performed during development.

## Apple sign-in

Register the existing bundle ID `com.gymdrobe.app` with Sign in with Apple in the owner's Apple Developer account. Backend environment values (never `VITE_` values):

```
APPLE_SIGN_IN_ENABLED=true
APPLE_CLIENT_ID=com.gymdrobe.app
APPLE_TEAM_ID=<actual team ID>
APPLE_KEY_ID=<actual Sign in with Apple key ID>
APPLE_PRIVATE_KEY=<actual .p8 key; newline escapes accepted>
APPLE_TOKEN_ENCRYPTION_KEY=<64 hex characters generated from 32 random bytes>
```

Store the encryption key durably in the hosting secret manager. Losing it prevents revoking saved authorizations. Rotation needs a migration; do not replace it casually. Use a dedicated key, separate from JWT_SECRET.

`GET /api/auth/apple/challenge` returns a short-lived signed challenge and nonce. The native Apple authorization receives that nonce. `POST /api/auth/apple` exchanges the single-use authorization code with Apple, checks the signed identity's issuer/audience/expiry/nonce/email verification, and issues the existing GymDrobe session. Apple refresh tokens are encrypted with AES-256-GCM, excluded from user serialization, and used for account deletion revocation. No Apple access token is sent to the frontend.

Existing Google accounts are not silently linked by email. An Apple email collision asks the customer to use their existing method. Explicit authenticated provider linking remains future work; private-relay email can represent a distinct account. Test this behavior before release.

The current backend JWT lifetime/version and Google audience remain unchanged. User's existing Google `sub` remains the identity on that method. Unique partial indexes support both provider IDs; normal required User index initialization creates the new Apple index. Test startup against a staging MongoDB before enabling.

## Permanent account deletion

`GET /api/auth/account-deletion` provides availability and the configured retention notice. `DELETE` requires a customer session issued within ten minutes and body `{"confirmation":"DELETE"}`. Staff accounts require administrator assistance. Apple authorization is revoked first; MongoDB then deletes the user profile, saved addresses, reviews and support conversations in one transaction. Every old session fails because its User record no longer exists.

The frontend removes the deleted customer's saved device shopping data, local order/support caches and session. Other devices cannot be remotely wiped; their stale device data needs cleanup when a removed account is detected. Cross-device cleanup is a release follow-up.

Orders, shipment/return histories, payment attempts, webhook/provider records and external supplier/payment records are not deleted by this endpoint. It does not cancel/refund purchases or change inventory. Their retention grounds, duration, eventual erasure/anonymization and access/support process must be agreed by the business before activation. Do not claim all personal information is deleted.

```
ACCOUNT_DELETION_ENABLED=true
ACCOUNT_ORDER_RETENTION_NOTICE=<approved, accurate customer-facing explanation of retained records, reasons and duration; minimum 40 characters>
```

No notice or retention period is invented in code. These settings are deployment gates, not proof of legal compliance. Atlas transactions are required; test rollback and Apple revoke outage against a staging replica set. Complete concurrent mutation/deletion and deletion/re-registration tests before release. Add a process to expire legally retained records and handle provider-side erasure; configuration alone does not supply one.

## Verification

`npm run check` runs the existing backend suite and new Apple/deletion tests. They cover token signature/issuer/audience/nonce/freshness/email verification, encrypted-token tamper rejection/private serialization, email collision/replayed code behavior, configuration gates, reauthentication/role/confirmation checks, transaction scoping and failure responses. They use generated signing keys and mocked providers/database, not real customer credentials or transactions.

Apple's primary references:
- https://developer.apple.com/documentation/signinwithapple/verifying-a-user
- https://developer.apple.com/documentation/signinwithapplerestapi/generate-and-validate-tokens
- https://developer.apple.com/documentation/signinwithapplerestapi/revoke-tokens
- https://developer.apple.com/help/app-review/guideline-reference/5-1-1-account-deletion/
