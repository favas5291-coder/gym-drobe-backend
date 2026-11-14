// Exact official assets reviewed for identity. Sources are suggestions only.
const sources = new Map([
  ["adidas", {
    page: "https://news.adidas.com/football/adidas-extends-partnership-with-uefa-to-2021/s/ad2d3605-2ce9-4af7-92ec-969711079835",
    url: "https://preview.thenewsmarket.com/Previews/ADID/StillAssets/1920x1080/384464.jpg",
  }],
  ["coitonic", {
    page: "https://coitonic.com/",
    url: "https://coitonic.com/cdn/shop/files/coitonic_logo_Black_1.png?v=1753680542",
  }],
]);

function officialLogoSource(key) {
  return sources.get(key) ?? null;
}

async function fetchOfficialLogo(url, fetchImage = fetch) {
  const response = await fetchImage(url, {
    redirect: "error",
    signal: AbortSignal.timeout(5000),
  });
  const mime = response.headers.get("content-type")?.split(";")[0].trim();
  const maxBytes = 512 * 1024;
  if (!response.ok || !["image/png", "image/jpeg", "image/webp"].includes(mime) ||
      Number(response.headers.get("content-length")) > maxBytes || !response.body) {
    await response.body?.cancel();
    throw new Error("Official asset is unavailable.");
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > maxBytes) throw new Error("Official asset is too large.");
    chunks.push(chunk);
  }
  return { mime, base64: Buffer.concat(chunks).toString("base64") };
}

module.exports = { officialLogoSource, fetchOfficialLogo, knownLogoKeys: [...sources.keys()] };
