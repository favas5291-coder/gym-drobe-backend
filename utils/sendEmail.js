const { randomUUID } = require("node:crypto");

let cachedToken = null;
let tokenExpiresAt = 0;
let refreshPromise = null;

function emailError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function validEmail(value) {
  return (
    typeof value === "string" &&
    value.length <= 254 &&
    !/[\r\n]/.test(value) &&
    /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(value)
  );
}

function getConfig() {
  const config = {
    clientId: process.env.GMAIL_CLIENT_ID?.trim(),
    clientSecret: process.env.GMAIL_CLIENT_SECRET?.trim(),
    refreshToken: process.env.GMAIL_REFRESH_TOKEN?.trim(),
    from: process.env.EMAIL_FROM?.trim(),
  };

  if (
    !config.clientId ||
    !config.clientSecret ||
    !config.refreshToken ||
    !validEmail(config.from)
  ) {
    throw emailError(
      "EMAIL_NOT_CONFIGURED",
      "Email sender settings are missing or invalid."
    );
  }

  return config;
}

async function googleRequest(url, options) {
  try {
    return await fetch(url, {
      ...options,
      redirect: "error",
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw emailError(
      "EMAIL_CONNECTION_FAILED",
      "The email service could not be reached."
    );
  }
}

async function refreshAccessToken(config) {
  const response = await googleRequest(
    "https://oauth2.googleapis.com/token",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        refresh_token: config.refreshToken,
        grant_type: "refresh_token",
      }),
    }
  );

  const data = await response.json().catch(() => null);

  if (!response.ok || typeof data?.access_token !== "string") {
    throw emailError(
      "EMAIL_AUTH_FAILED",
      "The email sender could not be authorized. Check its OAuth settings."
    );
  }

  const lifetime = Number(data.expires_in);

  if (!Number.isFinite(lifetime) || lifetime <= 0) {
    throw emailError(
      "EMAIL_AUTH_FAILED",
      "The email service returned an invalid token lifetime."
    );
  }

  cachedToken = data.access_token;
  tokenExpiresAt = Date.now() + lifetime * 1000;

  return cachedToken;
}

async function getAccessToken(config) {
  if (cachedToken && Date.now() < tokenExpiresAt - 60000) {
    return cachedToken;
  }

  if (!refreshPromise) {
    refreshPromise = refreshAccessToken(config).finally(() => {
      refreshPromise = null;
    });
  }

  return refreshPromise;
}

async function sendEmail({ to, subject, text }) {
  const config = getConfig();
  const recipient = typeof to === "string" ? to.trim() : "";

  if (!validEmail(recipient)) {
    throw emailError(
      "INVALID_EMAIL",
      "A valid recipient email is required."
    );
  }

  if (
    typeof subject !== "string" ||
    !subject.trim() ||
    subject.length > 150 ||
    /[\r\n]/.test(subject)
  ) {
    throw emailError(
      "INVALID_EMAIL_SUBJECT",
      "A valid email subject is required."
    );
  }

  if (
    typeof text !== "string" ||
    !text.trim() ||
    Buffer.byteLength(text, "utf8") > 100000
  ) {
    throw emailError(
      "INVALID_EMAIL_CONTENT",
      "Valid email content is required."
    );
  }

  const accessToken = await getAccessToken(config);

  const encodedSubject = Buffer.from(
    subject.trim(),
    "utf8"
  ).toString("base64");

  const encodedBody = Buffer.from(text, "utf8")
    .toString("base64")
    .match(/.{1,76}/g)
    .join("\r\n");

  const senderDomain = config.from.split("@")[1];

  const message = [
    `From: GymDrobe <${config.from}>`,
    `To: ${recipient}`,
    `Subject: =?UTF-8?B?${encodedSubject}?=`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${randomUUID()}@${senderDomain}>`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    encodedBody,
    "",
  ].join("\r\n");

  const response = await googleRequest(
    "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        raw: Buffer.from(message, "utf8").toString("base64url"),
      }),
    }
  );

  if (!response.ok) {
    if (response.status === 401) {
      cachedToken = null;
      tokenExpiresAt = 0;
    }

    // Do not log Google's response, tokens, or email content.
    throw emailError(
      "EMAIL_SEND_FAILED",
      "The email service could not send the message."
    );
  }

  const data = await response.json().catch(() => null);

  if (typeof data?.id !== "string") {
    throw emailError(
      "EMAIL_RESULT_INVALID",
      "The email service did not confirm the message."
    );
  }

  return { id: data.id };
}

module.exports = { sendEmail };