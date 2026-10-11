const mongoose = require("mongoose");
const Supplier = require("../../models/Supplier");
const Product = require("../../models/Product");

const PRIVATE_FIELDS = "+contact +verification +fulfillment +notes";
const STATUSES = ["draft", "active", "blocked", "archived"];
const VERIFICATION_STATUSES = ["pending", "verified", "rejected"];
const CONTACT_KEYS = ["name", "phone", "whatsapp", "email"];

const own = (value, key) =>
  Object.prototype.hasOwnProperty.call(value || {}, key);

function problem(status, message, code) {
  return Object.assign(new Error(message), { status, code });
}

function ensureAdmin(req, res) {
  res.set("Cache-Control", "no-store");

  if (!req.user) {
    res.status(401).json({
      success: false,
      message: "Admin login is required.",
    });
    return false;
  }

  if (req.user.role !== "admin" || req.user.isActive === false) {
    res.status(403).json({
      success: false,
      message: "Active admin access is required.",
    });
    return false;
  }

  return true;
}

function text(value, label, maximum) {
  if (value != null && typeof value !== "string") {
    throw problem(400, `${label} must contain text.`);
  }

  const result = String(value ?? "").trim();

  if (result.length > maximum) {
    throw problem(400, `${label} cannot exceed ${maximum} characters.`);
  }

  return result;
}

function keys(value, allowed, label) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.prototype.toString.call(value) !== "[object Object]"
  ) {
    throw problem(400, `${label} must be an object.`);
  }

  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    throw problem(400, `${label} contains an unsupported field.`);
  }
}

function choice(value, choices, label) {
  const result = text(value, label, 40);

  if (!choices.includes(result)) {
    throw problem(400, `Choose a valid ${label.toLowerCase()}.`);
  }

  return result;
}

function identifier(value, label = "Supplier ID") {
  if (
    typeof value !== "string" ||
    !/^[a-f0-9]{24}$/i.test(value)
  ) {
    throw problem(400, `${label} is invalid.`);
  }

  return value;
}

function integer(value, label, minimum, maximum) {
  if (
    !["number", "string"].includes(typeof value) ||
    !String(value).trim()
  ) {
    throw problem(
      400,
      `${label} must be a whole number from ${minimum} to ${maximum}.`
    );
  }

  const result = Number(value);

  if (
    !Number.isSafeInteger(result) ||
    result < minimum ||
    result > maximum
  ) {
    throw problem(
      400,
      `${label} must be a whole number from ${minimum} to ${maximum}.`
    );
  }

  return result;
}

function revision(body) {
  if (
    typeof body.revision !== "number" ||
    !Number.isSafeInteger(body.revision) ||
    body.revision < 0
  ) {
    throw problem(
      400,
      "Load the supplier record and include its revision before saving.",
      "SUPPLIER_REVISION_REQUIRED"
    );
  }

  return body.revision;
}

function contactPatch(value) {
  keys(value, CONTACT_KEYS, "Supplier contact");

  const result = {};

  if (own(value, "name")) {
    result.name = text(value.name, "Contact name", 100);
  }

  for (const field of ["phone", "whatsapp"]) {
    if (!own(value, field)) continue;

    const phone = text(
      value[field],
      field === "phone" ? "Phone number" : "WhatsApp number",
      40
    ).replace(/[\s()+-]/g, "");

    if (phone && !/^\d{7,15}$/.test(phone)) {
      throw problem(
        400,
        "Phone and WhatsApp numbers need 7–15 digits, including the country code when needed."
      );
    }

    result[field] = phone;
  }

  if (own(value, "email")) {
    result.email = text(
      value.email,
      "Contact email",
      150
    ).toLowerCase();

    if (
      result.email &&
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result.email)
    ) {
      throw problem(
        400,
        "Enter a valid supplier contact email address."
      );
    }
  }

  return result;
}

function fulfillmentPatch(value) {
  keys(
    value,
    [
      "dispatchToCustomer",
      "sendToPackingLocation",
      "preparationDaysMin",
      "preparationDaysMax",
    ],
    "Fulfillment settings"
  );

  const result = {};

  for (const field of [
    "dispatchToCustomer",
    "sendToPackingLocation",
  ]) {
    if (!own(value, field)) continue;

    if (typeof value[field] !== "boolean") {
      throw problem(
        400,
        "Fulfillment choices must be true or false."
      );
    }

    result[field] = value[field];
  }

  for (const field of [
    "preparationDaysMin",
    "preparationDaysMax",
  ]) {
    if (!own(value, field)) continue;

    result[field] =
      value[field] == null || value[field] === ""
        ? null
        : integer(value[field], "Preparation days", 0, 365);
  }

  return result;
}

