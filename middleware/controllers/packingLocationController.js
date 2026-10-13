const mongoose = require("mongoose");

const PackingLocation = require("../../models/PackingLocation");
const Supplier = require("../../models/Supplier");
const Product = require("../../models/Product");

const {
  dayRange,
  confirmedDate,
  reference,
} = require("../../utils/kitDefinitions");

const PRIVATE =
  "+address +contact +verification +packing +delivery " +
  "+acceptsGymDrobeStock +supplierArrangements " +
  "+gymdrobeStockTransfer +notes";

const STATES = ["draft", "active", "paused", "archived"];

function problem(status, message) {
  const error = new Error(message);
  error.status = status;
  throw error;
}

function object(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    problem(400, `${label} must be an object.`);
  }

  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) {
      problem(400, `Unsupported ${label} field: ${key}.`);
    }
  }
}

function text(value, maximum, label) {
  if (
    typeof value !== "string" ||
    value.trim().length > maximum
  ) {
    problem(
      400,
      `${label} must be text of at most ${maximum} characters.`,
    );
  }

  return value.trim();
}

function id(value, label) {
  if (
    typeof value !== "string" ||
    !mongoose.isObjectIdOrHexString(value)
  ) {
    problem(400, `${label} is invalid.`);
  }

  return value.toLowerCase();
}

function choice(value, options, label) {
  if (!options.includes(value)) {
    problem(400, `Choose a valid ${label}.`);
  }

  return value;
}

function version(body) {
  if (
    !Number.isSafeInteger(body.version) ||
    body.version < 0
  ) {
    problem(
      400,
      "Include the version returned when loading this location.",
    );
  }
}

function pair(value, low, high, label) {
  object(value, [low, high], label);

  const result = {
    [low]: value[low] ?? null,
    [high]: value[high] ?? null,
  };

  if (
    (result[low] != null || result[high] != null) &&
    !dayRange(result[low], result[high])
  ) {
    problem(
      400,
      `${label} needs two whole-number limits from 0 to 365, with maximum at least minimum.`,
    );
  }

  return result;
}

