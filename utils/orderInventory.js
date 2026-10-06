function number(
  value,
  fallback = 0
) {
  const parsed =
    Number(value);

  return Number.isFinite(
    parsed
  )
    ? parsed
    : fallback;
}


// ======================================================
// SAFE STOCK COUNT
// ======================================================

function count(
  value
) {
  return Math.max(
    0,
    Math.floor(
      number(
        value
      )
    )
  );
}


// ======================================================
// OWN PROPERTY
// ======================================================

function own(
  object,
  key
) {
  return Object.prototype
    .hasOwnProperty.call(
      object || {},
      key
    );
}


// ======================================================
// CALCULATE VARIANT TOTAL
// ======================================================

function calculateVariantTotal(
  variants
) {
  const sum = (
    value
  ) => {
    if (
      value &&
      typeof value ===
        "object"
    ) {
      return Object
        .values(
          value
        )
        .reduce(
          (
            total,
            child
          ) =>
            total +
            sum(
              child
            ),
          0
        );
    }


    return count(
      value
    );
  };


  return sum(
    variants ||
      {}
  );
}


// ======================================================
// TOTAL STOCK
// ======================================================

function getTotalStock(
  product
) {
  if (
    !product
  ) {
    return 0;
  }


  if (
    product.variants
  ) {
    return calculateVariantTotal(
      product.variants
    );
  }


  return count(
    product.stock
  );
}


// ======================================================
// VARIANT STOCK
// ======================================================

function getVariantStock(
  product,
  selectedSize = null,
  selectedColor = null
) {
  if (
    !product
  ) {
    return 0;
  }


  const sizes =
    (
      product.sizes ||
      []
    ).map(
      String
    );


  const colors =
    (
      product.colors ||
      []
    ).map(
      String
    );


  // ====================================================
  // SIZE REQUIRED
  // ====================================================

  if (
    sizes.length
  ) {
    if (
      selectedSize ==
        null ||
      !sizes.includes(
        String(
          selectedSize
        )
      )
    ) {
      return 0;
    }
  }


  // ====================================================
  // COLOR REQUIRED
  // ====================================================

  if (
    colors.length
  ) {
    if (
      selectedColor ==
        null ||
      !colors.includes(
        String(
          selectedColor
        )
      )
    ) {
      return 0;
    }
  }


  // ====================================================
  // NO VARIANT OBJECT
  // ====================================================

  if (
    !product.variants
  ) {
    return count(
      product.stock
    );
  }


  let group =
    product.variants;


  // ====================================================
  // COLOR LEVEL
  // ====================================================

  if (
    colors.length
  ) {
    const color =
      String(
        selectedColor
      );


    if (
      !own(
        group,
        color
      )
    ) {
      return 0;
    }


    group =
      group[
        color
      ];
  }


  // ====================================================
  // SIZE LEVEL
  // ====================================================

  if (
    sizes.length
  ) {
    const size =
      String(
        selectedSize
      );


    if (
      !own(
        group,
        size
      )
    ) {
      return 0;
    }


    return count(
      group[
        size
      ]
    );
  }


  // ====================================================
  // DEFAULT LEVEL
  // ====================================================

  if (
    group &&
    typeof group ===
      "object"
  ) {
    return count(
      group.default
    );
  }


  return count(
    group
  );
}


// ======================================================
// UPDATE STOCK STATUS
// ======================================================

function updateStockStatus(
  product
) {
  const total =
    getTotalStock(
      product
    );


  product.stock =
    total;


  product.stockStatus =
    total <= 0
      ? "out-of-stock"
      : total <= 10
        ? "low-stock"
        : "in-stock";


  return product;
}


// ======================================================
// VALIDATE VARIANT
//
// Used before changing inventory.
// ======================================================

function validateVariant(
  product,
  selectedSize,
  selectedColor
) {
  const sizes =
    (
      product.sizes ||
      []
    ).map(
      String
    );


  const colors =
    (
      product.colors ||
      []
    ).map(
      String
    );


  let size =
    selectedSize ==
    null
      ? null
      : String(
          selectedSize
        );


  let color =
    selectedColor ==
    null
      ? null
      : String(
          selectedColor
        );


  if (
    sizes.length
  ) {
    if (
      !size ||
      !sizes.includes(
        size
      )
    ) {
      throw new Error(
        "Invalid product size."
      );
    }
  } else {
    size =
      null;
  }


  if (
    colors.length
  ) {
    if (
      !color ||
      !colors.includes(
        color
      )
    ) {
      throw new Error(
        "Invalid product colour."
      );
    }
  } else {
    color =
      null;
  }


  return {
    sizes,
    colors,
    size,
    color,
  };
}


// ======================================================
// RESERVE / DEDUCT STOCK
// ======================================================