function payload(body, updating = false) {
  keys(
    body,
    [
      "name",
      "contact",
      "fulfillment",
      "notes",
      ...(updating ? ["revision"] : []),
    ],
    "Supplier information"
  );

  const result = {};

  if (own(body, "name")) {
    result.name = text(
      body.name,
      "Supplier business name",
      200
    );

    if (result.name.length < 2) {
      throw problem(
        400,
        "Supplier business name must contain at least 2 characters."
      );
    }
  }

  if (own(body, "contact")) {
    result.contact = contactPatch(body.contact);
  }

  if (own(body, "fulfillment")) {
    result.fulfillment = fulfillmentPatch(body.fulfillment);
  }

  if (own(body, "notes")) {
    result.notes = text(body.notes, "Internal notes", 2000);
  }

  if (!updating && !result.name) {
    throw problem(400, "Enter the supplier business name.");
  }

  if (
    updating &&
    !Object.entries(result).some(
      ([key, value]) =>
        !["contact", "fulfillment"].includes(key) ||
        Object.keys(value).length
    )
  ) {
    throw problem(400, "No supplier changes were provided.");
  }

  return result;
}

function setupIssues(supplier) {
  const issues = [];
  const verification = supplier.verification || {};
  const contact = supplier.contact || {};
  const fulfillment = supplier.fulfillment || {};

  if (
    verification.status !== "verified" ||
    !verification.verifiedAt ||
    !verification.verifiedBy
  ) {
    issues.push(
      "Record supplier verification before activation."
    );
  }

  if (!(contact.phone || contact.whatsapp || contact.email)) {
    issues.push("Add a supplier contact method.");
  }

  if (
    !(
      fulfillment.dispatchToCustomer ||
      fulfillment.sendToPackingLocation
    )
  ) {
    issues.push(
      "Record at least one real fulfillment arrangement."
    );
  }

  const low = fulfillment.preparationDaysMin;
  const high = fulfillment.preparationDaysMax;

  if (
    !Number.isSafeInteger(low) ||
    !Number.isSafeInteger(high) ||
    low < 0 ||
    high < low ||
    high > 365
  ) {
    issues.push(
      "Record valid minimum and maximum preparation times."
    );
  }

  return issues;
}

function serialize(supplier) {
  const data = supplier.toObject({
    transform: false,
    depopulate: true,
  });

  const issues = setupIssues(supplier);

  const statusReasons = {
    draft: "This supplier is a draft. Complete setup and activate it.",
    blocked: "This supplier is blocked.",
    archived: "This supplier is archived.",
  };

  data.id = String(data._id);
  data.revision = Number.isSafeInteger(data.__v)
    ? data.__v
    : 0;

  delete data.__v;

  if (data.verification?.verifiedBy) {
    data.verification.verifiedBy = String(
      data.verification.verifiedBy
    );
  }

  data.setupIssues = issues;
  data.available =
    data.status === "active" && issues.length === 0;

  data.unavailableReason = data.available
    ? ""
    : statusReasons[data.status] ||
      issues[0] ||
      "Supplier setup needs review.";

  return data;
}

function sendError(res, error, fallback) {
  if (
    ["VersionError", "DocumentNotFoundError"].includes(
      error.name
    )
  ) {
    error = problem(
      409,
      "This supplier changed. Reload it before saving again.",
      "SUPPLIER_CHANGED"
    );
  }

  if (error.code === 11000) {
    error = problem(
      409,
      "This supplier code is already used. Reload and try again.",
      "SUPPLIER_CODE_CONFLICT"
    );
  }

  if (error.name === "ValidationError") {
    return res.status(400).json({
      success: false,
      code: "SUPPLIER_INVALID",
      message:
        Object.values(error.errors || {})[0]?.message ||
        "Check the supplier details.",
      fields: Object.keys(error.errors || {}),
    });
  }

  if (error.name === "CastError") {
    error = problem(
      400,
      "A supplier value is invalid.",
      "SUPPLIER_INVALID"
    );
  }

  if ([20, 303].includes(error.code)) {
    error = problem(
      503,
      "Supplier changes require MongoDB transactions. Use Atlas or a local replica set.",
      "TRANSACTIONS_REQUIRED"
    );
  }

  const status =
    Number.isInteger(error.status) &&
    error.status >= 400 &&
    error.status <= 599
      ? error.status
      : 503;

  if (status >= 500) {
    console.error(
      "Supplier request failed:",
      error.name || "Error"
    );
  }

  return res.status(status).json({
    success: false,
    ...(typeof error.code === "string"
      ? { code: error.code }
      : {}),
    message: error.status ? error.message : fallback,
  });
}

