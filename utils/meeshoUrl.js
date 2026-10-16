// Existing names are retained for compatibility.
// Supports product pages from brands and suppliers.
// This helper validates links without visiting them.

function normalizeMeeshoLink(value) {
  if (value == null || value === "") {
    return "";
  }

  if (typeof value !== "string") {
    throw new Error(
      "Product Website Link must be a URL.",
    );
  }

  const input = value.trim();

  if (!input) {
    return "";
  }

  if (
    input.length > 2000 ||
    /[\u0000-\u0020\u007f\\<>"`]/.test(input)
  ) {
    throw new Error(
      "Use a valid HTTPS product website link without spaces, backslashes or markup.",
    );
  }

  let url;

  try {
    url = new URL(input);
  } catch {
    throw new Error(
      "Enter a valid HTTPS product website link.",
    );
  }

  const host = url.hostname.toLowerCase();
  const labels = host.split(".");

  const publicHostname =
    labels.length >= 2 &&
    labels.every((label) =>
      /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(
        label,
      ),
    ) &&
    /^[a-z][a-z0-9-]*$/i.test(
      labels.at(-1),
    );

  const localHostname =
    [
      "localhost",
      "local",
      "internal",
      "lan",
      "home",
      "test",
      "invalid",
      "example",
      "onion",
    ].some(
      (suffix) =>
        host === suffix ||
        host.endsWith(`.${suffix}`),
    ) ||
    host === "home.arpa" ||
    host.endsWith(".home.arpa");

  if (
    !/^https:\/\//i.test(input) ||
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    !publicHostname ||
    localHostname ||
    url.pathname === "/"
  ) {
    throw new Error(
      "Use a full HTTPS product link on a public brand or supplier website, without login credentials, an IP address or a custom port.",
    );
  }

  if (url.href.length > 2000) {
    throw new Error(
      "Product Website Link cannot exceed 2,000 characters.",
    );
  }

  return url.href;
}

function safeMeeshoLink(value) {
  try {
    return normalizeMeeshoLink(value);
  } catch {
    return "";
  }
}

module.exports = {
  normalizeMeeshoLink,
  safeMeeshoLink,
};