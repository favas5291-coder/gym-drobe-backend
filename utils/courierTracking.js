export function normalizeCourierUrl(value) {
  if (value == null || value === "") {
    return "";
  }

  if (typeof value !== "string") {
    throw new Error(
      "Enter a valid HTTPS courier tracking link.",
    );
  }

  const input = value.trim();

  if (!input) {
    return "";
  }

  if (
    input.length > 2000 ||
    /[\u0000-\u0020\u007f\\]/.test(input)
  ) {
    throw new Error(
      "Use a courier link without spaces or backslashes.",
    );
  }

  let url;

  try {
    url = new URL(input);
  } catch {
    throw new Error(
      "Enter a valid HTTPS courier tracking link.",
    );
  }

  const publicHostname =
    /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

  const restrictedHostname =
    /\.(?:localhost|local|internal|lan|test|invalid|example|onion)$/i;

  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    !publicHostname.test(url.hostname) ||
    restrictedHostname.test(url.hostname) ||
    url.href.length > 2000
  ) {
    throw new Error(
      "Use an HTTPS tracking link on a public courier website.",
    );
  }

  return url.href;
}

export function safeCourierUrl(value) {
  try {
    return normalizeCourierUrl(value);
  } catch {
    return "";
  }
}