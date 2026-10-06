const Review = require("../models/Review");

function publicReview(row) {
  return {
    id: String(row._id),
    userId: String(row.user),
    name: row.name,
    rating: row.rating,
    comment: row.comment,
    verified: row.verified === true,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function attachReviews(products) {
  const rows = await Review.find({
    product: {
      $in: products.map((product) => product._id),
    },
  })
    .sort({ createdAt: -1 })
    .lean();

  const grouped = new Map();

  for (const row of rows) {
    const key = String(row.product);

    if (!grouped.has(key)) {
      grouped.set(key, []);
    }

    grouped.get(key).push(publicReview(row));
  }

  return products.map((product) => {
    const data =
      typeof product.toObject === "function"
        ? product.toObject()
        : product;

    const reviews =
      grouped.get(String(product._id)) || [];

    const rating = reviews.length
      ? Math.round(
          (reviews.reduce(
            (sum, review) => sum + review.rating,
            0,
          ) /
            reviews.length) *
            10,
        ) / 10
      : 0;

    return {
      ...data,
      reviews,
      rating,
      reviewCount: reviews.length,
    };
  });
}

module.exports = {
  publicReview,
  attachReviews,
};