function normalize(body, updating) {
  object(
    body,
    [
      "version",
      "name",
      "operator",
      "status",
      "address",
      "contact",
      "packing",
      "delivery",
      "acceptsGymDrobeStock",
      "supplierArrangements",
      "gymdrobeStockTransfer",
      "notes",
    ],
    "location",
  );

  if (updating) {
    version(body);
  } else if (body.version !== undefined) {
    problem(400, "A new location does not need a version.");
  }

  const value = {};

  for (const [key, maximum] of [
    ["name", 200],
    ["notes", 2000],
  ]) {
    if (body[key] !== undefined) {
      value[key] = text(body[key], maximum, key);
    }
  }

  if (!updating && (!value.name || value.name.length < 2)) {
    problem(
      400,
      "Enter a location name with at least two characters.",
    );
  }

  if (body.operator !== undefined) {
    value.operator = choice(
      body.operator,
      ["gymdrobe", "fulfillment-partner"],
      "operator",
    );
  }

  if (body.status !== undefined) {
    value.status = choice(body.status, STATES, "location status");

    if (!updating && value.status !== "draft") {
      problem(
        400,
        "Create the location as a draft before confirming or activating it.",
      );
    }
  }

  if (body.address !== undefined) {
    object(
      body.address,
      ["addressLine", "city", "state", "pincode"],
      "address",
    );

    value.address = {};

    for (const [key, maximum] of [
      ["addressLine", 500],
      ["city", 100],
      ["state", 100],
      ["pincode", 6],
    ]) {
      value.address[key] = text(
        body.address[key] ?? "",
        maximum,
        key,
      );
    }
  }

  if (body.contact !== undefined) {
    object(body.contact, ["name", "phone", "email"], "contact");

    value.contact = {
      name: text(body.contact.name ?? "", 100, "Contact name"),
      phone: text(body.contact.phone ?? "", 40, "Phone").replace(
        /[\s()+-]/g,
        "",
      ),
      email: text(
        body.contact.email ?? "",
        150,
        "Email",
      ).toLowerCase(),
    };
  }

  if (body.packing !== undefined) {
    value.packing = pair(
      body.packing,
      "packingDaysMin",
      "packingDaysMax",
      "Packing times",
    );
  }

  if (body.delivery !== undefined) {
    value.delivery = pair(
      body.delivery,
      "transitDaysMin",
      "transitDaysMax",
      "Delivery estimates",
    );
  }

  if (body.acceptsGymDrobeStock !== undefined) {
    if (typeof body.acceptsGymDrobeStock !== "boolean") {
      problem(400, "Accepts GymDrobe stock must be true or false.");
    }

    value.acceptsGymDrobeStock = body.acceptsGymDrobeStock;
  }

  if (body.supplierArrangements !== undefined) {
    if (
      !Array.isArray(body.supplierArrangements) ||
      body.supplierArrangements.length > 500
    ) {
      problem(400, "Use at most 500 supplier arrangements.");
    }

    value.supplierArrangements = body.supplierArrangements.map(
      (row) => {
        object(
          row,
          [
            "supplier",
            "status",
            "arrangementReference",
            "transferDaysMin",
            "transferDaysMax",
          ],
          "supplier arrangement",
        );

        const times = pair(
          {
            transferDaysMin: row.transferDaysMin,
            transferDaysMax: row.transferDaysMax,
          },
          "transferDaysMin",
          "transferDaysMax",
          "Supplier transfer times",
        );

        return {
          supplier: id(row.supplier, "Supplier ID"),
          status: choice(
            row.status ?? "pending",
            ["pending", "confirmed", "paused"],
            "supplier arrangement status",
          ),
          arrangementReference: text(
            row.arrangementReference ?? "",
            200,
            "Supplier arrangement reference",
          ),
          ...times,
        };
      },
    );

    if (
      new Set(value.supplierArrangements.map((row) => row.supplier))
        .size !== value.supplierArrangements.length
    ) {
      problem(400, "List each supplier only once.");
    }
  }

  if (body.gymdrobeStockTransfer !== undefined) {
    value.gymdrobeStockTransfer =
      body.gymdrobeStockTransfer === null
        ? null
        : normalizeTransfer(body.gymdrobeStockTransfer);
  }

  return value;
}

function normalizeTransfer(row) {
  object(
    row,
    [
      "status",
      "originName",
      "originAddress",
      "originContact",
      "productIds",
      "transferDaysMin",
      "transferDaysMax",
      "arrangementReference",
    ],
    "GymDrobe stock transfer",
  );

  const origin = normalize(
    {
      address: row.originAddress ?? {},
      contact: row.originContact ?? {},
      version: 0,
    },
    true,
  );

  if (
    !Array.isArray(row.productIds) ||
    row.productIds.length > 500
  ) {
    problem(400, "Choose up to 500 product IDs for the transfer route.");
  }

  const productIds = row.productIds.map((value) =>
    id(value, "Transfer product ID"),
  );

  if (new Set(productIds).size !== productIds.length) {
    problem(400, "Choose each transfer product only once.");
  }

  return {
    status: choice(
      row.status ?? "pending",
      ["pending", "confirmed", "paused"],
      "transfer status",
    ),
    originName: text(row.originName ?? "", 200, "Stock origin name"),
    originAddress: origin.address,
    originContact: origin.contact,
    productIds,
    ...pair(
      {
        transferDaysMin: row.transferDaysMin,
        transferDaysMax: row.transferDaysMax,
      },
      "transferDaysMin",
      "transferDaysMax",
      "GymDrobe transfer times",
    ),
    arrangementReference: text(
      row.arrangementReference ?? "",
      200,
      "Transfer arrangement reference",
    ),
  };
}

