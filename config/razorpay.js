const Razorpay = require("razorpay");

let client = null;
let cachedKeyId = "";
let cachedKeySecret = "";

function configurationError(message) {
  return Object.assign(new Error(message), {
    status: 503,
    code: "RAZORPAY_NOT_CONFIGURED",
  });
}

function getCredentials() {
  const keyId = String(
    process.env.RAZORPAY_KEY_ID || ""
  ).trim();

  const keySecret = String(
    process.env.RAZORPAY_KEY_SECRET || ""
  ).trim();

  if (!keyId || !keySecret) {
    throw configurationError(
      "Online payment is temporarily unavailable. Please contact support."
    );
  }

  if (
    !/^rzp_(test|live)_[A-Za-z0-9]+$/.test(keyId) ||
    /^(your_|paste_)/i.test(keySecret)
  ) {
    throw configurationError(
      "Online payment is temporarily unavailable. Please contact support."
    );
  }

  return { keyId, keySecret };
}

function paymentOrderError(error) {
  const providerStatus = Number(
    error?.statusCode || error?.status || 0
  );

  const providerCode = error?.error?.code;

  // Log only diagnostic identifiers.
  // Never log credentials, request bodies or customer details.
  console.error("Razorpay order creation failed:", {
    status: providerStatus || "unknown",
    code:
      typeof providerCode === "string" &&
      /^[A-Z0-9_]{1,80}$/.test(providerCode)
        ? providerCode
        : "UNKNOWN",
  });

  if (providerStatus === 401 || providerStatus === 403) {
    return Object.assign(
      new Error(
        "The payment service could not authenticate. Please contact support."
      ),
      {
        status: 503,
        code: "RAZORPAY_AUTH_FAILED",
      }
    );
  }

  if (providerStatus === 400) {
    return Object.assign(
      new Error(
        "The payment service rejected this order. Please contact support."
      ),
      {
        status: 502,
        code: "RAZORPAY_ORDER_REJECTED",
      }
    );
  }

  return Object.assign(
    new Error(
      "The payment service is temporarily unavailable. Please try again later."
    ),
    {
      status: 503,
      code: "RAZORPAY_SERVICE_UNAVAILABLE",
    }
  );
}

function getRazorpayClient() {
  const { keyId, keySecret } = getCredentials();

  if (
    client &&
    cachedKeyId === keyId &&
    cachedKeySecret === keySecret
  ) {
    return client;
  }

  const nextClient = new Razorpay({
    key_id: keyId,
    key_secret: keySecret,
  });

  const createOrder =
    nextClient.orders.create.bind(nextClient.orders);

  nextClient.orders.create = async function (options) {
    try {
      return await createOrder(options);
    } catch (error) {
      throw paymentOrderError(error);
    }
  };

  client = nextClient;
  cachedKeyId = keyId;
  cachedKeySecret = keySecret;

  return client;
}

function getRazorpayKeyId() {
  return getCredentials().keyId;
}

module.exports = {
  getRazorpayClient,
  getRazorpayKeyId,
};