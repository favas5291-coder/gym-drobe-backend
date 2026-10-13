"use strict";

const {
  reference,
  dayRange,
  confirmedDate,
} = require("./kitDefinitions");

function hasText(value) {
  return typeof value === "string" && Boolean(value.trim());
}

function gymDrobeTransfer(location, product, setup, now) {
  const issues = [];
  const arrangement = location?.gymdrobeStockTransfer;

  if (location?.acceptsGymDrobeStock !== true) {
    issues.push(
      "Confirm that this packing location accepts GymDrobe-held stock.",
    );
  }

  if (setup.canSendToPackingLocation !== true) {
    issues.push(
      "Enable packing-location transfers for this product.",
    );
  }

  if (
    !arrangement ||
    arrangement.status !== "confirmed" ||
    !confirmedDate(arrangement.confirmedAt, now) ||
    !reference(arrangement.confirmedBy) ||
    typeof arrangement.arrangementReference !== "string" ||
    !arrangement.arrangementReference.trim()
  ) {
    issues.push(
      "Confirm the real GymDrobe-stock transfer arrangement for this packing location.",
    );
  }

  if (
    !arrangement ||
    typeof arrangement.originName !== "string" ||
    arrangement.originName.trim().length < 2 ||
    !hasText(arrangement.originAddress?.addressLine) ||
    !hasText(arrangement.originAddress?.city) ||
    !hasText(arrangement.originAddress?.state) ||
    !/^[1-9]\d{5}$/.test(
      arrangement.originAddress?.pincode || "",
    )
  ) {
    issues.push(
      "Record the real stock origin and complete pickup address for this transfer.",
    );
  }

  const contact = arrangement?.originContact;

  const phoneValid =
    typeof contact?.phone === "string" &&
    /^\d{7,15}$/.test(contact.phone);

  const emailValid =
    typeof contact?.email === "string" &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact.email);

  if (
    !hasText(contact?.name) ||
    (!phoneValid && !emailValid)
  ) {
    issues.push(
      "Record a named stock-origin contact and valid phone or email.",
    );
  }

  const ids = Array.isArray(arrangement?.productIds)
    ? arrangement.productIds.map(reference)
    : [];

  const selectedId = reference(product?._id || product?.id);

  if (
    !ids.length ||
    ids.length > 500 ||
    ids.some((id) => !id) ||
    new Set(ids).size !== ids.length ||
    !selectedId ||
    !ids.includes(selectedId)
  ) {
    issues.push(
      "This product is not covered by a valid, explicitly configured GymDrobe-stock transfer route.",
    );
  }

  if (
    !dayRange(
      arrangement?.transferDaysMin,
      arrangement?.transferDaysMax,
    )
  ) {
    issues.push(
      "Record both GymDrobe-stock transfer estimates before promising complete preparation times.",
    );
  }

  return {
    issues,
    transfer: issues.length
      ? null
      : {
          minimum: arrangement.transferDaysMin,
          maximum: arrangement.transferDaysMax,
        },
  };
}