async function transferProducts(row) {
  const ids = (row?.productIds || []).map(reference);

  if (!ids.length) {
    return new Map();
  }

  const products = await Product.find({
    _id: { $in: ids },
  })
    .select("+fulfillment")
    .lean();

  return new Map(
    products.map((product) => [reference(product._id), product]),
  );
}

async function validateTransferProducts(row) {
  const products = await transferProducts(row);

  if (
    (row?.productIds || []).some(
      (value) => !products.has(reference(value)),
    )
  ) {
    problem(
      400,
      "A selected transfer product no longer exists. Reload the product list.",
    );
  }
}

async function transferIssues(location, requireConfirmation = true) {
  const row = location.gymdrobeStockTransfer;
  const issues = [];

  if (location.acceptsGymDrobeStock !== true) {
    issues.push("Enable receipt of GymDrobe-held stock.");
  }

  if (!row) {
    return [...issues, "Save a GymDrobe stock transfer route first."];
  }

  if (
    !row.originName ||
    row.originName.trim().length < 2 ||
    !row.originAddress?.addressLine ||
    !row.originAddress.city ||
    !row.originAddress.state ||
    !/^[1-9]\d{5}$/.test(row.originAddress.pincode || "")
  ) {
    issues.push(
      "Record the real stock origin and complete pickup address.",
    );
  }

  if (
    !row.originContact?.name ||
    !(row.originContact.phone || row.originContact.email)
  ) {
    issues.push("Record a named pickup contact and phone or email.");
  }

  if (!dayRange(row.transferDaysMin, row.transferDaysMax)) {
    issues.push("Record both GymDrobe transfer estimates.");
  }

  if (!row.arrangementReference?.trim()) {
    issues.push("Record the real stock transfer arrangement reference.");
  }

  if (!row.productIds?.length) {
    issues.push("Choose the GymDrobe-held products covered by this route.");
  }

  if (
    requireConfirmation &&
    (
      row.status !== "confirmed" ||
      !confirmedDate(row.confirmedAt) ||
      !reference(row.confirmedBy)
    )
  ) {
    issues.push(
      "Confirm the real GymDrobe stock transfer arrangement separately.",
    );
  }

  const products = await transferProducts(row);

  for (const productId of row.productIds || []) {
    const product = products.get(reference(productId));

    if (
      !product ||
      product.isActive === false ||
      product.fulfillment?.stockSource !== "gymdrobe" ||
      product.fulfillment?.canSendToPackingLocation !== true ||
      !dayRange(
        product.fulfillment?.preparationDaysMin,
        product.fulfillment?.preparationDaysMax,
      )
    ) {
      issues.push(
        `Product ${reference(productId)} must be active, held by GymDrobe and configured for packing transfers with preparation times.`,
      );
    }
  }

  return issues;
}

function transferUnchanged(previous, next) {
  return (
    previous &&
    [
      "originName",
      "originAddress",
      "originContact",
      "transferDaysMin",
      "transferDaysMax",
      "arrangementReference",
    ].every((key) => same(previous[key], next[key])) &&
    same(
      (previous.productIds || []).map(reference).sort(),
      [...next.productIds].sort(),
    )
  );
}

function clearTransferConfirmation(location) {
  const row = location.gymdrobeStockTransfer;

  if (!row) {
    return;
  }

  if (row.status === "confirmed") {
    row.status = "pending";
  }

  row.confirmedAt = null;
  row.confirmedBy = null;
}

function plain(value) {
  return value?.toObject
    ? value.toObject({ transform: false })
    : value;
}

function comparable(value) {
  value = plain(value);

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (value instanceof mongoose.Types.ObjectId) {
    return String(value);
  }

  if (Array.isArray(value)) {
    return value.map(comparable);
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, comparable(value[key])]),
    );
  }

  return value;
}

function same(left, right) {
  return (
    JSON.stringify(comparable(left)) ===
    JSON.stringify(comparable(right))
  );
}

