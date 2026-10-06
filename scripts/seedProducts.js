const path = require("path");
const mongoose = require("mongoose");
const dotenv = require("dotenv");

// Always load backend/.env
dotenv.config({
  path: path.join(__dirname, "../.env"),
});

const connectDB = require("../config/db");
const Product = require("../models/Product");

// Temporary development image path.
// Later these should move to cloud storage
// such as Cloudinary / S3.
const image = (filename) =>
  `/src/assets/${filename}`;

const products = [
  // ======================================================
  // 1. GYM TRAINING T-SHIRT
  // ======================================================

  {
    id: 1,

    slug: "gym-training-t-shirt",

    name: "Gym Training T-Shirt",

    category: "Workout Clothes",

    subcategory: "T-Shirts",

    brand: "GymDrobe",

    gender: "Men",

    price: 799,

    discount: 10,

    badge: "BESTSELLER",

    tags: [
      "Gym",
      "Training",
      "Running",
      "Workout",
    ],

    isFeatured: true,

    isBestSeller: true,

    isNew: false,

    material:
      "Lightweight breathable performance fabric",

    highlights: [
      "Lightweight and breathable fabric",
      "Sweat-wicking performance material",
      "Comfortable for intense workouts",
      "Designed for gym and running",
      "Regular athletic fit",
    ],

    specifications: {
      Fit: "Regular Athletic Fit",
      Material: "Performance Fabric",
      Gender: "Men",
      Pattern: "Solid",
      Sleeve: "Short Sleeve",
      Neck: "Round Neck",
      Usage: "Gym, Training & Running",
    },

    careInstructions: [
      "Machine wash cold",
      "Wash with similar colors",
      "Do not bleach",
      "Do not iron directly on prints",
      "Tumble dry low",
    ],

    whatsIncluded:
      "1 Gym Training T-Shirt",

    sizes: [
      "S",
      "M",
      "L",
      "XL",
    ],

    colors: [
      "Black",
      "White",
      "Blue",
    ],

    variants: {
      Black: {
        S: 5,
        M: 10,
        L: 7,
        XL: 3,
      },

      White: {
        S: 8,
        M: 12,
        L: 6,
        XL: 4,
      },

      Blue: {
        S: 4,
        M: 8,
        L: 5,
        XL: 2,
      },
    },

    image: image("tshirt.jpg"),

    images: [
      image("tshirt.jpg"),
      image("tshirt2.jpg"),
      image("tshirt3.jpg"),
    ],

    description:
      "Premium lightweight gym training T-shirt designed for comfortable workouts, running and everyday fitness activities.",

    delivery: {
      available: true,

      estimatedDays:
        "3–7 business days",

      freeDeliveryAbove: 500,
    },

    returnPolicy:
      "Easy 7-day return and replacement available.",

    sku: "GD-TSHIRT-001",

    reviews: [
      {
        name: "Favas",

        rating: 5,

        comment:
          "Very comfortable and good quality.",
      },

      {
        name: "Nishad",

        rating: 5,

        comment:
          "Perfect for gym workouts.",
      },

      {
        name: "Midlaj",

        rating: 4,

        comment:
          "Good material and fitting.",
      },
    ],
  },

  // ======================================================
  // 2. PERFORMANCE GYM SHOES
  // ======================================================

  {
    id: 2,

    slug: "performance-gym-shoes",

    name: "Performance Gym Shoes",

    category: "Gym Shoes",

    subcategory: "Training Shoes",

    brand: "GymDrobe",

    gender: "Men",

    price: 2499,

    discount: 10,

    badge: "TOP RATED",

    tags: [
      "Gym",
      "Training",
      "Running",
      "Sports",
    ],

    isFeatured: true,

    isBestSeller: true,

    isNew: false,

    material:
      "Breathable mesh upper with cushioned sole",

    highlights: [
      "Lightweight construction",
      "Breathable mesh upper",
      "Cushioned sole for comfort",
      "Strong grip for training",
      "Suitable for gym and running",
    ],

    specifications: {
      Fit: "Regular Fit",

      Material:
        "Breathable Mesh",

      Gender: "Men",

      Sole:
        "Cushioned Rubber",

      Closure: "Lace-Up",

      Usage:
        "Training, Gym & Running",
    },

    careInstructions: [
      "Clean with a soft damp cloth",
      "Do not machine wash",
      "Air dry naturally",
      "Keep away from direct heat",
      "Store in a dry place",
    ],

    whatsIncluded:
      "1 Pair of Performance Gym Shoes",

    sizes: [
      "7",
      "8",
      "9",
      "10",
      "11",
    ],

    colors: [
      "Black",
      "White",
      "Grey",
    ],

    variants: {
      Black: {
        7: 3,
        8: 5,
        9: 8,
        10: 5,
        11: 2,
      },

      White: {
        7: 2,
        8: 4,
        9: 6,
        10: 4,
        11: 2,
      },

      Grey: {
        7: 3,
        8: 5,
        9: 7,
        10: 4,
        11: 2,
      },
    },

    image: image("shoes.jpg"),

    images: [
      image("shoes.jpg"),
      image("shoes2.jpg"),
      image("shoes3.jpg"),
    ],

    description:
      "Performance-focused gym shoes with a lightweight design, comfortable cushioning and strong grip.",

    delivery: {
      available: true,

      estimatedDays:
        "3–7 business days",

      freeDeliveryAbove: 500,
    },

    returnPolicy:
      "Easy 7-day return and replacement available.",

    sku: "GD-SHOES-001",

    reviews: [
      {
        name: "Arjun",

        rating: 5,

        comment:
          "Great shoes for training.",
      },

      {
        name: "Rahul",

        rating: 4,

        comment:
          "Comfortable and stylish.",
      },
    ],
  },

  // ======================================================
  // 3. PREMIUM SHAKER BOTTLE
  // ======================================================

  {
    id: 3,

    slug:
      "premium-shaker-bottle",

    name:
      "Premium Shaker Bottle",

    category:
      "Shaker Bottles",

    subcategory:
      "Protein Shakers",

    brand: "GymDrobe",

    gender: "Unisex",

    price: 599,

    discount: 10,

    badge: "TRENDING",

    tags: [
      "Protein",
      "Shaker",
      "Hydration",
      "Gym",
    ],

    isFeatured: true,

    isBestSeller: true,

    isNew: false,

    material:
      "BPA-free durable plastic",

    highlights: [
      "BPA-free construction",
      "Leak-resistant design",
      "Easy to carry",
      "Suitable for protein shakes",
      "Easy to clean",
    ],

    specifications: {
      Material:
        "BPA-Free Plastic",

      Gender:
        "Unisex",

      Capacity:
        "700 ml",

      Lid:
        "Leak-Resistant",

      Usage:
        "Protein Shakes & Hydration",
    },

    careInstructions: [
      "Wash before first use",
      "Hand wash recommended",
      "Do not use abrasive cleaners",
      "Keep lid open while drying",
    ],

    whatsIncluded:
      "1 Premium Shaker Bottle",

    sizes: [],

    colors: [
      "Black",
      "White",
      "Blue",
    ],

    variants: {
      Black: {
        default: 15,
      },

      White: {
        default: 12,
      },

      Blue: {
        default: 10,
      },
    },

    image:
      image("shaker.jpg"),

    images: [
      image("shaker.jpg"),
      image("bottle2.jpg"),
      image("bottle3.jpg"),
    ],

    description:
      "Premium leak-resistant shaker bottle designed for protein shakes, supplements and everyday hydration.",

    delivery: {
      available: true,

      estimatedDays:
        "3–7 business days",

      freeDeliveryAbove: 500,
    },

    returnPolicy:
      "Easy 7-day return and replacement available.",

    sku:
      "GD-SHAKER-001",

    reviews: [
      {
        name: "Favas",

        rating: 5,

        comment:
          "Good quality shaker.",
      },

      {
        name: "Adil",

        rating: 4,

        comment:
          "Looks premium.",
      },
    ],
  },

  // ======================================================
  // 4. PREMIUM GYM TOWEL
  // ======================================================

  {
    id: 4,

    slug:
      "premium-gym-towel",

    name:
      "Premium Gym Towel",

    category:
      "Gym Towels",

    subcategory:
      "Workout Towels",

    brand: "GymDrobe",

    gender: "Unisex",

    price: 399,

    discount: 10,

    badge: "POPULAR",

    tags: [
      "Gym",
      "Workout",
      "Towel",
      "Fitness",
    ],

    isFeatured: true,

    isBestSeller: false,

    isNew: false,

    material:
      "Soft absorbent microfiber",

    highlights: [
      "Soft microfiber fabric",
      "Highly absorbent",
      "Lightweight and easy to carry",
      "Quick drying",
      "Ideal for gym workouts",
    ],

    specifications: {
      Material:
        "Microfiber",

      Gender:
        "Unisex",

      Type:
        "Workout Towel",

      Usage:
        "Gym & Fitness",

      Feature:
        "Quick Drying",
    },

    careInstructions: [
      "Machine wash cold",
      "Wash with similar colors",
      "Do not bleach",
      "Air dry or tumble dry low",
    ],

    whatsIncluded:
      "1 Premium Gym Towel",

    sizes: [],

    colors: [
      "Black",
      "White",
      "Grey",
    ],

    variants: {
      Black: {
        default: 15,
      },

      White: {
        default: 10,
      },

      Grey: {
        default: 12,
      },
    },

    image:
      image("Towel.jpg"),

    images: [
      image("Towel.jpg"),
      image("towel2.jpg"),
      image("towel3.jpg"),
    ],

    description:
      "Soft, absorbent and lightweight gym towel designed for training sessions and everyday workouts.",

    delivery: {
      available: true,

      estimatedDays:
        "3–7 business days",

      freeDeliveryAbove: 500,
    },

    returnPolicy:
      "Easy 7-day return and replacement available.",

    sku:
      "GD-TOWEL-001",

    reviews: [
      {
        name: "Nihal",

        rating: 5,

        comment:
          "Very soft towel.",
      },

      {
        name: "Shamil",

        rating: 4,

        comment:
          "Good for gym use.",
      },
    ],
  },

  // ======================================================
  // 5. TRAINING SOCKS
  // ======================================================

  {
    id: 5,

    slug:
      "training-socks",

    name:
      "Training Socks",

    category:
      "Socks",

    subcategory:
      "Sports Socks",

    brand:
      "GymDrobe",

    gender:
      "Unisex",

    price: 299,

    discount: 10,

    badge:
      "POPULAR",

    tags: [
      "Gym",
      "Training",
      "Sports",
      "Running",
    ],

    isFeatured: false,

    isBestSeller: false,

    isNew: true,

    material:
      "Breathable stretch cotton blend",

    highlights: [
      "Breathable cotton blend",
      "Stretchable and comfortable",
      "Secure fit during workouts",
      "Moisture-friendly construction",
      "Suitable for gym and running",
    ],

    specifications: {
      Material:
        "Cotton Blend",

      Gender:
        "Unisex",

      Type:
        "Sports Socks",

      Fit:
        "Comfort Fit",

      Usage:
        "Gym, Training & Running",
    },

    careInstructions: [
      "Machine wash cold",
      "Wash with similar colors",
      "Do not bleach",
      "Do not iron",
      "Air dry recommended",
    ],

    whatsIncluded:
      "1 Pair of Training Socks",

    sizes: [
      "S",
      "M",
      "L",
    ],

    colors: [
      "Black",
      "White",
      "Grey",
    ],

    variants: {
      Black: {
        S: 10,
        M: 15,
        L: 10,
      },

      White: {
        S: 8,
        M: 12,
        L: 9,
      },

      Grey: {
        S: 6,
        M: 10,
        L: 7,
      },
    },

    image:
      image("Socks .jpg"),

    images: [
      image("Socks .jpg"),
      image("socks2.jpg"),
      image("socks3.jpg"),
    ],

    description:
      "Comfortable training socks designed with breathable fabric and a secure fit for workouts.",

    delivery: {
      available: true,

      estimatedDays:
        "3–7 business days",

      freeDeliveryAbove: 500,
    },

    returnPolicy:
      "Easy 7-day return and replacement available.",

    sku:
      "GD-SOCKS-001",

    reviews: [
      {
        name: "Favas",

        rating: 4,

        comment:
          "Comfortable socks.",
      },

      {
        name: "Ameen",

        rating: 5,

        comment:
          "Good quality.",
      },
    ],
  },

  // ======================================================
  // 6. GYM WATER BOTTLE
  // ======================================================

  {
    id: 6,

    slug:
      "gym-water-bottle",

    name:
      "Gym Water Bottle",

    category:
      "Water Bottles",

    subcategory:
      "Sports Bottles",

    brand:
      "GymDrobe",

    gender:
      "Unisex",

    price: 499,

    discount: 10,

    badge:
      "COMING SOON",

    tags: [
      "Hydration",
      "Gym",
      "Running",
      "Outdoor",
    ],

    isFeatured: false,

    isBestSeller: false,

    isNew: true,

    material:
      "Durable BPA-free plastic",

    highlights: [
      "BPA-free material",
      "Durable construction",
      "Easy-grip design",
      "Suitable for gym and outdoor use",
      "Lightweight and portable",
    ],

    specifications: {
      Material:
        "BPA-Free Plastic",

      Gender:
        "Unisex",

      Capacity:
        "1 Litre",

      Type:
        "Sports Water Bottle",

      Usage:
        "Gym, Running & Outdoor",
    },

    careInstructions: [
      "Wash before first use",
      "Hand wash recommended",
      "Do not use abrasive cleaners",
      "Keep cap open while drying",
    ],

    whatsIncluded:
      "1 Gym Water Bottle",

    sizes: [],

    colors: [
      "Black",
      "White",
      "Blue",
    ],

    variants: {
      Black: {
        default: 0,
      },

      White: {
        default: 0,
      },

      Blue: {
        default: 0,
      },
    },

    image:
      image("bottle.jpg"),

    images: [
      image("bottle.jpg"),
      image("bottle2.jpg"),
      image("bottle3.jpg"),
    ],

    description:
      "Durable gym water bottle designed for hydration during workouts, running and outdoor activities.",

    delivery: {
      available: false,

      estimatedDays: null,

      freeDeliveryAbove: 500,
    },

    returnPolicy:
      "Easy 7-day return and replacement available.",

    sku:
      "GD-BOTTLE-001",

    reviews: [],
  },
];