// Read-only inspection of server-loaded configuration.
// This does not reserve stock, confirm destination coverage,
// consolidate parcels or determine final shipping charges.
function inspectCheckoutFulfillment({
  items = [],
  kitSnapshots = [],
  kits = [],
  products = [],
  suppliers = [],
  locations = [],
  now = Date.now(),
} = {}) {
  const productMap = new Map(
    products.map((value) => [
      reference(value._id || value.id),
      value,
    ]),
  );

  const supplierMap = new Map(
    suppliers.map((value) => [
      reference(value._id || value.id),
      value,
    ]),
  );

  const kitMap = new Map(
    kits.map((value) => [
      reference(value._id || value.id),
      value,
    ]),
  );

  const locationMap = new Map(
    locations.map((value) => [
      reference(value._id || value.id),
      value,
    ]),
  );

  const groups = new Map();
  const reasons = [];

  if (!Array.isArray(items) || !items.length) {
    reasons.push(
      "No purchased components were available to inspect.",
    );
  }

  for (
    const [index, item] of
    (Array.isArray(items) ? items : []).entries()
  ) {
    const key = item.kit
      ? `kit:${item.kit.groupId}`
      : `item:${index}`;

    if (!groups.has(key)) {
      groups.set(key, {
        id: item.kit?.groupId || null,
        items: [],
      });
    }

    groups.get(key).items.push(item);
  }

  const results = [];

  for (const group of groups.values()) {
    const first = group.items[0];

    const snapshot = kitSnapshots.find(
      (value) => value.groupId === group.id,
    );

    const kit = first.kit
      ? kitMap.get(reference(snapshot?.template))
      : null;

    const mode = first.kit
      ? kit?.fulfillment?.mode
      : "separate-shipments";

    const location = mode === "packed-together"
      ? locationMap.get(
          reference(kit?.fulfillment?.packingLocation),
        )
      : null;

    const issues = [];

    if (
      first.kit &&
      (!kit || kit.status !== "published")
    ) {
      issues.push("The kit template is unavailable.");
    }

    if (
      !["packed-together", "separate-shipments"].includes(mode)
    ) {
      issues.push("The fulfillment mode is not configured.");
    }

    if (mode === "packed-together") {
      if (
        !location ||
        location.status !== "active" ||
        !confirmedDate(
          location.verification?.confirmedAt,
          now,
        ) ||
        !reference(location.verification?.confirmedBy) ||
        !String(
          location.verification?.arrangementReference || "",
        ).trim() ||
        !location.address?.addressLine ||
        !location.address?.city ||
        !location.address?.state ||
        !/^[1-9]\d{5}$/.test(
          location.address?.pincode || "",
        ) ||
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
          "The selected packing location needs active status, a confirmed arrangement, address, contact, packing times and courier transit estimates.",
        );
      }
    }

    const components = group.items.map((item) => {
      const product = productMap.get(reference(item.product));
      const name = item.name || product?.name || "Product";
      const missing = [];
      const setup = product?.fulfillment || {};

      const supplier = supplierMap.get(
        reference(product?.supplier),
      );

      if (
        !product ||
        product.isActive !== true ||
        product.delivery?.available !== true
      ) {
        missing.push(
          "The product is not available for delivery.",
        );
      }

      if (
        !["gymdrobe", "supplier"].includes(setup.stockSource)
      ) {
        missing.push(
          "Record who holds this product's stock.",
        );
      }

      if (
        ![
          "gymdrobe",
          "supplier",
          "fulfillment-partner",
        ].includes(setup.dispatchBy)
      ) {
        missing.push("Record who dispatches this product.");
      }

      if (
        !dayRange(
          setup.preparationDaysMin,
          setup.preparationDaysMax,
        )
      ) {
        missing.push("Record product preparation times.");
      }

      if (
        product?.supplier ||
        setup.stockSource === "supplier" ||
        setup.dispatchBy === "supplier"
      ) {
        if (
          !supplier ||
          supplier.status !== "active" ||
          supplier.verification?.status !== "verified" ||
          !confirmedDate(
            supplier.verification?.verifiedAt,
            now,
          ) ||
          !reference(supplier.verification?.verifiedBy) ||
          !(
            supplier.contact?.phone ||
            supplier.contact?.whatsapp ||
            supplier.contact?.email
          ) ||
          !dayRange(
            supplier.fulfillment?.preparationDaysMin,
            supplier.fulfillment?.preparationDaysMax,
          )
        ) {
          missing.push(
            "The supplier needs an active, verified record, contact method and preparation times.",
          );
        }
      }

      if (
        setup.stockSource === "supplier" &&
        !confirmedDate(setup.supplierStockConfirmedAt, now)
      ) {
        missing.push("Record confirmation of supplier stock.");
      }

      let transfer = null;

      if (mode === "packed-together") {
        if (setup.stockSource === "gymdrobe") {
          const route = gymDrobeTransfer(
            location,
            product,
            setup,
            now,
          );

          missing.push(...route.issues);
          transfer = route.transfer;
        }

        if (setup.stockSource === "supplier") {
          const arrangement =
            location?.supplierArrangements?.find(
              (value) =>
                reference(value.supplier) ===
                reference(product?.supplier),
            );

          if (
            setup.canSendToPackingLocation !== true ||
            supplier?.fulfillment?.sendToPackingLocation !== true ||
            !arrangement ||
            arrangement.status !== "confirmed" ||
            !confirmedDate(arrangement.confirmedAt, now) ||
            !reference(arrangement.confirmedBy) ||
            !String(
              arrangement.arrangementReference || "",
            ).trim() ||
            !dayRange(
              arrangement.transferDaysMin,
              arrangement.transferDaysMax,
            )
          ) {
            missing.push(
              "Confirm the supplier's transfer arrangement and transfer times for this packing location.",
            );
          } else {
            transfer = {
              minimum: arrangement.transferDaysMin,
              maximum: arrangement.transferDaysMax,
            };
          }
        }
      } else if (mode === "separate-shipments") {
        if (
          !dayRange(
            product?.delivery?.transitDaysMin,
            product?.delivery?.transitDaysMax,
          )
        ) {
          missing.push(
            "Record courier transit estimates for this component.",
          );
        }

        if (
          setup.stockSource === "supplier" &&
          setup.dispatchBy !== "supplier"
        ) {
          missing.push(
            "Confirm direct supplier dispatch or use a packing arrangement.",
          );
        }

        if (
          setup.dispatchBy === "supplier" &&
          supplier?.fulfillment?.dispatchToCustomer !== true
        ) {
          missing.push(
            "Confirm direct customer dispatch with this supplier.",
          );
        }

        if (setup.dispatchBy === "fulfillment-partner") {
          missing.push(
            "Configure the partner's direct-dispatch arrangement.",
          );
        }
      }

      const preparation = dayRange(
        setup.preparationDaysMin,
        setup.preparationDaysMax,
      )
        ? {
            minimum: Math.max(
              setup.preparationDaysMin,
              setup.stockSource === "supplier" &&
              dayRange(
                supplier?.fulfillment?.preparationDaysMin,
                supplier?.fulfillment?.preparationDaysMax,
              )
                ? supplier.fulfillment.preparationDaysMin
                : 0,
            ),
            maximum: Math.max(
              setup.preparationDaysMax,
              setup.stockSource === "supplier" &&
              dayRange(
                supplier?.fulfillment?.preparationDaysMin,
                supplier?.fulfillment?.preparationDaysMax,
              )
                ? supplier.fulfillment.preparationDaysMax
                : 0,
            ),
          }
        : null;

      const transit =
        mode === "separate-shipments" &&
        dayRange(
          product?.delivery?.transitDaysMin,
          product?.delivery?.transitDaysMax,
        )
          ? {
              minimum: product.delivery.transitDaysMin,
              maximum: product.delivery.transitDaysMax,
            }
          : null;

      const ready = missing.length === 0;

      for (const message of missing) {
        issues.push(`${name}: ${message}`);
      }

      return {
        productId: reference(item.product),
        slotKey: item.kit?.slotKey || null,
        name,
        quantity: item.quantity,
        selectedSize: item.selectedSize ?? null,
        selectedColor: item.selectedColor ?? null,
        configurationReady: ready,
        issues: [...new Set(missing)],
        preparationDays: preparation,
        transferDays: transfer,
        transitDays: transit,

        estimatedDays:
          ready &&
          mode === "separate-shipments" &&
          preparation &&
          transit
            ? {
                minimum:
                  preparation.minimum + transit.minimum,
                maximum:
                  preparation.maximum + transit.maximum,
              }
            : null,
      };
    });

    const ready = issues.length === 0;
    let estimates = null;

    if (ready && mode === "packed-together") {
      // Components are collected concurrently.
      // Packing starts after the latest component arrival.
      const low = Math.max(
        ...components.map(
          (value) =>
            value.preparationDays.minimum +
            value.transferDays.minimum,
        ),
      );

      const high = Math.max(
        ...components.map(
          (value) =>
            value.preparationDays.maximum +
            value.transferDays.maximum,
        ),
      );

      const preparation = {
        minimum: low + location.packing.packingDaysMin,
        maximum: high + location.packing.packingDaysMax,
      };

      estimates = {
        preparationDays: preparation,
        transitDays: {
          minimum: location.delivery.transitDaysMin,
          maximum: location.delivery.transitDaysMax,
        },
        totalDays: {
          minimum:
            preparation.minimum +
            location.delivery.transitDaysMin,
          maximum:
            preparation.maximum +
            location.delivery.transitDaysMax,
        },
      };
    }

    const unique = [...new Set(issues)];
    reasons.push(...unique);

    results.push({
      groupId: first.kit ? group.id : null,
      name: kit?.name || first.name || "Individual product",
      mode: mode || "unconfigured",
      configurationReady: ready,
      issues: unique,
      components,
      estimates,
      packageCountConfirmed: false,
      packageCount: null,

      packagePlan:
        mode === "packed-together"
          ? "One kit package is intended after all components reach the confirmed packing location. Actual readiness and dispatch must be recorded."
          : mode === "separate-shipments"
            ? "Components may arrive separately. Exact package contents and package count must be confirmed before payment."
            : "Configure fulfillment and the package plan before payment.",
    });
  }

  return {
    configurationReady:
      results.length > 0 && reasons.length === 0,

    purchaseEnabled: false,
    inventoryReserved: false,
    deliveryCoverageConfirmed: false,
    finalShippingConfirmed: false,
    packageCountConfirmed: false,
    packageCount: null,
    groups: results,

    issues: [
      ...new Set([
        ...reasons,
        "Confirm delivery coverage for the customer's pincode.",
        "Confirm package contents, package count and final shipping charges before payment.",
      ]),
    ],

    notice:
      "Recorded fulfillment configuration only. Supplier verification does not prove product authenticity. Software does not physically consolidate parcels.",
  };
}

module.exports = {
  inspectCheckoutFulfillment,
};