function operationalIssues(location) {
  const issues = [];

  if (
    !location.address?.addressLine ||
    !location.address.city ||
    !location.address.state ||
    !/^[1-9]\d{5}$/.test(location.address.pincode || "")
  ) {
    issues.push("Complete the real packing address.");
  }

  if (
    !location.contact?.name ||
    !(location.contact.phone || location.contact.email)
  ) {
    issues.push("Add a named contact and phone or email.");
  }

  if (
    !dayRange(
      location.packing?.packingDaysMin,
      location.packing?.packingDaysMax,
    )
  ) {
    issues.push("Record packing times.");
  }

  if (
    !dayRange(
      location.delivery?.transitDaysMin,
      location.delivery?.transitDaysMax,
    )
  ) {
    issues.push("Record courier transit estimates.");
  }

  return issues;
}

function supplierReady(supplier) {
  return (
    supplier?.status === "active" &&
    supplier.verification?.status === "verified" &&
    confirmedDate(supplier.verification.verifiedAt) &&
    reference(supplier.verification.verifiedBy) &&
    Boolean(
      supplier.contact?.phone ||
      supplier.contact?.whatsapp ||
      supplier.contact?.email,
    ) &&
    supplier.fulfillment?.sendToPackingLocation === true &&
    dayRange(
      supplier.fulfillment.preparationDaysMin,
      supplier.fulfillment.preparationDaysMax,
    )
  );
}

async function supplierMap(rows) {
  const ids = [...new Set(rows.map((row) => reference(row.supplier)))];

  if (!ids.length) {
    return new Map();
  }

  const suppliers = await Supplier.find({
    _id: { $in: ids },
  })
    .select("+contact +verification +fulfillment")
    .lean();

  return new Map(
    suppliers.map((row) => [String(row._id), row]),
  );
}

async function readiness(location) {
  const issues = operationalIssues(location);

  if (
    !confirmedDate(location.verification?.confirmedAt) ||
    !reference(location.verification?.confirmedBy) ||
    !location.verification?.arrangementReference
  ) {
    issues.push("Confirm the real packing arrangement.");
  }

  const suppliers = await supplierMap(
    location.supplierArrangements || [],
  );

  let usable = false;

  if (location.acceptsGymDrobeStock === true) {
    const stockIssues = await transferIssues(location);
    usable = stockIssues.length === 0;

    if (
      location.gymdrobeStockTransfer?.status === "confirmed" &&
      stockIssues.length
    ) {
      issues.push(...stockIssues);
    }
  }

  for (const row of location.supplierArrangements || []) {
    if (row.status !== "confirmed") {
      continue;
    }

    if (
      !supplierReady(suppliers.get(reference(row.supplier))) ||
      !confirmedDate(row.confirmedAt) ||
      !reference(row.confirmedBy) ||
      !row.arrangementReference ||
      !dayRange(row.transferDaysMin, row.transferDaysMax)
    ) {
      issues.push(
        `Supplier ${reference(row.supplier)} is no longer ready to send products to this location.`,
      );
    } else {
      usable = true;
    }
  }

  if (!usable) {
    issues.push(
      "Confirm a complete GymDrobe stock transfer route or at least one ready supplier arrangement.",
    );
  }

  return issues;
}

async function serialize(location) {
  const value = location.toObject({ transform: false });

  value.id = String(value._id);
  value.version = value.__v ?? 0;
  delete value.__v;

  value.gymdrobeStockTransferIssues =
    location.acceptsGymDrobeStock === true ||
    location.gymdrobeStockTransfer
      ? await transferIssues(location)
      : [];

  value.gymdrobeStockTransferReady =
    location.acceptsGymDrobeStock === true &&
    value.gymdrobeStockTransferIssues.length === 0;

  value.readinessIssues = await readiness(location);

  value.ready =
    location.status === "active" &&
    value.readinessIssues.length === 0;

  return value;
}

async function load(req) {
  const location = await PackingLocation.findById(
    id(req.params.id, "Location ID"),
  ).select(PRIVATE);

  if (!location) {
    problem(404, "Packing location not found.");
  }

  if ((location.__v ?? 0) !== req.body.version) {
    problem(
      409,
      "This location changed. Reload it before saving again.",
    );
  }

  return location;
}

