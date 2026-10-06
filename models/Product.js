const mongoose =
  require("mongoose");


// ======================================================
// HELPERS
// ======================================================

function cleanString(
  value,
  maxLength = 500
) {
  return String(
    value ?? ""
  )
    .trim()
    .slice(
      0,
      maxLength
    );
}


function cleanStringArray(
  value,
  {
    maxItems = 100,
    maxLength = 200,
  } = {}
) {
  if (
    !Array.isArray(
      value
    )
  ) {
    return [];
  }


  const seen =
    new Set();


  const result =
    [];


  for (
    const item
    of value
  ) {
    const text =
      cleanString(
        item,
        maxLength
      );


    if (
      !text
    ) {
      continue;
    }


    const key =
      text.toLowerCase();


    if (
      seen.has(
        key
      )
    ) {
      continue;
    }


    seen.add(
      key
    );


    result.push(
      text
    );


    if (
      result.length >=
      maxItems
    ) {
      break;
    }
  }


  return result;
}


function getVariantStock(
  variants = {}
) {
  if (
    !variants ||
    typeof variants !==
      "object" ||
    Array.isArray(
      variants
    )
  ) {
    return 0;
  }


  let total =
    0;


  for (
    const variant
    of Object.values(
      variants
    )
  ) {
    if (
      !variant ||
      typeof variant !==
        "object" ||
      Array.isArray(
        variant
      )
    ) {
      continue;
    }


    for (
      const value
      of Object.values(
        variant
      )
    ) {
      const quantity =
        Number(
          value
        );


      if (
        Number.isFinite(
          quantity
        ) &&
        quantity >
          0
      ) {
        total +=
          Math.floor(
            quantity
          );
      }
    }
  }


  return total;
}


function hasVariants(
  variants
) {
  return Boolean(
    variants &&
      typeof variants ===
        "object" &&
      !Array.isArray(
        variants
      ) &&
      Object.keys(
        variants
      ).length >
        0
  );
}


function resolveStockStatus(
  stock
) {
  const quantity =
    Math.max(
      0,
      Number(
        stock || 0
      )
    );


  if (
    quantity <=
    0
  ) {
    return "out-of-stock";
  }


  if (
    quantity <=
    10
  ) {
    return "low-stock";
  }


  return "in-stock";
}


function calculateReviewSummary(
  reviews = []
) {
  if (
    !Array.isArray(
      reviews
    )
  ) {
    return {
      rating:
        0,

      reviewCount:
        0,
    };
  }


  const validReviews =
    reviews.filter(
      (
        review
      ) => {
        const rating =
          Number(
            review?.rating
          );


        return (
          Number.isFinite(
            rating
          ) &&
          rating >=
            1 &&
          rating <=
            5
        );
      }
    );


  if (
    validReviews.length ===
    0
  ) {
    return {
      rating:
        0,

      reviewCount:
        0,
    };
  }


  const total =
    validReviews.reduce(
      (
        sum,
        review
      ) =>
        sum +
        Number(
          review.rating
        ),

      0
    );


  return {
    reviewCount:
      validReviews.length,

    rating:
      Math.round(
        (
          total /
          validReviews.length
        ) *
          10
      ) /
      10,
  };
}


// ======================================================
// REVIEW
// ======================================================

const reviewSchema =
  new mongoose.Schema(
    {
      name: {
        type:
          String,

        required:
          true,

        trim:
          true,

        maxlength:
          100,
      },


      rating: {
        type:
          Number,

        required:
          true,

        min:
          1,

        max:
          5,
      },


      comment: {
        type:
          String,

        default:
          "",

        trim:
          true,

        maxlength:
          2000,
      },
    },

    {
      timestamps:
        true,
    }
  );


// ======================================================
// DELIVERY
// ======================================================

const deliverySchema =
  new mongoose.Schema(
    {
      available: {
        type:
          Boolean,

        default:
          true,
      },


      estimatedDays: {
        type:
          String,

        default:
          null,

        trim:
          true,

        maxlength:
          100,
      },


      freeDeliveryAbove: {
        type:
          Number,

        default:
          500,

        min:
          0,
      },
    },

    {
      _id:
        false,
    }
  );


// ======================================================
// PRODUCT
// ======================================================