function withdrawalFilter(supplier) {
  const filter = {
    supplier: supplier._id,
    isActive: true,
  };

  if (supplier.status !== "active") return filter;

  const setup = supplier.fulfillment;
  const alternatives = [];

  if (!setup.dispatchToCustomer) {
    alternatives.push({
      "fulfillment.dispatchBy": "supplier",
    });
  }

  if (!setup.sendToPackingLocation) {
    alternatives.push(
      {
        "fulfillment.canSendToPackingLocation": true,
      },
      {
        "fulfillment.stockSource": "supplier",
        "fulfillment.dispatchBy": {
          $in: ["gymdrobe", "fulfillment-partner"],
        },
      }
    );
  }

  return alternatives.length
    ? { ...filter, $or: alternatives }
    : null;
}

async function mutate(req, change) {
  const id = identifier(req.params.id);
  const expected = revision(req.body);
  const session = await mongoose.startSession();

  let result;

  try {
    await session.withTransaction(async () => {
      const supplier = await Supplier.findById(id)
        .select(PRIVATE_FIELDS)
        .session(session);

      if (!supplier) {
        throw problem(
          404,
          "Supplier not found.",
          "SUPPLIER_NOT_FOUND"
        );
      }

      if ((supplier.__v ?? 0) !== expected) {
        throw problem(
          409,
          "This supplier changed. Reload it before saving again.",
          "SUPPLIER_CHANGED"
        );
      }

      const details = change(supplier) || {};

      // Every mutation checks the optimistic concurrency version.
      supplier.markModified("status");

      await supplier.save({ session });

      const filter = withdrawalFilter(supplier);

      const withdrawn = filter
        ? await Product.updateMany(
            filter,
            {
              $set: {
                isActive: false,
                "fulfillment.supplierStockConfirmedAt": null,
              },
              $inc: {
                __v: 1,
              },
            },
            { session }
          )
        : null;

      result = {
        supplier: serialize(supplier),
        withdrawnProducts: withdrawn?.modifiedCount || 0,
        ...details,
      };
    });

    return result;
  } finally {
    await session.endSession();
  }
}

