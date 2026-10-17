// Validate video links without downloading their contents.
function normalizeProductVideo(value) {
  if (value == null || value === "") {
    return "";
  }

  if (typeof value !== "string") {
    throw new Error(
      "Product video must be a URL."
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
      "Use a valid HTTPS product video link without spaces or backslashes."
    );
  }

  let url;

  try {
    url = new URL(input);
  } catch {
    throw new Error(
      "Enter a valid HTTPS product video link."
    );
  }

  const host = url.hostname.toLowerCase();
  const labels = host.split(".");

  const publicHost =
    labels.length >= 2 &&
    labels.every((label) =>
      /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(
        label
      )
    ) &&
    /^[a-z][a-z0-9-]*$/i.test(labels.at(-1));

  const localHost =
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
        host.endsWith(`.${suffix}`)
    ) ||
    host === "home.arpa" ||
    host.endsWith(".home.arpa");

  if (
    !/^https:\/\//i.test(input) ||
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    !publicHost ||
    localHost
  ) {
    throw new Error(
      "Use an HTTPS video link on a public website, without login credentials, an IP address or a custom port."
    );
  }

  const youtubeHosts = [
    "youtube.com",
    "www.youtube.com",
    "m.youtube.com",
    "youtube-nocookie.com",
    "www.youtube-nocookie.com",
    "youtu.be",
    "www.youtu.be",
  ];

  if (youtubeHosts.includes(host)) {
    const segments = url.pathname
      .split("/")
      .filter(Boolean);

    const id =
      host === "youtu.be" ||
      host === "www.youtu.be"
        ? segments.length === 1
          ? segments[0]
          : ""
        : url.pathname === "/watch"
          ? url.searchParams.get("v")
          : segments.length === 2 &&
              ["shorts", "embed"].includes(
                segments[0]
              )
            ? segments[1]
            : "";

    if (
      !/^[a-zA-Z0-9_-]{11}$/.test(id || "")
    ) {
      throw new Error(
        "Paste a YouTube video, Shorts or share link, rather than a channel or playlist."
      );
    }

    return (
      "https://www.youtube.com/watch?v=" + id
    );
  }

  if (!/\.(mp4|webm)$/i.test(url.pathname)) {
    throw new Error(
      "Use a direct .mp4 or .webm video link, or a YouTube video link."
    );
  }

  url.hash = "";

  if (url.href.length > 2000) {
    throw new Error(
      "Product video links cannot exceed 2,000 characters."
    );
  }

  return url.href;
}

function productVideo(value) {
  try {
    const url = normalizeProductVideo(value);

    if (!url) {
      return null;
    }

    const parsed = new URL(url);

    if (
      parsed.hostname === "www.youtube.com"
    ) {
      return {
        kind: "youtube",

        url,

        src:
          "https://www.youtube-nocookie.com/embed/" +
          parsed.searchParams.get("v") +
          "?rel=0",
      };
    }

    return {
      kind: "file",
      url,
      src: url,
    };
  } catch {
    return null;
  }
}

module.exports = {
  normalizeProductVideo,
  productVideo,
};