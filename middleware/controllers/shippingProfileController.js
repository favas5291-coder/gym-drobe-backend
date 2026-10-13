const mongoose = require("mongoose");

const ShippingProfile = require("../../models/ShippingProfile");
const Product = require("../../models/Product");
const Supplier = require("../../models/Supplier");
const PackingLocation = require("../../models/PackingLocation");

const {
  reference,
  dayRange,
  confirmedDate,
} = require("../../utils/kitDefinitions");

const STATES = [
  "draft",
  "active",
  "paused",
  "archived",
];

const TERMS = [
  "name",
  "origin",
  "productIds",
  "destinationPincodes",
  "service",
  "parcelLimits",
  "charges",
];

const LIMITS = {
  maximumWeightGrams: 500000,
  maximumLengthMm: 10000,
  maximumWidthMm: 10000,
  maximumHeightMm: 10000,
  maximumUnits: 999,
};

function fail(status, message) {
  throw Object.assign(new Error(message), { status });
}

function object(value, keys, label) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    fail(400, `${label} must be an object.`);
  }

  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) {
      fail(400, `Unsupported ${label} field: ${key}.`);
    }
  }
}

function text(value, maximum, label) {
  if (
    typeof value !== "string" ||
    value.trim().length > maximum
  ) {
    fail(
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
    fail(400, `${label} is invalid.`);
  }

  return value.toLowerCase();
}

function choice(value, options, label) {
  if (!options.includes(value)) {
    fail(400, `Choose a valid ${label}.`);
  }

  return value;
}

function whole(value, maximum, label, minimum = 0) {
  if (value == null) {
    return null;
  }

  if (
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    fail(
      400,
      `${label} must be a whole number from ${minimum} to ${maximum}.`,
    );
  }

  return value;
}

function boolean(value, label) {
  if (typeof value !== "boolean") {
    fail(400, `${label} must be true or false.`);
  }

  return value;
}

function version(body) {
  if (
    !Number.isSafeInteger(body.version) ||
    body.version < 0
  ) {
    fail(
      400,
      "Include the version returned when loading this shipping profile.",
    );
  }
}

function normalize(body, updating) {
  object(
    body,
    [
      "version",
      "name",
      "status",
      "origin",
      "productIds",
      "destinationPincodes",
      "service",
      "parcelLimits",
      "charges",
      "notes",
    ],
    "shipping profile",
  );

  if (updating) {
    version(body);
  } else if (body.version !== undefined) {
    fail(400, "A new shipping profile does not need a version.");
  }

  const result = {};

  for (const [key, maximum] of [
    ["name", 200],
    ["notes", 2000],
  ]) {
    if (body[key] !== undefined) {
      result[key] = text(body[key], maximum, key);
    }
  }

  if (
    (body.name !== undefined || !updating) &&
    (!result.name || result.name.length < 2)
  ) {
    fail(400, "Enter a profile name with at least two characters.");
  }

  if (body.status !== undefined) {
    result.status = choice(
      body.status,
      STATES,
      "profile status",
    );
  }

  if (
    !updating &&
    result.status &&
    result.status !== "draft"
  ) {
    fail(
      400,
      "Create a draft, then confirm the actual shipping arrangement separately.",
    );
  }

  if (body.origin !== undefined) {
    const row = body.origin;

    object(
      row,
      [
        "kind",
        "name",
        "pickupPincode",
        "packingLocation",
        "supplier",
      ],
      "origin",
    );

    result.origin = {
      kind: choice(
        row.kind ?? "unconfigured",
        [
          "unconfigured",
          "packing-location",
          "supplier",
          "gymdrobe",
        ],
        "origin type",
      ),

      name: text(row.name ?? "", 200, "Origin name"),

      pickupPincode: text(
        row.pickupPincode ?? "",
        6,
        "Pickup pincode",
      ),

      packingLocation:
        row.packingLocation == null || row.packingLocation === ""
          ? null
          : id(row.packingLocation, "Packing location ID"),

      supplier:
        row.supplier == null || row.supplier === ""
          ? null
          : id(row.supplier, "Supplier ID"),
    };

    if (
      result.origin.pickupPincode &&
      !/^[1-9]\d{5}$/.test(result.origin.pickupPincode)
    ) {
      fail(400, "Enter a valid six-digit pickup pincode.");
    }
  }

  if (body.productIds !== undefined) {
    if (
      !Array.isArray(body.productIds) ||
      body.productIds.length > 500
    ) {
      fail(400, "Choose at most 500 products.");
    }

    result.productIds = body.productIds.map((value) =>
      id(value, "Product ID"),
    );

    if (
      new Set(result.productIds).size !== result.productIds.length
    ) {
      fail(400, "Choose each product only once.");
    }
  }

  if (body.destinationPincodes !== undefined) {
    if (
      !Array.isArray(body.destinationPincodes) ||
      body.destinationPincodes.length > 10000
    ) {
      fail(400, "Use at most 10,000 exact destination pincodes.");
    }

    result.destinationPincodes = body.destinationPincodes.map(
      (value) => {
        const pin = text(value, 6, "Destination pincode");

        if (!/^[1-9]\d{5}$/.test(pin)) {
          fail(
            400,
            "Every destination pincode must contain six digits and cannot begin with zero.",
          );
        }

        return pin;
      },
    );

    if (
      new Set(result.destinationPincodes).size !==
      result.destinationPincodes.length
    ) {
      fail(400, "List each destination pincode only once.");
    }
  }

  if (body.service !== undefined) {
    const row = body.service;

    object(
      row,
      [
        "carrier",
        "name",
        "deliveryMethod",
        "supportsOnline",
        "supportsCodAdvance",
        "maximumCodBalancePaise",
        "transitDaysMin",
        "transitDaysMax",
      ],
      "courier service",
    );

    result.service = {
      carrier: text(row.carrier ?? "", 100, "Courier name"),
      name: text(row.name ?? "", 150, "Service name"),

      deliveryMethod: choice(
        row.deliveryMethod ?? "standard",
        ["standard", "express"],
        "delivery method",
      ),

      supportsOnline: boolean(
        row.supportsOnline ?? true,
        "Online payment support",
      ),

      supportsCodAdvance: boolean(
        row.supportsCodAdvance ?? false,
        "COD advance support",
      ),

      maximumCodBalancePaise: whole(
        row.maximumCodBalancePaise,
        100000000,
        "Maximum COD balance in paise",
      ),

      transitDaysMin: whole(
        row.transitDaysMin,
        365,
        "Minimum transit days",
      ),

      transitDaysMax: whole(
        row.transitDaysMax,
        365,
        "Maximum transit days",
      ),
    };

    if (
      (
        result.service.transitDaysMin != null ||
        result.service.transitDaysMax != null
      ) &&
      !dayRange(
        result.service.transitDaysMin,
        result.service.transitDaysMax,
      )
    ) {
      fail(
        400,
        "Record both transit limits, with maximum at least minimum.",
      );
    }
  }

  if (body.parcelLimits !== undefined) {
    object(
      body.parcelLimits,
      Object.keys(LIMITS),
      "parcel limits",
    );

    result.parcelLimits = Object.fromEntries(
      Object.entries(LIMITS).map(([key, maximum]) => [
        key,
        whole(body.parcelLimits[key], maximum, key, 1),
      ]),
    );
  }

  if (body.charges !== undefined) {
    object(
      body.charges,
      ["shippingPaise", "codFeePaise", "courierCostPaise"],
      "charges",
    );

    result.charges = {
      shippingPaise: whole(
        body.charges.shippingPaise,
        100000000,
        "Shipping charge in paise",
      ),

      codFeePaise: whole(
        body.charges.codFeePaise ?? 0,
        100000000,
        "COD fee in paise",
      ),

      courierCostPaise: whole(
        body.charges.courierCostPaise,
        100000000,
        "Courier cost in paise",
      ),
    };
  }

  return result;
}

async function readReferences(profile) {
  const origin = profile.origin || {};

  const [products, supplier, location] = await Promise.all([
    profile.productIds?.length
      ? Product.find({
          _id: { $in: profile.productIds },
        })
          .select("+supplier +fulfillment")
          .lean()
      : Promise.resolve([]),

    origin.supplier
      ? Supplier.findById(origin.supplier)
          .select("+contact +verification +fulfillment")
          .lean()
      : Promise.resolve(null),

    origin.packingLocation
      ? PackingLocation.findById(origin.packingLocation)
          .select(
            "+address +contact +verification +packing +delivery",
          )
          .lean()
      : Promise.resolve(null),
  ]);

  return {
    products: new Map(
      products.map((row) => [reference(row._id), row]),
    ),
    supplier,
    location,
  };
}

async function requireReferences(profile) {
  const data = await readReferences(profile);

  if (
    (profile.productIds || []).some(
      (value) => !data.products.has(reference(value)),
    )
  ) {
    fail(
      400,
      "A selected product no longer exists. Reload the product list.",
    );
  }

  if (profile.origin?.supplier && !data.supplier) {
    fail(400, "The selected supplier no longer exists.");
  }

  if (profile.origin?.packingLocation && !data.location) {
    fail(400, "The selected packing location no longer exists.");
  }
}

async function readiness(profile, requireVerification = true) {
  const issues = [];
  const origin = profile.origin || {};
  const service = profile.service || {};
  const charges = profile.charges || {};

  if (
    origin.kind === "unconfigured" ||
    !origin.name?.trim() ||
    !/^[1-9]\d{5}$/.test(origin.pickupPincode || "")
  ) {
    issues.push("Record the actual dispatch origin and pickup pincode.");
  }

  if (!profile.productIds?.length) {
    issues.push("Choose products covered by this profile.");
  }

  if (!profile.destinationPincodes?.length) {
    issues.push("Record exact destination pincodes confirmed by the courier.");
  }

  if (
    !service.carrier ||
    !service.name ||
    !dayRange(service.transitDaysMin, service.transitDaysMax) ||
    !(service.supportsOnline || service.supportsCodAdvance)
  ) {
    issues.push(
      "Complete the courier service, transit times and supported payment methods.",
    );
  }

  if (
    service.supportsCodAdvance &&
    (
      !Number.isSafeInteger(service.maximumCodBalancePaise) ||
      service.maximumCodBalancePaise < 1
    )
  ) {
    issues.push("Record the confirmed maximum COD balance in paise.");
  }

  if (
    Object.keys(LIMITS).some(
      (key) =>
        !Number.isSafeInteger(profile.parcelLimits?.[key]) ||
        profile.parcelLimits[key] < 1,
    )
  ) {
    issues.push("Record all parcel weight, dimension and quantity limits.");
  }

  if (
    !Number.isSafeInteger(charges.shippingPaise) ||
    charges.shippingPaise < 0 ||
    !Number.isSafeInteger(charges.codFeePaise) ||
    charges.codFeePaise < 0
  ) {
    issues.push("Record complete customer shipping and COD charges in paise.");
  }

  if (!service.supportsCodAdvance && charges.codFeePaise !== 0) {
    issues.push("Use zero COD fee for a service without COD advance support.");
  }

  const expiresAt = new Date(
    profile.verification?.validUntil ?? "",
  ).getTime();

  if (
    requireVerification &&
    (
      !confirmedDate(profile.verification?.confirmedAt) ||
      !reference(profile.verification?.confirmedBy) ||
      !profile.verification?.arrangementReference?.trim() ||
      !Number.isFinite(expiresAt) ||
      expiresAt <= Date.now() ||
      expiresAt <= new Date(
        profile.verification?.confirmedAt,
      ).getTime()
    )
  ) {
    issues.push(
      "Confirm the actual shipping arrangement with an unexpired rate and coverage reference.",
    );
  }

  const { products, supplier, location } =
    await readReferences(profile);

  if (origin.kind === "packing-location") {
    if (
      !location ||
      location.status !== "active" ||
      !confirmedDate(location.verification?.confirmedAt) ||
      !reference(location.verification?.confirmedBy) ||
      !location.verification?.arrangementReference ||
      !location.address?.addressLine ||
      !location.address?.city ||
      !location.address?.state ||
      !location.contact?.name ||
      !(location.contact.phone || location.contact.email) ||
      !dayRange(
        location.packing?.packingDaysMin,
        location.packing?.packingDaysMax,
      ) ||
      !dayRange(
        location.delivery?.transitDaysMin,
        location.delivery?.transitDaysMax,
      )
    ) {
      issues.push(
        "The packing origin must exist, be active and have a confirmed operating arrangement.",
      );
    }

    if (
      location &&
      location.address?.pincode !== origin.pickupPincode
    ) {
      issues.push(
        "The pickup pincode must match the saved packing location.",
      );
    }
  } else if (origin.kind === "supplier") {
    if (
      !supplier ||
      supplier.status !== "active" ||
      supplier.verification?.status !== "verified" ||
      !confirmedDate(supplier.verification?.verifiedAt) ||
      !reference(supplier.verification?.verifiedBy) ||
      !(
        supplier.contact?.phone ||
        supplier.contact?.whatsapp ||
        supplier.contact?.email
      ) ||
      supplier.fulfillment?.dispatchToCustomer !== true ||
      !dayRange(
        supplier.fulfillment?.preparationDaysMin,
        supplier.fulfillment?.preparationDaysMax,
      )
    ) {
      issues.push(
        "The supplier origin must be active, verified and configured for direct customer dispatch.",
      );
    }
  }

  for (const productId of profile.productIds || []) {
    const product = products.get(reference(productId));
    const setup = product?.fulfillment || {};

    if (
      !product ||
      product.isActive !== true ||
      product.delivery?.available !== true
    ) {
      issues.push(
        `Product ${reference(productId)} is missing, archived or unavailable for delivery.`,
      );
      continue;
    }

    if (
      !dayRange(
        setup.preparationDaysMin,
        setup.preparationDaysMax,
      )
    ) {
      issues.push(`${product.name}: record product preparation times.`);
    }

    if (
      origin.kind === "supplier" &&
      (
        reference(product.supplier) !== reference(origin.supplier) ||
        setup.stockSource !== "supplier" ||
        setup.dispatchBy !== "supplier" ||
        !confirmedDate(setup.supplierStockConfirmedAt)
      )
    ) {
      issues.push(
        `${product.name}: this product must be configured for the selected supplier's stock and direct dispatch.`,
      );
    }

    if (
      origin.kind === "gymdrobe" &&
      (
        setup.stockSource !== "gymdrobe" ||
        setup.dispatchBy !== "gymdrobe"
      )
    ) {
      issues.push(
        `${product.name}: this product must be configured for GymDrobe-held stock and direct dispatch.`,
      );
    }

    if (
      origin.kind === "packing-location" &&
      (
        setup.canSendToPackingLocation !== true ||
        !["gymdrobe", "supplier"].includes(setup.stockSource)
      )
    ) {
      issues.push(
        `${product.name}: configure its stock owner and packing-location transfers.`,
      );
    }
  }

  return [...new Set(issues)];
}

async function serialize(profile) {
  const value = profile.toObject({ transform: false });

  value.id = String(value._id);
  value.version = value.__v ?? 0;
  delete value.__v;

  value.readinessIssues = await readiness(profile);
  value.ready =
    profile.status === "active" &&
    value.readinessIssues.length === 0;

  value.purchaseEnabled = false;

  return value;
}

async function load(req) {
  const profile = await ShippingProfile.findById(
    id(req.params.id, "Shipping profile ID"),
  ).select(ShippingProfile.adminFields);

  if (!profile) {
    fail(404, "Shipping profile not found.");
  }

  if ((profile.__v ?? 0) !== req.body.version) {
    fail(
      409,
      "This shipping profile changed. Reload before saving again.",
    );
  }

  return profile;
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
      req.user.isActive === false ||
      !reference(req.user._id)
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
          "This shipping profile changed. Reload before saving again.";
      } else if (!error.status) {
        console.error(
          "Shipping administration failed:",
          error.name || "Error",
        );

        message =
          "Shipping administration is temporarily unavailable. Reload to check the result before retrying a save.";
      }

      return res.status(status).json({
        success: false,
        message,
      });
    }
  };
}