async function getSuppliers(req, res) {
  if (!ensureAdmin(req, res)) return;

  try {
    const search = text(req.query.search, "Search", 150);
    const status = text(
      req.query.status,
      "Supplier status",
      40
    );

    const page = integer(
      req.query.page ?? 1,
      "Page",
      1,
      1000000
    );

    const limit = integer(
      req.query.limit ?? 25,
      "Page size",
      1,
      100
    );

    const filter = {};

    if (status && status !== "all") {
      filter.status = choice(
        status,
        STATUSES,
        "Supplier status"
      );
    }

    if (search) {
      const escaped = search.replace(
        /[.*+?^${}()|[\]\\]/g,
        "\\$&"
      );

      const regex = new RegExp(escaped, "i");

      filter.$or = [
        "name",
        "supplierCode",
        "contact.name",
        "contact.email",
        "contact.phone",
        "contact.whatsapp",
      ].map((field) => ({
        [field]: regex,
      }));
    }

    const [suppliers, total] = await Promise.all([
      Supplier.find(filter)
        .select(PRIVATE_FIELDS)
        .sort({ name: 1, _id: 1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .maxTimeMS(10000),

      Supplier.countDocuments(filter).maxTimeMS(10000),
    ]);

    return res.json({
      success: true,
      count: suppliers.length,
      total,
      page,
      pages: Math.max(1, Math.ceil(total / limit)),
      limit,
      suppliers: suppliers.map(serialize),
    });
  } catch (error) {
    return sendError(
      res,
      error,
      "Unable to load suppliers. Please retry."
    );
  }
}

async function getSupplierById(req, res) {
  if (!ensureAdmin(req, res)) return;

  try {
    const supplier = await Supplier.findById(
      identifier(req.params.id)
    )
      .select(PRIVATE_FIELDS)
      .maxTimeMS(10000);

    if (!supplier) {
      throw problem(
        404,
        "Supplier not found.",
        "SUPPLIER_NOT_FOUND"
      );
    }

    const [productCount, activeProductCount] =
      await Promise.all([
        Product.countDocuments({
          supplier: supplier._id,
        }).maxTimeMS(10000),

        Product.countDocuments({
          supplier: supplier._id,
          isActive: true,
        }).maxTimeMS(10000),
      ]);

    return res.json({
      success: true,
      supplier: serialize(supplier),
      productCount,
      activeProductCount,
    });
  } catch (error) {
    return sendError(
      res,
      error,
      "Unable to load this supplier. Please retry."
    );
  }
}

async function createSupplier(req, res) {
  if (!ensureAdmin(req, res)) return;

  try {
    const supplier = new Supplier({
      ...payload(req.body),
      status: "draft",
    });

    await supplier.save();

    return res.status(201).json({
      success: true,
      message:
        "Supplier saved as a draft. Verify it before activation.",
      supplier: serialize(supplier),
    });
  } catch (error) {
    return sendError(
      res,
      error,
      "Unable to create this supplier. Please retry."
    );
  }
}

async function updateSupplier(req, res) {
  if (!ensureAdmin(req, res)) return;

  try {
    const patch = payload(req.body, true);

    const result = await mutate(req, (supplier) => {
      const oldIdentity = JSON.stringify([
        supplier.name,
        ...CONTACT_KEYS.map(
          (key) => supplier.contact?.[key] || ""
        ),
      ]);

      for (const field of ["name", "notes"]) {
        if (own(patch, field)) {
          supplier.set(field, patch[field]);
        }
      }

      for (const field of ["contact", "fulfillment"]) {
        if (!own(patch, field)) continue;

        const current =
          supplier[field]?.toObject({
            transform: false,
          }) || {};

        supplier.set(field, {
          ...current,
          ...patch[field],
        });
      }

      const identityChanged =
        oldIdentity !==
        JSON.stringify([
          supplier.name,
          ...CONTACT_KEYS.map(
            (key) => supplier.contact?.[key] || ""
          ),
        ]);

      const needsReverification =
        identityChanged &&
        supplier.verification.status === "verified";

      if (identityChanged) {
        supplier.verification.status = "pending";
        supplier.verification.verifiedBy = null;
        supplier.verification.verifiedAt = null;

        if (supplier.status === "active") {
          supplier.status = "draft";
        }
      }

      return { needsReverification };
    });

    return res.json({
      success: true,
      message: result.needsReverification
        ? "Supplier details changed. Verify the current details before activating and restoring products."
        : "Supplier updated. Withdrawn products need a separate review before restoration.",
      ...result,
    });
  } catch (error) {
    return sendError(
      res,
      error,
      "Unable to update this supplier. Please retry."
    );
  }
}

async function setSupplierStatus(req, res) {
  if (!ensureAdmin(req, res)) return;

  try {
    keys(
      req.body,
      ["revision", "status"],
      "Supplier status"
    );

    const status = choice(
      req.body.status,
      STATUSES,
      "Supplier status"
    );

    const result = await mutate(req, (supplier) => {
      if (status === "active") {
        const issues = setupIssues(supplier);

        if (issues.length) {
          throw problem(
            400,
            issues[0],
            "SUPPLIER_SETUP_INCOMPLETE"
          );
        }
      }

      supplier.status = status;
    });

    return res.json({
      success: true,
      message:
        status === "active"
          ? "Supplier activated. Review and restore its products separately."
          : `Supplier marked ${status}. Its published products have been withdrawn.`,
      ...result,
    });
  } catch (error) {
    return sendError(
      res,
      error,
      "Unable to change supplier status. Please retry."
    );
  }
}

async function setSupplierVerification(req, res) {
  if (!ensureAdmin(req, res)) return;

  try {
    keys(
      req.body,
      ["revision", "status", "notes"],
      "Supplier verification"
    );

    const status = choice(
      req.body.status,
      VERIFICATION_STATUSES,
      "Verification status"
    );

    const notes = text(
      req.body.notes,
      "Verification notes",
      2000
    );

    if (status !== "pending" && !notes) {
      throw problem(
        400,
        "Record what you checked, or why verification was rejected.",
        "VERIFICATION_NOTES_REQUIRED"
      );
    }

    const actor = identifier(
      String(req.user._id || req.user.id || ""),
      "Admin account ID"
    );

    const result = await mutate(req, (supplier) => {
      supplier.set("verification", {
        status,
        notes,
        verifiedBy: status === "verified" ? actor : null,
        verifiedAt: status === "verified" ? new Date() : null,
      });

      if (
        status !== "verified" &&
        supplier.status === "active"
      ) {
        supplier.status = "draft";
      }
    });

    return res.json({
      success: true,
      message:
        status === "verified"
          ? "Supplier verification recorded. Activation remains a separate action."
          : "Verification updated. Products from an inactive supplier remain withdrawn.",
      ...result,
    });
  } catch (error) {
    return sendError(
      res,
      error,
      "Unable to record supplier verification. Please retry."
    );
  }
}

module.exports = {
  getSuppliers,
  getSupplierById,
  createSupplier,
  updateSupplier,
  setSupplierStatus,
  setSupplierVerification,
};