function guarded(handler) {
  return async (req, res) => {
    res.set("Cache-Control", "no-store");

    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: "Admin sign-in is required.",
      });
    }

    if (
      req.user.role !== "admin" ||
      req.user.isActive === false
    ) {
      return res.status(403).json({
        success: false,
        message: "An active admin account is required.",
      });
    }

    try {
      return await handler(req, res);
    } catch (error) {
      let status = error.status || 503;
      let message = error.message;

      if (error.name === "ValidationError") {
        status = 400;
        message = Object.values(error.errors)
          .map((row) => row.message)
          .join(" ");
      } else if (
        error.name === "VersionError" ||
        error.code === 11000
      ) {
        status = 409;
        message =
          "This location changed. Reload it before saving again.";
      } else if (!error.status) {
        console.error(
          "Packing administration failed:",
          error.name || "Error",
        );

        message =
          "Packing administration is temporarily unavailable. Reload to check the result before retrying a save.";
      }

      return res.status(status).json({
        success: false,
        message,
      });
    }
  };
}

const getPackingLocations = guarded(async (req, res) => {
  const page = Number(req.query.page ?? 1);
  const limit = Number(req.query.limit ?? 25);

  if (
    !Number.isSafeInteger(page) ||
    page < 1 ||
    page > 100000 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 100
  ) {
    problem(400, "Use a valid page and a limit from 1 to 100.");
  }

  const filter = {};

  if (req.query.status) {
    filter.status = choice(
      req.query.status,
      STATES,
      "status filter",
    );
  }

  if (req.query.search) {
    const search = text(req.query.search, 100, "Search");

    filter.name = {
      $regex: search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
      $options: "i",
    };
  }

  const [rows, total] = await Promise.all([
    PackingLocation.find(filter)
      .select(PRIVATE)
      .sort({ name: 1, _id: 1 })
      .skip((page - 1) * limit)
      .limit(limit),
    PackingLocation.countDocuments(filter),
  ]);

  const locations = [];

  for (const row of rows) {
    locations.push(await serialize(row));
  }

  return res.json({
    success: true,
    locations,
    total,
    page,
    pages: Math.max(1, Math.ceil(total / limit)),
    limit,
  });
});

const getPackingLocation = guarded(async (req, res) => {
  const location = await PackingLocation.findById(
    id(req.params.id, "Location ID"),
  ).select(PRIVATE);

  if (!location) {
    problem(404, "Packing location not found.");
  }

  return res.json({
    success: true,
    location: await serialize(location),
  });
});

const createPackingLocation = guarded(async (req, res) => {
  const value = normalize(req.body, false);

  if (
    value.supplierArrangements?.some(
      (row) => row.status === "confirmed",
    )
  ) {
    problem(
      400,
      "Create supplier arrangements as pending, then confirm them separately.",
    );
  }

  if (value.gymdrobeStockTransfer?.status === "confirmed") {
    problem(
      400,
      "Save the stock transfer as pending, then confirm it separately.",
    );
  }

  await validateTransferProducts(value.gymdrobeStockTransfer);

  const suppliers = await supplierMap(
    value.supplierArrangements || [],
  );

  if (
    (value.supplierArrangements || []).some(
      (row) => !suppliers.has(row.supplier),
    )
  ) {
    problem(400, "A selected supplier no longer exists.");
  }

  const location = new PackingLocation({
    ...value,
    status: "draft",
  });

  await location.save();

  return res.status(201).json({
    success: true,
    location: await serialize(location),
  });
});

