"use strict";

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const {
  createRequire,
} = require("node:module");

// Replace only the database boundary.
// Keep the real shipping loader, validation,
// pricing and failure handling.
function shippingWithRecord(
  record = null,
  failure = null
) {
  const filename = path.resolve(
    __dirname,
    "../../utils/checkoutShipping.js"
  );

  const base = createRequire(filename);

  const module = {
    exports: {},
  };

  const ShippingSettings = {
    findById(id) {
      if (id !== "store") {
        throw new Error(
          "Unexpected shipping settings key"
        );
      }

      return {
        lean() {
          return this;
        },

        maxTimeMS() {
          return failure
            ? Promise.reject(failure)
            : Promise.resolve(record);
        },
      };
    },
  };

  vm.runInNewContext(
    fs.readFileSync(filename, "utf8"),
    {
      module,

      require: (name) =>
        name === "../models/ShippingSettings"
          ? ShippingSettings
          : base(name),
    },
    { filename }
  );

  return module.exports;
}

module.exports = {
  shippingWithRecord,
};