const getShippingProfiles = guarded(async (req, res) => {
  const page = Number(req.query.page ?? 1);
  const limit = Number(req.query.limit ?? 12);

  if (
    !Number.isSafeInteger(page) ||
    page < 1 ||
    page > 100000 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 100
  ) {
    fail(400, "Use a valid page and a limit from 1 to 100.");
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
    filter.name = {
      $regex: text(req.query.search, 100, "Search").replace(
        /[.*+?^${}()|[\]\\]/g,
        "\\$&",
      ),
      $options: "i",
    };
  }

  const [rows, total] = await Promise.all([
    ShippingProfile.find(filter)
      .select(ShippingProfile.adminFields)
      .sort({ name: 1, _id: 1 })
      .skip((page - 1) * limit)
      .limit(limit),

    ShippingProfile.countDocuments(filter),
  ]);

  const profiles = await Promise.all(rows.map(serialize));

  return res.json({
    success: true,
    profiles,
    total,
    page,
    pages: Math.max(1, Math.ceil(total / limit)),
    limit,
  });
});

const getShippingProfile = guarded(async (req, res) => {
  const profile = await ShippingProfile.findById(
    id(req.params.id, "Shipping profile ID"),
  ).select(ShippingProfile.adminFields);

  if (!profile) {
    fail(404, "Shipping profile not found.");
  }

  return res.json({
    success: true,
    profile: await serialize(profile),
  });
});

