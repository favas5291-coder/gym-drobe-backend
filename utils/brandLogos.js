const { randomUUID } = require("node:crypto");
const Brand = require("../models/Brand");
const Product = require("../models/Product");
const { Media, Quota } = require("../models/Marketplace");
const { brandKey, brandName } = require("./brandIdentity");
const { officialLogoSource, fetchOfficialLogo, knownLogoKeys } = require("./brandLogoSources");
const storage = require("./marketplace/media");
const { fail } = require("./marketplace/domain");

function validatedBrandName(value) {
  const name = brandName(value);
  if (!name || name.length > 100 || /[\p{Cc}]/u.test(name)) fail("Enter a brand name of up to 100 characters.");
  return name;
}

async function registerBrand(value, actor, model = Brand) {
  const name = validatedBrandName(value);
  const key = brandKey(name);
  const canDiscover = actor?.role === "admin";
  const status = canDiscover && officialLogoSource(key) ? "queued" : "unavailable";
  try {
    return await model.findOneAndUpdate({ _id: key }, {
      $setOnInsert: { name, status, requestedBy: canDiscover ? actor._id : undefined },
    }, { upsert: true, returnDocument: "after", timestamps: false });
  } catch (error) {
    if (error.code === 11000) return model.findById(key);
    throw error;
  }
}

function registerSavedBrand(value, actor) {
  if (brandName(value)) registerBrand(value, actor).catch(() => {
    console.warn("Brand logo registration could not finish. Retry in Products and stock.");
  });
}

async function retryDiscovery(value, actor) {
  const record = await registerBrand(value, actor);
  await Brand.updateOne({
    _id: record._id, approved: null, candidate: null,
    status: { $nin: ["queued", "searching"] },
  }, {
    $set: { status: officialLogoSource(record._id) ? "queued" : "unavailable", requestedBy: actor._id },
    $inc: { revision: 1 },
  });
}

async function queueExistingBrands(actor) {
  const names = await Product.distinct("brand", { isActive: { $ne: false } });
  const unique = new Map(names.map(name => [brandKey(name), name]));
  for (const key of knownLogoKeys) {
    if (unique.has(key)) await registerBrand(unique.get(key), actor);
  }
}

async function storeArtwork(actor, input) {
  // Uses the existing image quota and validated, re-encoded marketplace media.
  await Quota.updateOne({ _id: "global" }, { $setOnInsert: { bytes: 0 } }, { upsert: true })
    .catch(error => { if (error.code !== 11000) throw error; });
  const { media } = await storage.upload(actor, { kind: "brand-logo", mime: input.mime, base64: input.base64 }, { brandArtwork: true });
  return media;
}

function sourceUrl(value) {
  if (!value) return "";
  try {
    if (typeof value === "string" && value.length <= 2048) {
      const url = new URL(value);
      if (url.protocol === "https:" && !url.username && !url.password) return url.href;
    }
  } catch { /* Invalid source URL is reported below. */ }
  fail("Enter a valid HTTPS artwork source.");
}

async function uploadCandidate(value, actor, input) {
  const record = await registerBrand(value, actor);
  const source = sourceUrl(input.source);
  const filter = { _id: record._id, revision: input.revision };
  const previous = Number.isSafeInteger(input.revision) && await Brand.findOne(filter).lean();
  if (!previous) {
    fail("This brand changed. Reload before uploading.", 409);
  }
  const media = await storeArtwork(actor, input);
  const result = await Brand.updateOne(filter, {
    $set: { candidate: { media: media.id, source }, status: "review" },
    $unset: { claim: 1, leaseUntil: 1 },
    $inc: { revision: 1 },
  });
  if (!result.matchedCount) {
    await releaseArtwork(actor, media.id);
    fail("This brand changed. Reload before uploading.", 409);
  }
  await releaseArtwork(actor, previous.candidate?.media);
}

async function releaseArtwork(actor, media) {
  if (!media) return;
  try { await storage.remove(actor, String(media), { brandArtwork: true }); } catch (error) {
    if (![404, 409].includes(error.status)) console.warn("Unused brand artwork could not be cleared.");
  }
}

