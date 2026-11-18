# Check an automation pilot database

Use this read-only check when assembling the standard COD, allocation worker and daily owner report for a staging pilot. It inspects MongoDB topology and index metadata for those three features, without reading orders or modifying collections. It reports missing index specifications, including whether they must be unique. Index names can differ.

Use an approved, isolated staging database and a restricted account with permission to list indexes. Configure GYMDROBE_ENV, GYMDROBE_STAGING_DATABASE and MONGO_URI privately. The declared database must start with gymdrobe_staging_ and match the selected URI database. A database name alone cannot establish isolation. Run the following after installing the candidate dependencies.

    node scripts/checkAutomationStaging.cjs

A successful result is metadata-passed. It confirms the observed transaction-capable topology and the nine expected backend index definitions. Staging acceptance also requires a successful real transaction, concurrent last-unit checkout, feature-flag checks, approved service areas, provider test credentials, dashboard roles, a two-supplier test order, customer notifications, return and remittance checks. Record those separately. Missing indexes need an operator-reviewed schema change. No credentials or hostnames appear in the report. Each run makes one hello command plus one listIndexes query per collection, and opens no external provider connections.