// ======================================================
// CALCULATE STOCK FROM VARIANTS
// ======================================================

function getTotalStock(
  variants = {}
) {
  let total = 0;

  for (
    const variant
    of Object.values(variants)
  ) {
    if (
      !variant ||
      typeof variant !== "object"
    ) {
      continue;
    }

    for (
      const amount
      of Object.values(variant)
    ) {
      const quantity =
        Number(amount);

      if (
        Number.isFinite(quantity)
      ) {
        total += quantity;
      }
    }
  }

  return total;
}

// ======================================================
// PREPARE PRODUCT
// ======================================================

function prepareProduct(
  product
) {
  const reviews =
    Array.isArray(
      product.reviews
    )
      ? product.reviews.filter(
          (review) => {
            const rating =
              Number(
                review.rating
              );

            return (
              Number.isFinite(
                rating
              ) &&
              rating >= 1 &&
              rating <= 5
            );
          }
        )
      : [];

  const reviewCount =
    reviews.length;

  const rating =
    reviewCount > 0
      ? Math.round(
          (
            reviews.reduce(
              (
                total,
                review
              ) =>
                total +
                Number(
                  review.rating
                ),
              0
            ) /
            reviewCount
          ) * 10
        ) / 10
      : 0;

  const stock =
    getTotalStock(
      product.variants
    );

  const {
    id,
    isNew,
    ...productData
  } = product;

  return {
    ...productData,

    legacyId: id,

    // Safe MongoDB/Mongoose field
    isNewArrival:
      Boolean(isNew),

    stock,

    reviews,

    reviewCount,

    rating,

    stockStatus:
      stock <= 0
        ? "out-of-stock"
        : stock <= 10
          ? "low-stock"
          : "in-stock",
  };
}

// ======================================================
// SEED DATABASE
// ======================================================

async function seedProducts() {
  try {
    console.log(
      "🌱 Connecting to MongoDB..."
    );

    await connectDB();

    console.log(
      "🗑️ Removing old product data..."
    );

    await Product.deleteMany({});

    const preparedProducts =
      products.map(
        prepareProduct
      );

    console.log(
      "📦 Adding GymDrobe products..."
    );

    const insertedProducts =
      await Product.insertMany(
        preparedProducts
      );

    console.log("");

    console.log(
      `✅ ${insertedProducts.length} products added successfully.`
    );

    console.log("");

    insertedProducts.forEach(
      (product) => {
        console.log(
          `✅ ${product.name} | Stock: ${product.stock} | Rating: ${product.rating}`
        );
      }
    );

    console.log("");

    console.log(
      "🎉 GymDrobe database seeding complete."
    );
  } catch (error) {
    console.error("");

    console.error(
      "❌ Product seeding failed:"
    );

    console.error(
      error.message
    );

    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();

    console.log(
      "🔌 MongoDB connection closed."
    );
  }
}

seedProducts();