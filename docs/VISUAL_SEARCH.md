# GymDrobe visual search

Implemented in the existing Express/MongoDB backend. Customer images stay in memory. No external inference provider, account, API key or per-search provider fee is required. Hosting CPU/RAM, MongoDB, bandwidth and disk still cost money; this change does not purchase hosting.

## Provisioning

Use Node 24. Install with `npm ci --ignore-scripts`. The runtime is `onnxruntime-web/wasm` and Sharp; there is no native ONNX binding or Microsoft telemetry dependency. Inference loads only package-local WASM and local model weights.

1. Download the pinned 345,060,583-byte CLIP model once:

   `npm run visual-search:download -- /absolute/private/models/clip-patch16`

   Official source: `Xenova/clip-vit-base-patch16`, revision `342fdf2f67aded64d138ff074745fb4a5d2bba5f`. SHA-256: `b5170b47c0ecc667c9af5b42ed460c341377706d1466d177798c65fe49ea1e6b`. The downloader and inference worker both verify this checksum. Model weights are not committed. Review the model card/license before public deployment: https://huggingface.co/Xenova/clip-vit-base-patch16 . CLIP cannot verify authenticity or an exact product identity.
2. Set backend-only variables in the chosen environment:

   ```dotenv
   VISUAL_SEARCH_ENABLED=true
   VISUAL_SEARCH_MODEL_DIR=/absolute/private/models/clip-patch16
   VISUAL_SEARCH_CATALOGUE_ORIGIN=https://www.gymdrobe.com
   VISUAL_SEARCH_IMAGE_HOSTS=coitonic.com,cdn.shopify.com,images.puma.com,assets.adidas.com
   VISUAL_SEARCH_THRESHOLD=0.78
   # Existing MONGO_URI selects this environment's database.
   ```

   Host names above are examples; inventory every actual catalogue image host and approve exact names. Relative images resolve against the catalogue origin, whose host must also be allowed. Redirects fail closed; enter canonical image URLs. Never allow arbitrary customer-supplied image URLs. No `VITE_` secret variables are introduced.
3. Against an isolated staging database first, run `npm run visual-search:index`. It indexes every active product image and colour/variant gallery, with a 20,000-image capacity guard. A failed fetch/decode/model run leaves the previous published snapshot intact. Only a completed generation is atomically published. Mongo leases prevent simultaneous indexers.
4. Schedule this command on your hosting platform every 15 minutes, with the same environment/model volume. Also run after importing/replacing catalogue images. This scheduler is an operator setup step; none has been installed on the live host. Changes to image URLs immediately invalidate old rows during search. Price, availability and active status are always read from current catalogue documents. Same-URL image replacements are picked up by the scheduled rebuild. Snapshots older than 48 hours are unavailable.
5. Restart the paired API and inspect `GET /api/visual-search/status`; only then enable/release the paired frontend. False availability disables submission and links to text search. Set `VISUAL_SEARCH_ENABLED=false` to roll back immediately.

## API and ranking

`POST /api/visual-search` accepts a raw JPEG, PNG or WebP body, up to 8 MiB. The server independently decodes format/dimensions (32 px minimum, 12,000 px per side and 24 MP maximum), rejects animated/multipage images, strips EXIF/GPS, rotates, bounds to 1024 px and JPEG-compresses. CLIP preprocessing uses bicubic resize/centre crop, RGB, published mean/std and a 512-value projection. Cosine ranking groups images by product, filters below the threshold and prioritises available qualifying products. No random fallback or exact-match claims exist. Empty results use the requested no-close-matches message.

Ten requests/minute/IP, 10,000 bounded limiter buckets, one inference job/process, a 60-second worker deadline, 15-second catalogue-fetch deadline and an 8 MiB streamed catalogue-image limit bound work. The browser uses a 70-second search deadline and a cancel action. Configure proxy trust for your actual hosting topology; do not trust arbitrary forwarded IPs. Multiple API replicas need an edge/distributed rate limiter before scaling. Catalogue/vector reads are intentionally simple for this small catalogue; replace linear scans with a vector index before exceeding the 20,000-image guard.

## Privacy, memory and costs

No customer query image/vector is written to MongoDB, disk, analytics, object storage or a provider. Do not enable request-body logging or proxy/APM payload capture for this route. Bytes and buffers are released after the request/worker completes (JavaScript GC is not secure erasure). Client object URLs are revoked, requests aborted and state discarded on sheet close. Native capture uses a data URL and `saveToGallery:false`; OS camera/picker implementations may have their own temporary caches. The app does not deliberately save photos or delete originals from the gallery. OS termination asks the customer to select again instead of persisting recovered bytes.

Only public catalogue vectors are retained. Old generations are pruned after 48 hours when a rebuild succeeds. Provision a persistent private model volume and measure memory on staging: 345 MB weights plus WASM memory and catalogue vectors can exceed a small free-tier process. Start capacity testing with at least 2 GB RAM; this is guidance, not a measured production requirement or price quote. No provider retention applies because inference is local. Model download contacts Hugging Face only during explicit setup; indexing fetches approved public product-image hosts. Customer photo requests do neither.

## Release acceptance

Calibrate the provisional 0.78 threshold using independent phone photos, unrelated images, multiple backgrounds and held-out product photos. A cropped-reference test verifies plumbing, not real-camera accuracy. Verify the complete Mongo snapshot/index/search journey on staging, public-host access, failed rebuild preservation, deletion/image edits, and concurrency. No production database has been indexed by this development task.