const createShippingProfile = guarded(async (req, res) => {
  const data = normalize(req.body, false);

  const profile = new ShippingProfile({
    ...data,
    status: "draft",
  });

  await requireReferences(profile);
  await profile.save();

  return res.status(201).json({
    success: true,
    profile: await serialize(profile),
  });
});

const updateShippingProfile = guarded(async (req, res) => {
  const data = normalize(req.body, true);
  const profile = await load(req);

  for (const [key, value] of Object.entries(data)) {
    profile.set(key, value);
  }

  const changed = TERMS.some(
    (field) => profile.isModified(field),
  );

  if (changed) {
    profile.verification = {
      confirmedAt: null,
      confirmedBy: null,
      arrangementReference: "",
      validUntil: null,
    };

    if (data.status === "active") {
      fail(
        400,
        "Save changed shipping terms as paused or draft, then confirm them separately.",
      );
    }

    if (profile.status === "active") {
      profile.status = "paused";
    }

    await requireReferences(profile);
  }

  if (profile.status === "active") {
    const issues = await readiness(profile);

    if (issues.length) {
      fail(400, issues.join(" "));
    }
  }

  await profile.save();

  return res.json({
    success: true,
    profile: await serialize(profile),
    message: changed
      ? "Saved. Changed shipping terms require confirmation again."
      : "Shipping profile saved.",
  });
});

