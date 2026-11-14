const express = require("express");
const { protect, adminOnly } = require("../middleware/authMiddleware");
const logos = require("../utils/brandLogos");
const { brandKey } = require("../utils/brandIdentity");

function createBrandRouter({ service = logos, authenticate = protect, authorize = adminOnly } = {}) {
  const router = express.Router();

  const handle = callback => async (req, res) => {
    try {
      const result = await callback(req, res);
      if (!res.headersSent) res.json({ success: true, ...result });
    } catch (error) {
      const status = error.status || 500;
      res.status(status).json({ success: false, message: error.status ? error.message : "Brand artwork is temporarily unavailable." });
    }
  };

  const sendImage = preview => handle(async (req, res) => {
    const image = await service.imageFor(brandKey(req.params.key), req.params.id, preview);
    res.type("image/webp").set("X-Content-Type-Options", "nosniff").send(image);
  });

  router.get("/", handle(async () => ({ brands: await service.publicBrands() })));
  router.get("/:key/logo/:id", sendImage(false));
  router.use("/admin", authenticate, authorize);
  router.get("/admin", handle(async () => ({ brands: await service.adminBrands() })));
  router.get("/admin/:key/preview/:id", sendImage(true));
  router.post("/admin", handle(async req => { await service.registerBrand(req.body.name, req.user); }));
  router.post("/admin/existing", handle(async req => { await service.queueExistingBrands(req.user); }));
  router.post("/admin/discover", handle(async req => { await service.retryDiscovery(req.body.name, req.user); }));
  router.post("/admin/upload", handle(async req => { await service.uploadCandidate(req.body.name, req.user, req.body); }));
  router.post("/admin/:key/:action", handle(async (req, res) => {
    const { key, action } = req.params;
    if (!["approve", "remove", "discard"].includes(action)) return res.sendStatus(404);
    await service.reviewLogo(brandKey(key), action, req.body.revision, req.user);
  }));
  return router;
}

module.exports = createBrandRouter;
