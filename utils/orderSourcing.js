const mongoose = require("mongoose");

const Product = require("../models/Product");
const Order = require("../models/Order");

const { safeMeeshoLink } = require("./meeshoUrl");

const SIZE_LABELS = [
  "Size",
  "Pack size",
  "Capacity",
  "Weight",
  "Length",
  "Option",
];

const COLOR_LABELS = [
  "Colour",
  "Flavour",
  "Style",
  "Material",
  "Option",
];

// Called with the product loaded from the database.
// Never pass customer-submitted sourcing information here.
function snapshotProductSourcing(product) {
  return {
    meeshoProductLink: safeMeeshoLink(
      product?.meeshoProductLink
    ),

    sizeLabel: SIZE_LABELS.includes(
      product?.optionLabels?.size
    )
      ? product.optionLabels.size
      : "Size",

    colorLabel: COLOR_LABELS.includes(
      product?.optionLabels?.color
    )
      ? product.optionLabels.color
      : "Colour",
  };
}

// Add private sourcing information only to an admin response.
async function withAdminSourcing(order, response, user) {
  if (
    !user ||
    user.role !== "admin" ||
    user.isActive === false
  ) {
    throw Object.assign(
      new Error("Administrator access is required."),
      { status: 403 }
    );
  }

  let raw =
    typeof order.toObject === "function"
      ? order.toObject({ transform: false })
      : order;

  // Status updates may return an order without private fields.
  // Reload those fields only after checking admin access.
  if (
    typeof order.isSelected === "function" &&
    !order.isSelected("items.sourcing")
  ) {
    raw = await Order.findById(order._id)
      .select("items.product +items.sourcing")
      .lean();

    if (!raw) {
      throw Object.assign(
        new Error("Order not found."),
        { status: 404 }
      );
    }
  }

  const items = raw.items || [];

  // Only older items without a snapshot use the current product.
  // An explicitly empty snapshot must remain empty.
  const ids = [
    ...new Set(
      items
        .filter((item) => item.sourcing == null)
        .map((item) =>
          String(item.product?._id || item.product)
        )
        .filter((id) =>
          mongoose.isObjectIdOrHexString(id)
        )
    ),
  ];

  const products = ids.length
    ? await Product.find({
        _id: { $in: ids },
      })
        .select("_id optionLabels +meeshoProductLink")
        .lean()
    : [];

  const current = new Map(
    products.map((product) => [
      String(product._id),
      product,
    ])
  );

  return {
    ...response,

    items: response.items.map((item, index) => {
      const original = items[index];

      if (
        !original ||
        String(
          original.product?._id || original.product
        ) !== item.productId
      ) {
        throw new Error(
          "Order item sourcing could not be matched."
        );
      }

      const product = current.get(item.productId);
      const hasSnapshot = original.sourcing != null;

      const sourcingProduct = hasSnapshot
        ? {
            meeshoProductLink:
              original.sourcing.meeshoProductLink,

            optionLabels: {
              size: original.sourcing.sizeLabel,
              color: original.sourcing.colorLabel,
            },
          }
        : product;

      return {
        ...item,

        sourcing: {
          ...snapshotProductSourcing(sourcingProduct),

          source: hasSnapshot
            ? "snapshot"
            : product
              ? "current-product"
              : "unavailable",
        },
      };
    }),
  };
}

module.exports = {
  snapshotProductSourcing,
  withAdminSourcing,
};