function reserveVariantStock(
  product,
  quantity,
  selectedSize = null,
  selectedColor = null
) {
  const qty =
    Number(
      quantity
    );


  if (
    !Number.isSafeInteger(
      qty
    ) ||
    qty < 1
  ) {
    throw new Error(
      "Invalid order quantity."
    );
  }


  const {
    sizes,
    colors,
    size,
    color,
  } =
    validateVariant(
      product,
      selectedSize,
      selectedColor
    );


  const available =
    getVariantStock(
      product,
      size,
      color
    );


  if (
    available <
    qty
  ) {
    throw new Error(
      available >
      0
        ? `Only ${available} available for this selection.`
        : "This product selection is out of stock."
    );
  }


  // ====================================================
  // VARIANT PRODUCT
  // ====================================================

  if (
    product.variants
  ) {
    // --------------------------------------------------
    // COLOR + SIZE
    // --------------------------------------------------

    if (
      colors.length &&
      sizes.length
    ) {
      if (
        !own(
          product.variants,
          color
        ) ||
        !own(
          product.variants[
            color
          ],
          size
        )
      ) {
        throw new Error(
          "Product variant no longer exists."
        );
      }


      product.variants[
        color
      ][
        size
      ] =
        count(
          product.variants[
            color
          ][
            size
          ]
        ) -
        qty;
    }


    // --------------------------------------------------
    // COLOR ONLY
    // --------------------------------------------------

    else if (
      colors.length
    ) {
      if (
        !own(
          product.variants,
          color
        ) ||
        !own(
          product.variants[
            color
          ],
          "default"
        )
      ) {
        throw new Error(
          "Product colour variant no longer exists."
        );
      }


      product.variants[
        color
      ].default =
        count(
          product.variants[
            color
          ].default
        ) -
        qty;
    }


    // --------------------------------------------------
    // SIZE ONLY
    // --------------------------------------------------

    else if (
      sizes.length
    ) {
      if (
        !own(
          product.variants,
          size
        )
      ) {
        throw new Error(
          "Product size variant no longer exists."
        );
      }


      product.variants[
        size
      ] =
        count(
          product.variants[
            size
          ]
        ) -
        qty;
    }


    // --------------------------------------------------
    // DEFAULT VARIANT
    // --------------------------------------------------

    else {
      if (
        !own(
          product.variants,
          "default"
        )
      ) {
        throw new Error(
          "Product stock variant no longer exists."
        );
      }


      product.variants.default =
        count(
          product.variants
            .default
        ) -
        qty;
    }


    if (
      typeof product.markModified ===
      "function"
    ) {
      product.markModified(
        "variants"
      );
    }
  }


  // ====================================================
  // NON-VARIANT PRODUCT
  // ====================================================

  else {
    const current =
      count(
        product.stock
      );


    if (
      current <
      qty
    ) {
      throw new Error(
        current >
        0
          ? `Only ${current} available for this selection.`
          : "This product selection is out of stock."
      );
    }


    product.stock =
      current -
      qty;
  }


  updateStockStatus(
    product
  );


  return product;
}


// ======================================================
// RESTORE STOCK
//
// Used for:
//
// 1. Order cancellation
// 2. Completed return
// 3. Completed exchange original item
//
// This is the opposite of reserveVariantStock().
// ======================================================

function restoreVariantStock(
  product,
  quantity,
  selectedSize = null,
  selectedColor = null
) {
  const qty =
    Number(
      quantity
    );


  if (
    !Number.isSafeInteger(
      qty
    ) ||
    qty < 1
  ) {
    throw new Error(
      "Invalid inventory restore quantity."
    );
  }


  const {
    sizes,
    colors,
    size,
    color,
  } =
    validateVariant(
      product,
      selectedSize,
      selectedColor
    );


  // ====================================================
  // VARIANT PRODUCT
  // ====================================================

  if (
    product.variants
  ) {
    // --------------------------------------------------
    // COLOR + SIZE
    // --------------------------------------------------

    if (
      colors.length &&
      sizes.length
    ) {
      if (
        !own(
          product.variants,
          color
        ) ||
        !own(
          product.variants[
            color
          ],
          size
        )
      ) {
        throw new Error(
          "Unable to restore stock because the original product variant no longer exists."
        );
      }


      product.variants[
        color
      ][
        size
      ] =
        count(
          product.variants[
            color
          ][
            size
          ]
        ) +
        qty;
    }


    // --------------------------------------------------
    // COLOR ONLY
    // --------------------------------------------------

    else if (
      colors.length
    ) {
      if (
        !own(
          product.variants,
          color
        ) ||
        !own(
          product.variants[
            color
          ],
          "default"
        )
      ) {
        throw new Error(
          "Unable to restore stock because the original colour variant no longer exists."
        );
      }


      product.variants[
        color
      ].default =
        count(
          product.variants[
            color
          ].default
        ) +
        qty;
    }


    // --------------------------------------------------
    // SIZE ONLY
    // --------------------------------------------------

    else if (
      sizes.length
    ) {
      if (
        !own(
          product.variants,
          size
        )
      ) {
        throw new Error(
          "Unable to restore stock because the original size variant no longer exists."
        );
      }


      product.variants[
        size
      ] =
        count(
          product.variants[
            size
          ]
        ) +
        qty;
    }


    // --------------------------------------------------
    // DEFAULT
    // --------------------------------------------------

    else {
      if (
        !own(
          product.variants,
          "default"
        )
      ) {
        throw new Error(
          "Unable to restore stock because the original stock variant no longer exists."
        );
      }


      product.variants.default =
        count(
          product.variants
            .default
        ) +
        qty;
    }


    if (
      typeof product.markModified ===
      "function"
    ) {
      product.markModified(
        "variants"
      );
    }
  }


  // ====================================================
  // NON-VARIANT PRODUCT
  // ====================================================

  else {
    product.stock =
      count(
        product.stock
      ) +
      qty;
  }


  // Recalculate total stock and stock status.
  updateStockStatus(
    product
  );


  return product;
}


// ======================================================
// EXPORTS
// ======================================================

module.exports = {
  getTotalStock,
  getVariantStock,
  reserveVariantStock,
  restoreVariantStock,
  updateStockStatus,
};