# Dependency maintenance — 5 November 2026

This small release starts from production main0a33e105 and does not include the staged Apple/shopping/push/index/visual-search aggregate. Existing server startup, controllers, authentication, payment confirmation and authorization are unchanged.

Update allowed transitive versions of body-parser, follow-redirects and qs to their patched releases. Preserve the existing Express/Razorpay/framework major versions. The dependency audit identified published request-body denial-of-service and redirected-header disclosure advisories; this report does not establish any exploitation or customer incident.

The latest nodemon3.1.14 still requires the affected minimatch10 range. Replace that development-only watcher with Node's built-in `node --watch server.js`; production remains `node server.js`. The project already depends on Mongoose9, whose supported Node floor includes stable watch mode. No additional service or paid tool is introduced.

Run `npm ci --ignore-scripts`, `npm run check` and `npm audit` before release. These checks do not contact Razorpay or authorize transactions. Verify the deployed health endpoint and public catalogue after the existing free Render auto-deploy; do not mutate orders or customer records.

Official advisory references:
- https://github.com/advisories/GHSA-27r3-jxmh-p828
- https://github.com/advisories/GHSA-mrwp-f3q8-3g9p
- https://github.com/advisories/GHSA-6pq8-jhm2-2vcw
- https://github.com/advisories/GHSA-g3hv-75wg-m249
