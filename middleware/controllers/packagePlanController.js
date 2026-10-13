const mongoose = require("mongoose");

const PackagePlan = require("../../models/PackagePlan");
const Product = require("../../models/Product");
const Supplier = require("../../models/Supplier");
const PackingLocation = require("../../models/PackingLocation");

const {
  reference,
  dayRange,
  confirmedDate,
} = require("../../utils/kitDefinitions");

const {
  getVariantSku,
  getVariantStock,
} = require("../../utils/orderInventory");

const STATES = [
  "draft",
  "active",
  "paused",
  "archived",
];

const TERMS = [
  "name",
  "origin",
  "components",
  "parcels",
];

const DIMENSIONS = {
  weightGrams: 500000,
  lengthMm: 10000,
  widthMm: 10000,
  heightMm: 10000,
};

function fail(status, message) {
  throw Object.assign(
    new Error(message),
    { status }
  );
}

function object(value, keys, label) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    fail(400, `${label} must be an object.`);
  }

  if (
    Object.keys(value).some(
      (key) => !keys.includes(key)
    )
  ) {
    fail(
      400,
      `${label} contains an unsupported field.`
    );
  }
}

function text(value, maximum, label) {
  if (
    typeof value !== "string" ||
    value.trim().length > maximum
  ) {
    fail(
      400,
      `${label} must be text of at most ${maximum} characters.`
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

function key(value, label) {
  const result = text(value, 60, label);

  if (
    !/^[a-z][a-z0-9-]{0,59}$/.test(result)
  ) {
    fail(
      400,
      `${label} must start with a lowercase letter and use lowercase letters, digits or hyphens.`
    );
  }

  return result;
}

function whole(
  value,
  maximum,
  label,
  optional = false
) {
  if (optional && value == null) {
    return null;
  }

  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > maximum
  ) {
    fail(
      400,
      `${label} must be a whole number from 1 to ${maximum}.`
    );
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
      "Include the current package-plan version. Reload before saving."
    );
  }
}

function rows(value, maximum, label) {
  if (
    !Array.isArray(value) ||
    value.length > maximum
  ) {
    fail(
      400,
      `${label} must be an array with at most ${maximum} entries.`
    );
  }

  return value;
}

function normalize(body, updating) {
  object(
    body,
    [
      "version",
      "name",
      "status",
      "origin",
      "components",
      "parcels",
      "notes",
    ],
    "Package plan"
  );

  if (updating) {
    version(body);
  } else if (body.version !== undefined) {
    fail(
      400,
      "A new plan does not need a version."
    );
  }

  const result = {};

  for (const [field, maximum] of [
    ["name", 200],
    ["notes", 2000],
  ]) {
    if (body[field] !== undefined) {
      result[field] = text(
        body[field],
        maximum,
        field
      );
    }
  }

  if (
    (!updating || body.name !== undefined) &&
    (!result.name || result.name.length < 2)
  ) {
    fail(
      400,
      "Enter a plan name with at least two characters."
    );
  }

  if (body.status !== undefined) {
    if (!STATES.includes(body.status)) {
      fail(400, "Choose a valid plan status.");
    }

    result.status = body.status;
  }

  if (
    !updating &&
    result.status &&
    result.status !== "draft"
  ) {
    fail(
      400,
      "Create a draft and confirm measurements before activation."
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
      "Origin"
    );

    const kind = row.kind ?? "unconfigured";

    if (
      ![
        "unconfigured",
        "gymdrobe",
        "supplier",
        "packing-location",
      ].includes(kind)
    ) {
      fail(400, "Choose a valid origin type.");
    }

    result.origin = {
      kind,

      name: text(
        row.name ?? "",
        200,
        "Origin name"
      ),

      pickupPincode: text(
        row.pickupPincode ?? "",
        6,
        "Pickup pincode"
      ),

      packingLocation:
        row.packingLocation == null ||
        row.packingLocation === ""
          ? null
          : id(
              row.packingLocation,
              "Packing location ID"
            ),

      supplier:
        row.supplier == null ||
        row.supplier === ""
          ? null
          : id(
              row.supplier,
              "Supplier ID"
            ),
    };

    if (
      result.origin.pickupPincode &&
      !/^[1-9]\d{5}$/.test(
        result.origin.pickupPincode
      )
    ) {
      fail(
        400,
        "Enter a valid six-digit pickup pincode."
      );
    }
  }

  if (body.components !== undefined) {
    result.components = rows(
      body.components,
      50,
      "Components"
    ).map((row) => {
      object(
        row,
        [
          "key",
          "product",
          "selectedSize",
          "selectedColor",
          "quantity",
        ],
        "Component"
      );

      return {
        key: key(
          row.key,
          "Component key"
        ),

        product: id(
          row.product,
          "Product ID"
        ),

        selectedSize:
          row.selectedSize == null ||
          row.selectedSize === ""
            ? null
            : text(
                row.selectedSize,
                200,
                "Selected size"
              ),

        selectedColor:
          row.selectedColor == null ||
          row.selectedColor === ""
            ? null
            : text(
                row.selectedColor,
                200,
                "Selected colour"
              ),

        quantity: whole(
          row.quantity,
          999,
          "Component quantity"
        ),
      };
    });
  }

  if (body.parcels !== undefined) {
    result.parcels = rows(
      body.parcels,
      50,
      "Parcels"
    ).map((row) => {
      object(
        row,
        [
          "key",
          "label",
          ...Object.keys(DIMENSIONS),
          "contents",
        ],
        "Parcel"
      );

      return {
        key: key(
          row.key,
          "Parcel key"
        ),

        label: text(
          row.label ?? "",
          150,
          "Parcel label"
        ),

        ...Object.fromEntries(
          Object.entries(DIMENSIONS).map(
            ([field, maximum]) => [
              field,
              whole(
                row[field],
                maximum,
                field,
                true
              ),
            ]
          )
        ),

        contents: rows(
          row.contents ?? [],
          50,
          "Parcel contents"
        ).map((item) => {
          object(
            item,
            ["componentKey", "quantity"],
            "Parcel allocation"
          );

          return {
            componentKey: key(
              item.componentKey,
              "Component key"
            ),

            quantity: whole(
              item.quantity,
              999,
              "Allocated quantity"
            ),
          };
        }),
      };
    });
  }

  return result;
}

function stable(value) {
  return JSON.stringify(
    value,
    (name, child) => {
      if (
        child &&
        Object.getPrototypeOf(child) ===
          Object.prototype
      ) {
        return Object.fromEntries(
          Object.keys(child)
            .sort()
            .map((key) => [
              key,
              child[key],
            ])
        );
      }

      return child;
    }
  );
}

async function references(plan) {
  const ids = [
    ...new Set(
      (plan.components || [])
        .map((row) =>
          reference(row.product)
        )
        .filter(Boolean)
    ),
  ];

  const products = ids.length
    ? await Product.find({
        _id: { $in: ids },
      })
        .select("+supplier +fulfillment")
        .lean()
    : [];

  const supplierIds = [
    ...new Set(
      [
        ...products.map((row) =>
          reference(row.supplier)
        ),
        reference(plan.origin?.supplier),
      ].filter(Boolean)
    ),
  ];

  const [suppliers, location] =
    await Promise.all([
      supplierIds.length
        ? Supplier.find({
            _id: { $in: supplierIds },
          })
            .select(
              "+contact +verification +fulfillment"
            )
            .lean()
        : Promise.resolve([]),

      plan.origin?.packingLocation
        ? PackingLocation.findById(
            plan.origin.packingLocation
          )
            .select(
              "+address +contact +verification +packing +delivery +acceptsGymDrobeStock +supplierArrangements +gymdrobeStockTransfer"
            )
            .lean()
        : Promise.resolve(null),
    ]);

  return {
    products: new Map(
      products.map((row) => [
        reference(row._id),
        row,
      ])
    ),

    suppliers: new Map(
      suppliers.map((row) => [
        reference(row._id),
        row,
      ])
    ),

    location,
  };
}

async function requireReferences(plan) {
  const data = await references(plan);

  for (const row of plan.components || []) {
    const product = data.products.get(
      reference(row.product)
    );

    if (!product) {
      fail(
        400,
        "A selected product no longer exists. Reload the product list."
      );
    }

    try {
      getVariantSku(
        product,
        row.selectedSize,
        row.selectedColor
      );
    } catch (error) {
      fail(
        400,
        `${product.name}: ${error.message}`
      );
    }
  }

  if (
    plan.origin?.supplier &&
    !data.suppliers.has(
      reference(plan.origin.supplier)
    )
  ) {
    fail(
      400,
      "The selected supplier no longer exists."
    );
  }

  if (
    plan.origin?.packingLocation &&
    !data.location
  ) {
    fail(
      400,
      "The selected packing location no longer exists."
    );
  }
}

function supplierReady(supplier) {
  return (
    supplier?.status === "active" &&
    supplier.verification?.status ===
      "verified" &&
    confirmedDate(
      supplier.verification.verifiedAt
    ) &&
    reference(
      supplier.verification.verifiedBy
    ) &&
    (
      supplier.contact?.phone ||
      supplier.contact?.email ||
      supplier.contact?.whatsapp
    ) &&
    dayRange(
      supplier.fulfillment?.preparationDaysMin,
      supplier.fulfillment?.preparationDaysMax
    )
  );
}

function arrangementReady(row) {
  return (
    row?.status === "confirmed" &&
    confirmedDate(row.confirmedAt) &&
    reference(row.confirmedBy) &&
    row.arrangementReference?.trim() &&
    dayRange(
      row.transferDaysMin,
      row.transferDaysMax
    )
  );
}

async function readiness(
  plan,
  auditRequired = true
) {
  const issues = [];
  const origin = plan.origin || {};
  const components = plan.components || [];
  const parcels = plan.parcels || [];

  if (
    !components.length ||
    !parcels.length
  ) {
    issues.push(
      "Choose actual components and record at least one parcel."
    );
  }

  if (
    origin.kind === "unconfigured" ||
    !origin.name?.trim() ||
    !/^[1-9]\d{5}$/.test(
      origin.pickupPincode || ""
    )
  ) {
    issues.push(
      "Record the actual dispatch origin and pickup pincode."
    );
  }

  const allocated = new Map();

  for (const parcel of parcels) {
    if (!parcel.contents?.length) {
      issues.push(
        "Every parcel must contain selected components."
      );
    }

    if (
      Object.keys(DIMENSIONS).some(
        (field) =>
          !Number.isSafeInteger(
            parcel[field]
          ) ||
          parcel[field] < 1
      )
    ) {
      issues.push(
        "Record the actual packed weight and all three dimensions for every parcel."
      );
    }

    for (const row of parcel.contents || []) {
      allocated.set(
        row.componentKey,
        (
          allocated.get(row.componentKey) ||
          0
        ) + row.quantity
      );
    }
  }

  if (
    components.some(
      (row) =>
        allocated.get(row.key) !==
        row.quantity
    )
  ) {
    issues.push(
      "Allocate every selected unit exactly once across the parcels."
    );
  }

  const audit = plan.verification;

  const expiry = new Date(
    audit?.validUntil ?? ""
  ).getTime();

  if (
    auditRequired &&
    (
      !confirmedDate(audit?.confirmedAt) ||
      !reference(audit?.confirmedBy) ||
      !audit?.measurementReference?.trim() ||
      !Number.isFinite(expiry) ||
      expiry <= Date.now() ||
      expiry <=
        new Date(
          audit.confirmedAt
        ).getTime()
    )
  ) {
    issues.push(
      "Confirm the measurements with a reference and future review expiry."
    );
  }

  const {
    products,
    suppliers,
    location,
  } = await references(plan);

  if (origin.kind === "supplier") {
    const supplier = suppliers.get(
      reference(origin.supplier)
    );

    if (
      !supplierReady(supplier) ||
      supplier.fulfillment?.dispatchToCustomer
        !== true
    ) {
      issues.push(
        "The supplier must be active, verified and configured for direct dispatch."
      );
    }
  }

  if (origin.kind === "packing-location") {
    if (
      !location ||
      location.status !== "active" ||
      !confirmedDate(
        location.verification?.confirmedAt
      ) ||
      !reference(
        location.verification?.confirmedBy
      ) ||
      !location.verification?.arrangementReference ||
      !location.address?.addressLine ||
      !location.address?.city ||
      !location.address?.state ||
      !location.contact?.name ||
      !(
        location.contact.phone ||
        location.contact.email
      ) ||
      !dayRange(
        location.packing?.packingDaysMin,
        location.packing?.packingDaysMax
      ) ||
      !dayRange(
        location.delivery?.transitDaysMin,
        location.delivery?.transitDaysMax
      )
    ) {
      issues.push(
        "Use an active packing location with a confirmed operating arrangement."
      );
    }

    if (
      !location ||
      location.address?.pincode !==
        origin.pickupPincode
    ) {
      issues.push(
        "The pickup pincode must match the saved packing location."
      );
    }
  }

  for (const row of components) {
    const product = products.get(
      reference(row.product)
    );

    if (!product) {
      issues.push(
        `Component ${row.key}: the product no longer exists.`
      );

      continue;
    }

    const name = product.name || row.key;
    const setup = product.fulfillment || {};

    try {
      getVariantSku(
        product,
        row.selectedSize,
        row.selectedColor
      );
    } catch (error) {
      issues.push(
        `${name}: ${error.message}`
      );
    }

    if (
      product.isActive !== true ||
      product.delivery?.available !== true
    ) {
      issues.push(
        `${name}: the product is unavailable for delivery.`
      );
    }

    if (
      getVariantStock(
        product,
        row.selectedSize,
        row.selectedColor
      ) < row.quantity
    ) {
      issues.push(
        `${name}: the selected quantity exceeds current variant stock.`
      );
    }

    if (
      !dayRange(
        setup.preparationDaysMin,
        setup.preparationDaysMax
      )
    ) {
      issues.push(
        `${name}: record preparation times.`
      );
    }

    if (
      ![
        "gymdrobe",
        "supplier",
        "fulfillment-partner",
      ].includes(setup.dispatchBy)
    ) {
      issues.push(
        `${name}: record who dispatches this product.`
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
        `${name}: configure GymDrobe-held stock and direct dispatch.`
      );
    }

    if (
      origin.kind === "supplier" &&
      (
        reference(product.supplier) !==
          reference(origin.supplier) ||
        setup.stockSource !== "supplier" ||
        setup.dispatchBy !== "supplier" ||
        !confirmedDate(
          setup.supplierStockConfirmedAt
        )
      )
    ) {
      issues.push(
        `${name}: configure stock and direct dispatch for the selected supplier.`
      );
    }

    if (
      origin.kind === "packing-location"
    ) {
      if (
        setup.canSendToPackingLocation !== true
      ) {
        issues.push(
          `${name}: enable packing-location transfers.`
        );
      }

      if (
        setup.stockSource === "supplier"
      ) {
        const supplier = suppliers.get(
          reference(product.supplier)
        );

        const route =
          location?.supplierArrangements?.find(
            (item) =>
              reference(item.supplier) ===
              reference(product.supplier)
          );

        if (
          !supplierReady(supplier) ||
          supplier.fulfillment?.sendToPackingLocation
            !== true ||
          !confirmedDate(
            setup.supplierStockConfirmedAt
          ) ||
          !arrangementReady(route)
        ) {
          issues.push(
            `${name}: confirm this supplier's stock and transfer arrangement.`
          );
        }
      } else if (
        setup.stockSource === "gymdrobe"
      ) {
        const route =
          location?.gymdrobeStockTransfer;

        const contact = route?.originContact;

        const covered =
          Array.isArray(route?.productIds)
            ? route.productIds.map(reference)
            : [];

        const validScope =
          covered.length > 0 &&
          covered.length <= 500 &&
          covered.every(Boolean) &&
          new Set(covered).size ===
            covered.length;

        const validContact =
          /^\d{7,15}$/.test(
            contact?.phone || ""
          ) ||
          /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(
            contact?.email || ""
          );

        if (
          location?.acceptsGymDrobeStock !== true ||
          !arrangementReady(route) ||
          !route?.originName?.trim() ||
          !route.originAddress?.addressLine ||
          !route.originAddress?.city ||
          !route.originAddress?.state ||
          !/^[1-9]\d{5}$/.test(
            route.originAddress?.pincode || ""
          ) ||
          !contact?.name ||
          !validContact ||
          !validScope ||
          !covered.includes(
            reference(row.product)
          )
        ) {
          issues.push(
            `${name}: confirm the GymDrobe-stock transfer route covering this product.`
          );
        }
      } else {
        issues.push(
          `${name}: record who holds the stock.`
        );
      }
    }
  }

  return [...new Set(issues)];
}

async function serialize(plan) {
  const result = plan.toObject({
    transform: false,
  });

  result.id = String(result._id);
  result.version = result.__v ?? 0;

  delete result.__v;

  result.readinessIssues =
    await readiness(plan);

  result.ready =
    plan.status === "active" &&
    result.readinessIssues.length === 0;

  result.packageCount =
    plan.parcels.length;

  result.purchaseEnabled = false;

  return result;
}

async function load(req) {
  const plan = await PackagePlan.findById(
    id(req.params.id, "Package plan ID")
  ).select(PackagePlan.adminFields);

  if (!plan) {
    fail(404, "Package plan not found.");
  }

  if (
    (plan.__v ?? 0) !== req.body.version
  ) {
    fail(
      409,
      "This plan changed. Reload before saving again."
    );
  }

  return plan;
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
        message:
          "An active admin account is required.",
      });
    }

    try {
      return await handler(req, res);
    } catch (error) {
      let status = error.status || 503;
      let message = error.message;

      if (
        error.name === "ValidationError"
      ) {
        status = 400;

        message = Object.values(
          error.errors
        )
          .map((row) => row.message)
          .join(" ");
      } else if (
        error.name === "VersionError" ||
        error.code === 11000
      ) {
        status = 409;

        message =
          "This plan changed. Reload before saving again.";
      } else if (!error.status) {
        console.error(
          "Package administration failed:",
          error.name || "Error"
        );

        message =
          "Package administration is temporarily unavailable. Reload to check the result before retrying a save.";
      }

      return res.status(status).json({
        success: false,
        message,
      });
    }
  };
}