const updatePackingLocation = guarded(async (req, res) => {
  const value = normalize(req.body, true);
  const location = await load(req);

  const destinationChanged = ["name", "operator", "address"].some(
    (key) =>
      value[key] !== undefined &&
      !same(location[key], value[key]),
  );

  const operationsChanged =
    destinationChanged ||
    ["contact", "packing", "delivery", "acceptsGymDrobeStock"].some(
      (key) =>
        value[key] !== undefined &&
        !same(location[key], value[key]),
    );

  const original = new Map(
    location.supplierArrangements.map((row) => [
      reference(row.supplier),
      plain(row),
    ]),
  );

  if (value.supplierArrangements !== undefined) {
    const suppliers = await supplierMap(value.supplierArrangements);

    value.supplierArrangements = value.supplierArrangements.map(
      (row) => {
        if (!suppliers.has(row.supplier)) {
          problem(400, "A selected supplier no longer exists.");
        }

        const previous = original.get(row.supplier);

        const unchanged =
          previous &&
          previous.arrangementReference === row.arrangementReference &&
          previous.transferDaysMin === row.transferDaysMin &&
          previous.transferDaysMax === row.transferDaysMax;

        if (
          row.status === "confirmed" &&
          (!unchanged || previous.status !== "confirmed")
        ) {
          problem(
            400,
            "Save this supplier arrangement as pending and confirm its real details separately.",
          );
        }

        return {
          ...row,
          confirmedAt:
            !destinationChanged && row.status === "confirmed"
              ? previous.confirmedAt
              : null,
          confirmedBy:
            !destinationChanged && row.status === "confirmed"
              ? previous.confirmedBy
              : null,
          status:
            destinationChanged && row.status === "confirmed"
              ? "pending"
              : row.status,
        };
      },
    );
  }

  if (
    value.gymdrobeStockTransfer !== undefined &&
    value.gymdrobeStockTransfer !== null
  ) {
    const row = value.gymdrobeStockTransfer;
    const previous = plain(location.gymdrobeStockTransfer);

    await validateTransferProducts(row);

    const unchanged = transferUnchanged(previous, row);

    if (
      row.status === "confirmed" &&
      (!unchanged || previous?.status !== "confirmed")
    ) {
      problem(
        400,
        "Save stock transfer changes as pending and confirm the real updated arrangement separately.",
      );
    }

    const retain =
      !operationsChanged && row.status === "confirmed";

    value.gymdrobeStockTransfer = {
      ...row,
      status:
        operationsChanged && row.status === "confirmed"
          ? "pending"
          : row.status,
      confirmedAt: retain ? previous.confirmedAt : null,
      confirmedBy: retain ? previous.confirmedBy : null,
    };

    // Preserve unchanged confirmed subdocuments and their audit record.
    if (retain && unchanged) {
      delete value.gymdrobeStockTransfer;
    }
  }

  for (const [key, entry] of Object.entries(value)) {
    location.set(key, entry);
  }

  if (operationsChanged) {
    location.verification = {
      confirmedAt: null,
      confirmedBy: null,
      arrangementReference: "",
    };

    clearTransferConfirmation(location);
  }

  if (destinationChanged) {
    for (const row of location.supplierArrangements) {
      if (row.status === "confirmed") {
        row.status = "pending";
      }

      row.confirmedAt = null;
      row.confirmedBy = null;
    }
  }

  if (operationsChanged && location.status === "active") {
    if (value.status === "active") {
      problem(
        400,
        "Save operational changes as paused or draft, then reconfirm before activation.",
      );
    }

    location.status = "paused";
  }

  if (location.status === "active") {
    const issues = await readiness(location);

    if (issues.length) {
      problem(400, issues.join(" "));
    }
  }

  await location.save();

  return res.json({
    success: true,
    location: await serialize(location),
    message: operationsChanged
      ? "Location saved. Operational changes require reconfirmation."
      : "Location saved.",
  });
});