const productSchema =
  new mongoose.Schema(
    {
      // ================================================
      // LEGACY FRONTEND ID
      // ================================================

      legacyId: {
        type:
          Number,

        default:
          null,

        index:
          true,
      },


      // ================================================
      // BASIC PRODUCT INFORMATION
      // ================================================

      slug: {
        type:
          String,

        required:
          true,

        unique:
          true,

        trim:
          true,

        lowercase:
          true,

        maxlength:
          180,
      },


      name: {
        type:
          String,

        required:
          true,

        trim:
          true,

        maxlength:
          200,
      },


      category: {
        type:
          String,

        required:
          true,

        trim:
          true,

        maxlength:
          100,

        index:
          true,
      },


      subcategory: {
        type:
          String,

        default:
          "",

        trim:
          true,

        maxlength:
          100,
      },


      brand: {
        type:
          String,

        default:
          "GymDrobe",

        trim:
          true,

        maxlength:
          100,
      },


      gender: {
        type:
          String,

        default:
          "Unisex",

        trim:
          true,

        maxlength:
          50,
      },


      // ================================================
      // PRICING
      // ================================================

      price: {
        type:
          Number,

        required:
          true,

        min:
          0,
      },


      discount: {
        type:
          Number,

        default:
          0,

        min:
          0,

        max:
          100,
      },


      // ================================================
      // REVIEWS
      // ================================================

      rating: {
        type:
          Number,

        default:
          0,

        min:
          0,

        max:
          5,
      },


      reviewCount: {
        type:
          Number,

        default:
          0,

        min:
          0,
      },


      reviews: {
        type: [
          reviewSchema,
        ],

        default:
          [],
      },


      // ================================================
      // MERCHANDISING
      // ================================================

      badge: {
        type:
          String,

        default:
          "",

        trim:
          true,

        maxlength:
          80,
      },


      tags: {
        type: [
          String,
        ],

        default:
          [],
      },


      isFeatured: {
        type:
          Boolean,

        default:
          false,

        index:
          true,
      },


      isBestSeller: {
        type:
          Boolean,

        default:
          false,

        index:
          true,
      },


      /*
        Mongoose already uses document.isNew internally.

        Database:
        isNewArrival

        Frontend:
        isNew
      */

      isNewArrival: {
        type:
          Boolean,

        default:
          false,

        index:
          true,
      },


      // ================================================
      // PRODUCT DETAILS
      // ================================================

      material: {
        type:
          String,

        default:
          "",

        trim:
          true,

        maxlength:
          500,
      },


      highlights: {
        type: [
          String,
        ],

        default:
          [],
      },


      specifications: {
        type:
          mongoose.Schema.Types.Mixed,

        default:
          {},
      },


      careInstructions: {
        type: [
          String,
        ],

        default:
          [],
      },


      whatsIncluded: {
        type:
          String,

        default:
          "",

        trim:
          true,

        maxlength:
          1000,
      },


      description: {
        type:
          String,

        default:
          "",

        trim:
          true,

        maxlength:
          5000,
      },


      // ================================================
      // PRODUCT OPTIONS
      // ================================================

      sizes: {
        type: [
          String,
        ],

        default:
          [],
      },


      colors: {
        type: [
          String,
        ],

        default:
          [],
      },


      /*
        IMPORTANT:

        Keep variants as Mixed because GymDrobe currently
        supports dynamic structures like:

        variants: {
          Black: {
            S: 5,
            M: 10
          },

          White: {
            S: 8,
            M: 12
          }
        }

        Products without sizes use:

        variants: {
          Black: {
            default: 15
          }
        }
      */

      variants: {
        type:
          mongoose.Schema.Types.Mixed,

        default:
          {},
      },


      // ================================================
      // INVENTORY
      // ================================================

      stock: {
        type:
          Number,

        default:
          0,

        min:
          0,

        index:
          true,
      },


      stockStatus: {
        type:
          String,

        enum: [
          "in-stock",
          "low-stock",
          "out-of-stock",
        ],

        default:
          "in-stock",

        index:
          true,
      },


      // ================================================
      // IMAGES
      // ================================================

      image: {
        type:
          String,

        default:
          "",

        trim:
          true,

        maxlength:
          2000,
      },


      images: {
        type: [
          String,
        ],

        default:
          [],
      },


      // ================================================
      // DELIVERY & RETURNS
      // ================================================

      delivery: {
        type:
          deliverySchema,

        default:
          () => ({}),
      },


      returnPolicy: {
        type:
          String,

        default:
          "",

        trim:
          true,

        maxlength:
          2000,
      },


      // ================================================
      // SKU
      // ================================================

      sku: {
        type:
          String,

        required:
          true,

        unique:
          true,

        trim:
          true,

        uppercase:
          true,

        maxlength:
          100,
      },


      // ================================================
      // ADMIN VISIBILITY
      // ================================================

      /*
        We will use isActive instead of permanently
        deleting a product immediately.

        true  = visible / available in catalogue
        false = hidden / archived by admin
      */

      isActive: {
        type:
          Boolean,

        default:
          true,

        index:
          true,
      },
    },

    {
      timestamps:
        true,

      minimize:
        false,
    }
  );


// ======================================================
// NORMALIZE PRODUCT BEFORE VALIDATION
// ======================================================