async function reviewLogo(key, action, revision, actor) {
  if (!Number.isSafeInteger(revision)) fail("Reload the brand before reviewing.");
  const filter = { _id: key, revision };
  const record = await Brand.findOne(filter).lean();
  if (!record) fail("This brand changed. Reload before reviewing.", 409);
  if (action === "approve" && !record.candidate) fail("Choose artwork to approve.");
  const update = {
    $set: { status: "idle", candidate: null },
    $unset: { claim: 1, leaseUntil: 1 },
    $inc: { revision: 1 },
  };
  if (action === "approve") update.$set.approved = record.candidate;
  if (action === "remove") update.$set.approved = null;
  if (action === "remove" && record.candidate) {
    update.$set.candidate = record.candidate;
    update.$set.status = "review";
  }
  const result = await Brand.updateOne(filter, update);
  if (!result.matchedCount) fail("This brand changed. Reload before reviewing.", 409);
  const oldArtwork = action === "discard" ? record.candidate : record.approved;
  await releaseArtwork(actor, oldArtwork?.media);
}

async function processLogoJob({ model = Brand, fetchLogo = fetchOfficialLogo, saveArtwork = storeArtwork } = {}) {
  const claim = randomUUID();
  const now = new Date();
  const record = await model.findOneAndUpdate({
    $or: [{ status: "queued" }, { status: "searching", leaseUntil: { $lt: now } }],
    approved: null, candidate: null,
  }, { $set: { status: "searching", claim, leaseUntil: new Date(+now + 60000) } }, { returnDocument: "after" });
  if (!record) return;
  let candidate = null;
  const source = officialLogoSource(record._id);
  if (source) {
    try {
      const image = await fetchLogo(source.url);
      const uploaded = await saveArtwork({ _id: record.requestedBy, role: "admin" }, image);
      candidate = { media: uploaded.id, source: source.page };
    } catch { /* Admin can retry or provide artwork. */ }
  }
  const result = await model.updateOne({ _id: record._id, claim }, {
    $set: { candidate, status: candidate ? "review" : "unavailable" },
    $unset: { claim: 1, leaseUntil: 1 },
    $inc: { revision: 1 },
  });
  if (!result.matchedCount && candidate) {
    await releaseArtwork({ _id: record.requestedBy, role: "admin" }, candidate.media);
  }
}

function startBrandLogoWorker() {
  let busy = false;
  const timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      await processLogoJob();
    } catch {
      console.warn("Brand logo queue temporarily unavailable.");
    } finally {
      busy = false;
    }
  }, 4000);
  timer.unref();
  return () => clearInterval(timer);
}

async function adminBrands() {
  const [records, names] = await Promise.all([
    Brand.find().sort({ name: 1 }).select("name status revision candidate approved").lean(),
    Product.distinct("brand", { isActive: { $ne: false } }),
  ]);
  const rows = new Map();
  for (const value of names) {
    const name = brandName(value);
    if (name) rows.set(brandKey(name), { key: brandKey(name), name, status: "idle", revision: 0 });
  }
  for (const { _id: key, name, status, revision, candidate, approved } of records) {
    rows.set(key, { key, name, status, revision, candidate, approved });
  }
  return [...rows.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function publicLogoPath(brand) {
  return `/brands/${encodeURIComponent(brand._id)}/logo/${brand.approved.media}`;
}

async function publicBrands() {
  const rows = await Brand.find({ approved: { $ne: null } }).select("name approved").lean();
  return rows.map(row => ({ key: row._id, name: row.name, logoPath: publicLogoPath(row) }));
}

async function imageFor(key, id, preview) {
  if (!/^[a-f\d]{24}$/i.test(id)) fail("Logo not found.", 404);
  const field = preview ? "candidate" : "approved";
  const brand = await Brand.exists({ _id: key, [`${field}.media`]: id });
  if (!brand) fail("Logo not found.", 404);
  const image = await Media.findOne({ _id: id, kind: "brand-logo" }).select("+content");
  if (!image) fail("Logo not found.", 404);
  return image.content;
}

module.exports = {
  registerBrand, registerSavedBrand, retryDiscovery, queueExistingBrands, uploadCandidate, reviewLogo,
  processLogoJob, startBrandLogoWorker, adminBrands, publicBrands, imageFor,
};
