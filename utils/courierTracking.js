"use strict";

const {
  normalizeCourierUrl,
} = require("./trackingUpdates");

function safeCourierUrl(value) {
  try {
    return normalizeCourierUrl(value);
  } catch {
    return "";
  }
}

module.exports = {
  normalizeCourierUrl,
  safeCourierUrl,
};