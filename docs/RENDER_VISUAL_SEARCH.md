# Render deployment: visual search

This is a setup recipe for the existing service, not a deployed Blueprint. Do not create a duplicate production API. First use an isolated staging service/database. No Render service, charge or environment variable was changed by preparing this file.

## Model packaging without a shared disk

Use Node 24. Set `VISUAL_SEARCH_MODEL_DIR=/opt/render/project/src/.visual-model/clip-patch16` for a Node service with this repository at its root. If Render Root Directory is set, adjust the absolute path to the actual checkout. Keep this folder outside any static/public mount.

Set the web service Build Command to `bash deploy/render-visual-search-build.sh`. Keep Start Command `npm start`. The build explicitly downloads and checksum-verifies the pinned model into its build artifact; request handling never downloads it. Rebuilds need access to Hugging Face and approximately 345 MB model download, plus dependencies. No persistent disk is required with this approach. Build failures stop deployment; benchmark disk, memory and startup on staging.

Set the backend-only variables listed in VISUAL_SEARCH.md, with the staging MONGO_URI, exact approved catalogue image hosts, catalogue origin and provisional threshold. Leave VISUAL_SEARCH_ENABLED=false until the first index has published successfully. Do not change payment credentials for this task.

## Scheduled catalogue rebuild

Render cron jobs cannot mount the web service's disk. Configure a separate cron job from the SAME reviewed backend commit, with its OWN build artifact and model:

| Setting | Value |
| --- | --- |
| Build Command | `bash deploy/render-visual-search-build.sh` |
| Command | `npm run visual-search:index` |
| Schedule | `*/15 * * * *` (UTC) |
| Model directory | Same absolute checkout-relative path as above, on the cron job's own filesystem |
| Database | Same isolated staging MONGO_URI as the staging API |
| Other variables | Same approved hosts, origin and threshold; VISUAL_SEARCH_ENABLED=true for indexing |

Creating cron/paid capacity can incur charges and requires account-owner approval. This recipe has not purchased or created them. Use an environment group for shared non-secret configuration if desired; enter secrets only in Render. A separate cron job does not inherit web-service variables automatically.

After deployment, trigger one cron run manually. It must exit successfully and print `ready:true`. Check `GET /api/visual-search/status` on the staging API after enabling its flag. Exercise independent phone images, no-match, changed stock/price and image replacement. The Mongo lease prevents concurrent rebuilds; failed jobs retain the last index, while indexes older than 48 hours disable availability. Monitor failed runs. Run again after catalogue imports.

Only after staging acceptance, apply the same reviewed setup to the existing production service and production database, then release the paired frontend and rebuild native apps. Roll back photo search with VISUAL_SEARCH_ENABLED=false. Do not approve a paid plan solely from the 2 GB starting capacity-test guidance; measure actual CPU/RAM, model warmup and query latency.

## Persistent-disk alternative

An existing paid service disk can hold the model, but is only available at runtime, not build/pre-deploy. Provision it through that service's runtime shell; do not run the build helper against the disk mount. Cron and one-off jobs cannot share that disk, so each indexer still needs its own packaged model. Do not add a disk to the existing service without reviewing deployment downtime/scaling implications.

Official Render references (checked 4 November 2026):
- https://render.com/docs/disks
- https://render.com/docs/cronjobs
- https://render.com/docs/deploys
- https://render.com/docs/one-off-jobs