productSchema.pre(
  "validate",

  function () {
    // -----------------------------------------------
    // CLEAN BASIC STRINGS
    // -----------------------------------------------

    this.name =
      cleanString(
        this.name,
        200
      );


    this.slug =
      cleanString(
        this.slug,
        180
      )
        .toLowerCase();


    this.category =
      cleanString(
        this.category,
        100
      );


    this.subcategory =
      cleanString(
        this.subcategory,
        100
      );


    this.brand =
      cleanString(
        this.brand ||
          "GymDrobe",
        100
      ) ||
      "GymDrobe";


    this.gender =
      cleanString(
        this.gender ||
          "Unisex",
        50
      ) ||
      "Unisex";


    this.sku =
      cleanString(
        this.sku,
        100
      )
        .toUpperCase();


    // -----------------------------------------------
    // ARRAYS
    // -----------------------------------------------

    this.tags =
      cleanStringArray(
        this.tags,
        {
          maxItems:
            50,

          maxLength:
            100,
        }
      );


    this.highlights =
      cleanStringArray(
        this.highlights,
        {
          maxItems:
            30,

          maxLength:
            500,
        }
      );


    this.careInstructions =
      cleanStringArray(
        this.careInstructions,
        {
          maxItems:
            30,

          maxLength:
            500,
        }
      );


    this.sizes =
      cleanStringArray(
        this.sizes,
        {
          maxItems:
            50,

          maxLength:
            50,
        }
      );


    this.colors =
      cleanStringArray(
        this.colors,
        {
          maxItems:
            50,

          maxLength:
            80,
        }
      );


    this.images =
      cleanStringArray(
        this.images,
        {
          maxItems:
            20,

          maxLength:
            2000,
        }
      );


    // -----------------------------------------------
    // MAIN IMAGE
    // -----------------------------------------------

    this.image =
      cleanString(
        this.image,
        2000
      );


    /*
      If admin adds image gallery but forgets to choose
      a main image, use the first image automatically.
    */

    if (
      !this.image &&
      this.images.length >
        0
    ) {
      this.image =
        this.images[0];
    }


    /*
      If main image exists, keep it inside the gallery.
    */

    if (
      this.image &&
      !this.images.includes(
        this.image
      )
    ) {
      this.images =
        [
          this.image,
          ...this.images,
        ].slice(
          0,
          20
        );
    }


    // -----------------------------------------------
    // PRICE
    // -----------------------------------------------

    const price =
      Number(
        this.price
      );


    this.price =
      Number.isFinite(
        price
      )
        ? Math.max(
            0,
            price
          )
        : 0;


    const discount =
      Number(
        this.discount
      );


    this.discount =
      Number.isFinite(
        discount
      )
        ? Math.min(
            100,
            Math.max(
              0,
              discount
            )
          )
        : 0;


    // -----------------------------------------------
    // STOCK
    // -----------------------------------------------

    /*
      If variants exist, they become the source of truth
      for total stock.
    */

    if (
      hasVariants(
        this.variants
      )
    ) {
      this.stock =
        getVariantStock(
          this.variants
        );

    } else {
      const stock =
        Number(
          this.stock
        );


      this.stock =
        Number.isFinite(
          stock
        )
          ? Math.max(
              0,
              Math.floor(
                stock
              )
            )
          : 0;
    }


    this.stockStatus =
      resolveStockStatus(
        this.stock
      );


    // -----------------------------------------------
    // REVIEWS
    // -----------------------------------------------

    const summary =
      calculateReviewSummary(
        this.reviews
      );


    this.rating =
      summary.rating;


    this.reviewCount =
      summary.reviewCount;


    // -----------------------------------------------
    // DELIVERY
    // -----------------------------------------------

    if (
      !this.delivery
    ) {
      this.delivery = {};
    }


    /*
      Out-of-stock does not automatically make delivery
      unavailable because admin may be preparing stock.

      Delivery availability remains an explicit admin
      setting.
    */
  }
);


// ======================================================
// FRONTEND TRANSFORM
// ======================================================

function transformProduct(
  doc,
  ret
) {
  /*
    MongoDB field:
    isNewArrival

    Frontend field:
    isNew
  */

  ret.isNew =
    Boolean(
      ret.isNewArrival
    );


  delete ret.isNewArrival;


  /*
    Keep _id because the current frontend already knows
    how to normalize MongoDB _id into product.id.
  */

  delete ret.__v;


  return ret;
}


productSchema.set(
  "toJSON",
  {
    transform:
      transformProduct,
  }
);


productSchema.set(
  "toObject",
  {
    transform:
      transformProduct,
  }
);


// ======================================================
// INDEXES
// ======================================================

productSchema.index({
  isActive:
    1,

  category:
    1,

  createdAt:
    -1,
});


productSchema.index({
  isActive:
    1,

  stockStatus:
    1,
});


productSchema.index({
  name:
    "text",

  category:
    "text",

  subcategory:
    "text",

  brand:
    "text",

  tags:
    "text",
});


// ======================================================
// MODEL
// ======================================================

const Product =
  mongoose.model(
    "Product",
    productSchema
  );


module.exports =
  Product;