const confirmPackingLocation = guarded(async (req, res) => {
  object(
    req.body,
    ["version", "arrangementReference"],
    "confirmation",
  );

  version(req.body);

  const location = await load(req);

  if (location.status === "archived") {
    problem(
      400,
      "Restore this location to draft or paused before confirming it.",
    );
  }

  const arrangementReference = text(
    req.body.arrangementReference,
    200,
    "Arrangement reference",
  );

  if (!arrangementReference) {
    problem(
      400,
      "Record a reference for the actual packing agreement.",
    );
  }

  const issues = operationalIssues(location);

  if (issues.length) {
    problem(400, issues.join(" "));
  }

  location.verification = {
    confirmedAt: new Date(),
    confirmedBy: req.user._id,
    arrangementReference,
  };

  await location.save();

  return res.json({
    success: true,
    location: await serialize(location),
    message:
      "Packing agreement confirmed. Activation is a separate action.",
  });
});

const confirmSupplierArrangement = guarded(async (req, res) => {
  object(
    req.body,
    [
      "version",
      "arrangementReference",
      "transferDaysMin",
      "transferDaysMax",
    ],
    "supplier confirmation",
  );

  version(req.body);

  const location = await load(req);

  if (location.status === "archived") {
    problem(
      400,
      "Restore this location before confirming a supplier arrangement.",
    );
  }

  const supplierId = id(req.params.supplierId, "Supplier ID");

  const row = location.supplierArrangements.find(
    (value) => reference(value.supplier) === supplierId,
  );

  if (!row) {
    problem(
      404,
      "Save this supplier in the location's pending arrangements first.",
    );
  }

  const suppliers = await supplierMap([row]);

  if (!supplierReady(suppliers.get(supplierId))) {
    problem(
      400,
      "The supplier must be active, verified and configured to send products to a packing location with preparation times.",
    );
  }

  const arrangementReference = text(
    req.body.arrangementReference,
    200,
    "Supplier agreement reference",
  );

  if (!arrangementReference) {
    problem(
      400,
      "Record a reference for this supplier-to-location agreement.",
    );
  }

  const times = pair(
    {
      transferDaysMin: req.body.transferDaysMin,
      transferDaysMax: req.body.transferDaysMax,
    },
    "transferDaysMin",
    "transferDaysMax",
    "Transfer times",
  );

  if (!dayRange(times.transferDaysMin, times.transferDaysMax)) {
    problem(
      400,
      "Record both supplier transfer estimates before confirmation.",
    );
  }

  Object.assign(row, times, {
    arrangementReference,
    status: "confirmed",
    confirmedAt: new Date(),
    confirmedBy: req.user._id,
  });

  await location.save();

  return res.json({
    success: true,
    location: await serialize(location),
    message: "Supplier-to-location agreement confirmed.",
  });
});

const confirmGymDrobeStockTransfer = guarded(async (req, res) => {
  object(req.body, ["version"], "stock transfer confirmation");
  version(req.body);

  const location = await load(req);

  if (location.status === "archived") {
    problem(
      400,
      "Restore this location before confirming a stock transfer.",
    );
  }

  if (
    !location.gymdrobeStockTransfer ||
    location.gymdrobeStockTransfer.status !== "pending"
  ) {
    problem(
      400,
      "Save the stock transfer as pending before confirming it.",
    );
  }

  const issues = [
    ...operationalIssues(location),
    ...(await transferIssues(location, false)),
  ];

  if (
    !confirmedDate(location.verification?.confirmedAt) ||
    !reference(location.verification?.confirmedBy) ||
    !location.verification?.arrangementReference
  ) {
    issues.push("Confirm the packing-location agreement first.");
  }

  if (issues.length) {
    problem(400, issues.join(" "));
  }

  Object.assign(location.gymdrobeStockTransfer, {
    status: "confirmed",
    confirmedAt: new Date(),
    confirmedBy: req.user._id,
  });

  await location.save();

  return res.json({
    success: true,
    location: await serialize(location),
    message:
      "GymDrobe stock transfer confirmed for the selected products. This does not reserve inventory or confirm customer delivery coverage.",
  });
});

module.exports = {
  getPackingLocations,
  getPackingLocation,
  createPackingLocation,
  updatePackingLocation,
  confirmPackingLocation,
  confirmSupplierArrangement,
  confirmGymDrobeStockTransfer,
};