"use strict";

// Colour galleries are shared by every size.
// These helpers do not make network requests.

function isProductImageSource(value) {
  if (typeof value !== "string") {
    return false;
  }

  const source = value.trim();

  if (
    !source ||
    source.length > 2000 ||
    /[\u0000-\u001f\u007f<>\\]/.test(source)
  ) {
    return false;
  }

  if (/^https?:\/\//i.test(source)) {
    try {
      const url = new URL(source);
      const host = url.hostname.toLowerCase();

      return (
        !url.username &&
        !url.password &&
        !["localhost", "::1", "[::1]"].includes(host) &&
        !host.endsWith(".localhost") &&
        !/^127\./.test(host)
      );
    } catch {
      return false;
    }
  }

  return (
    !/^[a-z][a-z0-9+.-]*:/i.test(source) &&
    !source.startsWith("//") &&
    !source.startsWith("#") &&
    !source.startsWith("?")
  );
}

function normalizeColorImages(value, colors = null) {
  if (value == null) {
    return [];
  }

  if (!Array.isArray(value) || value.length > 50) {
    throw new Error(
      "Use up to 50 colour photo groups."
    );
  }

  const result = [];
  const seen = new Set();

  let total = 0;

  for (const row of value) {
    if (
      !row ||
      typeof row !== "object" ||
      Array.isArray(row) ||
      typeof row.color !== "string" ||
      !row.color.trim() ||
      row.color.trim().length > 80 ||
      /[\u0000-\u001f\u007f]/.test(row.color) ||
      !Array.isArray(row.images) ||
      row.images.length > 20
    ) {
      throw new Error(
        "Each colour needs a name and up to 20 photo links."
      );
    }

    const color = row.color.trim();
    const colorKey = color.toLowerCase();

    if (seen.has(colorKey)) {
      throw new Error(
        `Photo group ${color} is repeated.`
      );
    }

    seen.add(colorKey);

    if (colors && !colors.includes(color)) {
      throw new Error(
        `Photo colour ${color} must match an available colour exactly.`
      );
    }

    if (
      row.images.some(
        (image) => !isProductImageSource(image)
      )
    ) {
      throw new Error(
        `${color}: use hosted HTTP/HTTPS images or website image paths. Local files, localhost and unsafe URLs are not supported.`
      );
    }

    const images = [
      ...new Set(
        row.images.map((image) => image.trim())
      ),
    ];

    total += images.length;

    if (total > 100) {
      throw new Error(
        "Use no more than 100 colour photos across this product."
      );
    }

    if (images.length > 0) {
      result.push({
        color,
        images,
      });
    }
  }

  return result;
}

function productImageSources(
  product,
  selectedColor = product?.selectedColor
) {
  const rows = Array.isArray(product?.colorImages)
    ? product.colorImages
    : [];

  const assigned = rows.find(
    (row) => row?.color === selectedColor
  );

  const photos = Array.isArray(assigned?.images)
    ? assigned.images.filter(isProductImageSource)
    : [];

  const sources = photos.length
    ? photos
    : [
        product?.image,
        ...(Array.isArray(product?.images)
          ? product.images
          : []),
      ];

  return [
    ...new Set(
      sources
        .filter(isProductImageSource)
        .map((value) => value.trim())
    ),
  ];
}

function selectedProductImage(product, color) {
  return productImageSources(product, color)[0] || "";
}

module.exports = {
  isProductImageSource,
  normalizeColorImages,
  productImageSources,
  selectedProductImage,
};