const mongoose = require("mongoose");

const Product = require("../models/Product");
const Order = require("../models/Order");
const Review = require("../models/Review");

const {
  publicReview,
} = require("../utils/productReviews");

// ======================================================
// FIND ACTIVE PRODUCT
// Supports MongoDB ID, legacy numeric ID, and slug.
// ======================================================

async function findProduct(identifier) {
  const text = String(identifier || "").trim();

  if (!text) {
    return null;
  }

  const conditions = [
    { slug: text.toLowerCase() },
  ];

  if (mongoose.Types.ObjectId.isValid(text)) {
    conditions.push({ _id: text });
  }

  const legacyId = Number(text);

  if (
    Number.isSafeInteger(legacyId) &&
    legacyId > 0
  ) {
    conditions.push({ legacyId });
  }

  return Product.findOne({
    isActive: true,
    $or: conditions,
  }).select("_id");
}

// ======================================================
// ERROR RESPONSE
// ======================================================

function sendReviewError(res, error) {
  console.error(
    "Review request failed:",
    error.message,
  );

  if (error.name === "ValidationError") {
    return res.status(400).json({
      success: false,
      message:
        "Choose a rating from 1 to 5 and write a review of 5–1500 characters.",
    });
  }

  return res.status(500).json({
    success: false,
    message:
      "Unable to complete your review request. Please try again.",
  });
}

// ======================================================
// PUBLIC — GET PRODUCT REVIEWS
// ======================================================

async function getReviews(req, res) {
  try {
    const product = await findProduct(
      req.params.id,
    );

    if (!product) {
      return res.status(404).json({
        success: false,
        message: "Product not found.",
      });
    }

    const reviews = await Review.find({
      product: product._id,
    })
      .sort({ createdAt: -1 })
      .lean();

    return res.status(200).json({
      success: true,
      reviews: reviews.map(publicReview),
    });
  } catch (error) {
    return sendReviewError(res, error);
  }
}

// ======================================================
// AUTHENTICATED — CREATE OR UPDATE OWN REVIEW
// One review per account and product.
// ======================================================

async function saveReview(req, res) {
  try {
    if (!req.user?._id) {
      return res.status(401).json({
        success: false,
        message:
          "Please sign in to write a review.",
      });
    }

    const rating = req.body?.rating;

    const comment =
      typeof req.body?.comment === "string"
        ? req.body.comment.trim()
        : "";

    if (
      !Number.isInteger(rating) ||
      rating < 1 ||
      rating > 5 ||
      comment.length < 5 ||
      comment.length > 1500
    ) {
      return res.status(400).json({
        success: false,
        message:
          "Choose a rating from 1 to 5 and write a review of 5–1500 characters.",
      });
    }

    const product = await findProduct(
      req.params.id,
    );

    if (!product) {
      return res.status(404).json({
        success: false,
        message: "Product not found.",
      });
    }

    // The server checks purchase verification.
    // Client-supplied verified/user/name fields are ignored.
    const deliveredOrder = await Order.exists({
      user: req.user._id,
      status: "delivered",
      "items.product": product._id,
    });

    const filter = {
      product: product._id,
      user: req.user._id,
    };

    const changes = {
      name: String(
        req.user.name || "Customer",
      )
        .trim()
        .slice(0, 100) || "Customer",

      rating,
      comment,
      verified: Boolean(deliveredOrder),
    };

    let review;

    try {
      review = await Review.findOneAndUpdate(
        filter,
        { $set: changes },
        {
          upsert: true,
          new: true,
          runValidators: true,
          setDefaultsOnInsert: true,
        },
      );
    } catch (error) {
      // If simultaneous submissions hit the unique index,
      // update the review created by the first request.
      if (error.code !== 11000) {
        throw error;
      }

      review = await Review.findOneAndUpdate(
        filter,
        { $set: changes },
        {
          new: true,
          runValidators: true,
        },
      );
    }

    if (!review) {
      return res.status(409).json({
        success: false,
        message:
          "Your review changed during this request. Please try again.",
      });
    }

    return res.status(200).json({
      success: true,
      message: "Your review was saved.",
      review: publicReview(review),
    });
  } catch (error) {
    return sendReviewError(res, error);
  }
}

// ======================================================
// AUTHENTICATED — DELETE OWN REVIEW
// ======================================================

async function deleteReview(req, res) {
  try {
    if (!req.user?._id) {
      return res.status(401).json({
        success: false,
        message:
          "Please sign in to manage your review.",
      });
    }

    const product = await findProduct(
      req.params.id,
    );

    if (!product) {
      return res.status(404).json({
        success: false,
        message: "Product not found.",
      });
    }

    await Review.deleteOne({
      product: product._id,
      user: req.user._id,
    });

    return res.status(200).json({
      success: true,
      message: "Your review was removed.",
    });
  } catch (error) {
    return sendReviewError(res, error);
  }
}

// ======================================================
// EXPORTS
// ======================================================

module.exports = {
  getReviews,
  saveReview,
  deleteReview,
};