const getPackagePlans = guarded(
  async (req, res) => {
    const page = Number(
      req.query.page ?? 1
    );

    const limit = Number(
      req.query.limit ?? 12
    );

    if (
      !Number.isSafeInteger(page) ||
      page < 1 ||
      page > 100000 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100
    ) {
      fail(
        400,
        "Use a valid page and a limit from 1 to 100."
      );
    }

    const filter = {};

    if (req.query.status) {
      if (
        !STATES.includes(req.query.status)
      ) {
        fail(
          400,
          "Choose a valid status filter."
        );
      }

      filter.status = req.query.status;
    }

    if (req.query.search) {
      filter.name = {
        $regex: text(
          req.query.search,
          100,
          "Search"
        ).replace(
          /[.*+?^${}()|[\]\\]/g,
          "\\$&"
        ),

        $options: "i",
      };
    }

    const [plans, total] =
      await Promise.all([
        PackagePlan.find(filter)
          .select(PackagePlan.adminFields)
          .sort({ name: 1, _id: 1 })
          .skip((page - 1) * limit)
          .limit(limit),

        PackagePlan.countDocuments(filter),
      ]);

    return res.json({
      success: true,

      plans: await Promise.all(
        plans.map(serialize)
      ),

      total,
      page,

      pages: Math.max(
        1,
        Math.ceil(total / limit)
      ),

      limit,
    });
  }
);