const confirmShippingProfile = guarded(async (req, res) => {
  object(
    req.body,
    ["version", "arrangementReference", "validUntil"],
    "shipping confirmation",
  );

  version(req.body);

  const profile = await load(req);

  if (!["draft", "paused"].includes(profile.status)) {
    fail(
      400,
      "Save this profile as draft or paused before confirming its terms.",
    );
  }

  const arrangementReference = text(
    req.body.arrangementReference,
    200,
    "Shipping agreement reference",
  );

  if (!arrangementReference) {
    fail(
      400,
      "Record a reference for the actual courier coverage and rate agreement.",
    );
  }

  if (
    typeof req.body.validUntil !== "string" ||
    !/(Z|[+-]\d{2}:\d{2})$/.test(req.body.validUntil)
  ) {
    fail(
      400,
      "Provide the agreement expiry as an ISO date and time with a timezone.",
    );
  }

  const validUntil = new Date(req.body.validUntil);

  if (
    !Number.isFinite(validUntil.getTime()) ||
    validUntil.getTime() <= Date.now()
  ) {
    fail(
      400,
      "The agreement expiry must be a valid future date.",
    );
  }

  const issues = await readiness(profile, false);

  if (issues.length) {
    fail(400, issues.join(" "));
  }

  profile.verification = {
    confirmedAt: new Date(),
    confirmedBy: req.user._id,
    arrangementReference,
    validUntil,
  };

  await profile.save();

  return res.json({
    success: true,
    profile: await serialize(profile),
    message:
      "Courier terms confirmed. Activate this profile separately. Parcel measurements and checkout coverage still require validation.",
  });
});

module.exports = {
  getShippingProfiles,
  getShippingProfile,
  createShippingProfile,
  updateShippingProfile,
  confirmShippingProfile,
};