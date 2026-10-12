"use strict";

const {
  getVariantStock,
} = require("./orderInventory");

const {
  KIT_ROLES,
  reference,
  dayRange,
  confirmedDate,
  kitStructureIssues,
} = require("./kitDefinitions");

function kitPublicationIssues(
  kit,
  products = [],
  suppliers = [],
  location = null,
  now = Date.now(),
) {
  const issues = kitStructureIssues(kit);

  const productMap = new Map(
    products.map((product) => [
      reference(product._id),
      product,
    ]),
  );

  const supplierMap = new Map(
    suppliers.map((supplier) => [
      reference(supplier._id),
      supplier,
    ]),
  );

  const mode = kit.fulfillment?.mode;

  if (
    !kit.name?.trim() ||
    !kit.audience?.trim() ||
    !kit.explanation?.trim()
  ) {
    issues.push(
      "Record the kit name, intended customer and explanation before publishing.",
    );
  }

  if (
    ![
      "packed-together",
      "separate-shipments",
    ].includes(mode)
  ) {
    issues.push(
      "Configure a real kit fulfillment mode before publishing.",
    );
  }

  if (
    !kit.fulfillment?.customerNote?.trim()
  ) {
    issues.push(
      "Explain preparation and delivery arrangements for customers.",
    );
  }

  if (mode === "packed-together") {
    if (
      !location ||
      reference(location._id) !==
        reference(
          kit.fulfillment.packingLocation,
        ) ||
      location.status !== "active" ||
      !confirmedDate(
        location.verification?.confirmedAt,
        now,
      ) ||
      !reference(
        location.verification?.confirmedBy,
      ) ||
      !location.verification?.arrangementReference ||
      !location.address?.addressLine ||
      !location.address?.city ||
      !location.address?.state ||
      !/^[1-9]\d{5}$/.test(
        location.address?.pincode || "",
      ) ||
      !location.contact?.name ||
      !(
        location.contact.phone ||
        location.contact.email
      ) ||
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
        "Select an active, confirmed packing location with contact, preparation and transit details.",
      );
    }
  }

  const slots = Array.isArray(kit.slots)
    ? kit.slots
    : [];

  for (const role of KIT_ROLES) {
    if (
      !slots.some(
        (row) => row.role === role,
      )
    ) {
      issues.push(
        `Add a ${role} section; supplements can remain unselected.`,
      );
    }

    if (
      role !== "supplements" &&
      !slots.some(
        (row) =>
          row.role === role &&
          row.defaultIncluded &&
          row.defaultProduct,
      )
    ) {
      issues.push(
        `Choose a suggested default product for ${role}. Customers can skip it later.`,
      );
    }
  }

  const pools = new Map();
  let subtotal = 0;

  for (const slot of slots) {
    if (!slot.defaultIncluded) {
      continue;
    }

    const name = slot.label || slot.key;

    if (!slot.whySelected?.trim()) {
      issues.push(
        `${name}: explain why this default product was selected.`,
      );
    }

    const product = productMap.get(
      reference(slot.defaultProduct),
    );

    if (
      !product ||
      product.isActive !== true ||
      product.delivery?.available !== true ||
      product.kitSettings?.eligible !== true ||
      !product.kitSettings?.roles?.includes(
        slot.role,
      )
    ) {
      issues.push(
        `${name}: choose an active, deliverable product eligible for this kit category.`,
      );
      continue;
    }

    if (
      typeof product.price !== "number" ||
      !Number.isFinite(product.price) ||
      product.price < 0 ||
      typeof product.discount !== "number" ||
      !Number.isFinite(product.discount) ||
      product.discount < 0 ||
      product.discount > 100
    ) {
      issues.push(
        `${name}: the current product price or discount is invalid.`,
      );
      continue;
    }

    const stock = getVariantStock(
      product,
      slot.defaultSize ?? null,
      slot.defaultColor ?? null,
    );

    const pool = JSON.stringify([
      reference(product._id),
      slot.defaultSize ?? null,
      slot.defaultColor ?? null,
    ]);

    const quantity =
      (pools.get(pool) || 0) +
      slot.defaultQuantity;

    pools.set(pool, quantity);

    if (
      !Number.isSafeInteger(quantity) ||
      quantity > stock
    ) {
      issues.push(
        `${name}: the default options have missing, invalid or insufficient shared stock.`,
      );
    }

    subtotal +=
      Math.round(
        Math.round(product.price) *
          (1 - product.discount / 100),
      ) * slot.defaultQuantity;

    const setup =
      product.fulfillment || {};

    if (
      ![
        "gymdrobe",
        "supplier",
      ].includes(setup.stockSource) ||
      ![
        "gymdrobe",
        "supplier",
        "fulfillment-partner",
      ].includes(setup.dispatchBy) ||
      !dayRange(
        setup.preparationDaysMin,
        setup.preparationDaysMax,
      )
    ) {
      issues.push(
        `${name}: record stock ownership, dispatcher and preparation times.`,
      );
    }

    let supplier;

    if (product.supplier) {
      supplier = supplierMap.get(
        reference(product.supplier),
      );

      if (
        !supplier ||
        supplier.status !== "active" ||
        supplier.verification?.status !==
          "verified" ||
        !confirmedDate(
          supplier.verification?.verifiedAt,
          now,
        ) ||
        !reference(
          supplier.verification?.verifiedBy,
        ) ||
        !(
          supplier.contact?.phone ||
          supplier.contact?.whatsapp ||
          supplier.contact?.email
        )
      ) {
        issues.push(
          `${name}: its supplier is unavailable or lacks recorded verification and contact details.`,
        );
      }
    }

    if (
      setup.stockSource === "supplier" &&
      (
        !supplier ||
        !confirmedDate(
          setup.supplierStockConfirmedAt,
          now,
        )
      )
    ) {
      issues.push(
        `${name}: confirm actual supplier stock before publishing.`,
      );
    }

    if (mode === "packed-together") {
      if (
        setup.stockSource === "gymdrobe" &&
        !location?.acceptsGymDrobeStock
      ) {
        issues.push(
          `${name}: confirm the packing location can receive GymDrobe-held stock.`,
        );
      }

      if (
        setup.stockSource === "supplier"
      ) {
        const arrangement =
          location?.supplierArrangements?.find(
            (row) =>
              reference(row.supplier) ===
              reference(product.supplier),
          );

        if (
          !setup.canSendToPackingLocation ||
          supplier?.fulfillment?.sendToPackingLocation !==
            true ||
          !arrangement ||
          arrangement.status !== "confirmed" ||
          !confirmedDate(
            arrangement.confirmedAt,
            now,
          ) ||
          !reference(
            arrangement.confirmedBy,
          ) ||
          !arrangement.arrangementReference ||
          !dayRange(
            arrangement.transferDaysMin,
            arrangement.transferDaysMax,
          )
        ) {
          issues.push(
            `${name}: confirm this supplier's arrangement and transfer times for the selected packing location.`,
          );
        }
      }
    } else if (
      mode === "separate-shipments"
    ) {
      if (
        !dayRange(
          product.delivery?.transitDaysMin,
          product.delivery?.transitDaysMax,
        )
      ) {
        issues.push(
          `${name}: record its courier transit estimates for separate delivery.`,
        );
      }

      if (
        setup.dispatchBy === "supplier" &&
        supplier?.fulfillment?.dispatchToCustomer !==
          true
      ) {
        issues.push(
          `${name}: the supplier has not confirmed direct customer fulfillment.`,
        );
      }

      if (
        setup.stockSource === "supplier" &&
        setup.dispatchBy !== "supplier"
      ) {
        issues.push(
          `${name}: separate delivery requires a configured direct supplier dispatcher; use a confirmed packing arrangement for this product instead.`,
        );
      }

      if (
        setup.dispatchBy ===
        "fulfillment-partner"
      ) {
        issues.push(
          `${name}: this partner's separate-dispatch arrangement requires configuration before this kit can be published.`,
        );
      }
    }
  }

  if (
    !Number.isSafeInteger(
      subtotal * 100,
    ) ||
    subtotal <= 0
  ) {
    issues.push(
      "The suggested kit must have a valid positive product subtotal.",
    );
  }

  return [...new Set(issues)];
}

module.exports = {
  kitPublicationIssues,
};