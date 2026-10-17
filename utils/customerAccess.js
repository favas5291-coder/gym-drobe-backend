"use strict";

// Use only after middleware verifies the customer's
// account token or private guest access credential.

function customerOwner(req) {
  if (req.user?._id) {
    return {
      user: req.user._id,
    };
  }

  if (req.guestSession?._id) {
    return {
      user: null,
      guestSession: req.guestSession._id,
    };
  }

  throw Object.assign(
    new Error("Order access is required."),
    {
      status: 401,
      code: "ORDER_ACCESS_REQUIRED",
      gymdrobe: true,
    },
  );
}

function customerFilter(req) {
  const owners = [];

  if (req.user?._id) {
    owners.push({
      user: req.user._id,
    });
  }

  if (req.guestSession?._id) {
    owners.push({
      user: null,
      guestSession: req.guestSession._id,
    });
  }

  if (!owners.length) {
    return customerOwner(req);
  }

  if (owners.length === 1) {
    return owners[0];
  }

  return {
    $or: owners,
  };
}

module.exports = {
  customerOwner,
  customerFilter,
};