const getPackagePlan = guarded(
  async (req, res) => {
    const plan = await PackagePlan.findById(
      id(req.params.id, "Package plan ID")
    ).select(PackagePlan.adminFields);

    if (!plan) {
      fail(404, "Package plan not found.");
    }

    return res.json({
      success: true,
      plan: await serialize(plan),
    });
  }
);

const createPackagePlan = guarded(
  async (req, res) => {
    const plan = new PackagePlan({
      ...normalize(req.body, false),
      status: "draft",
    });

    await requireReferences(plan);
    await plan.save();

    return res.status(201).json({
      success: true,
      plan: await serialize(plan),
    });
  }
);

const updatePackagePlan = guarded(
  async (req, res) => {
    const data = normalize(
      req.body,
      true
    );

    const plan = await load(req);

    const before = plan.toObject({
      transform: false,
    });

    for (
      const [field, value]
      of Object.entries(data)
    ) {
      if (
        stable(before[field]) !==
        stable(value)
      ) {
        plan.set(field, value);
      }
    }

    const after = plan.toObject({
      transform: false,
    });

    const changed = TERMS.some(
      (field) =>
        stable(before[field]) !==
        stable(after[field])
    );

    if (changed) {
      plan.verification = {
        confirmedAt: null,
        confirmedBy: null,
        measurementReference: "",
        validUntil: null,
      };

      if (data.status === "active") {
        fail(
          400,
          "Save changed contents or measurements as paused or draft, then confirm them separately."
        );
      }

      if (plan.status === "active") {
        plan.status = "paused";
      }

      await requireReferences(plan);
    }

    if (plan.status === "active") {
      const issues = await readiness(plan);

      if (issues.length) {
        fail(400, issues.join(" "));
      }
    }

    await plan.save();

    return res.json({
      success: true,
      plan: await serialize(plan),

      message: changed
        ? "Saved. Changed packing details need measurement confirmation again."
        : "Package plan saved.",
    });
  }
);

const confirmPackagePlan = guarded(
  async (req, res) => {
    object(
      req.body,
      [
        "version",
        "measurementReference",
        "validUntil",
      ],
      "Measurement confirmation"
    );

    version(req.body);

    const plan = await load(req);

    if (
      !["draft", "paused"].includes(
        plan.status
      )
    ) {
      fail(
        400,
        "Save this plan as draft or paused before confirming measurements."
      );
    }

    const measurementReference = text(
      req.body.measurementReference,
      200,
      "Measurement reference"
    );

    if (!measurementReference) {
      fail(
        400,
        "Record a reference for the actual packed measurements."
      );
    }

    if (
      typeof req.body.validUntil !==
        "string" ||
      !/(Z|[+-]\d{2}:\d{2})$/.test(
        req.body.validUntil
      )
    ) {
      fail(
        400,
        "Provide the review expiry as an ISO date and time with a timezone."
      );
    }

    const validUntil = new Date(
      req.body.validUntil
    );

    if (
      !Number.isFinite(
        validUntil.getTime()
      ) ||
      validUntil.getTime() <= Date.now()
    ) {
      fail(
        400,
        "The review expiry must be a valid future date."
      );
    }

    await plan.validate();

    const issues = await readiness(
      plan,
      false
    );

    if (issues.length) {
      fail(400, issues.join(" "));
    }

    plan.verification = {
      confirmedAt: new Date(),
      confirmedBy: req.user._id,
      measurementReference,
      validUntil,
    };

    await plan.save();

    return res.json({
      success: true,
      plan: await serialize(plan),

      message:
        "Measurements confirmed. Activate separately. Checkout shipping validation is still required.",
    });
  }
);

module.exports = {
  getPackagePlans,
  getPackagePlan,
  createPackagePlan,
  updatePackagePlan,
  confirmPackagePlan,
};