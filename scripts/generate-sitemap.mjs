import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(scriptPath), "..");
const publicDirectory = path.join(root, "public");

function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function validateSite(value) {
  let site;

  try {
    site = new URL(String(value || "").trim());
  } catch {
    throw new Error("Set VITE_SITE_URL to your public website URL.");
  }

  if (
    site.protocol !== "https:" ||
    site.username ||
    site.password ||
    site.pathname !== "/" ||
    site.search ||
    site.hash ||
    ["localhost", "127.0.0.1", "[::1]"].includes(site.hostname)
  ) {
    throw new Error(
      "VITE_SITE_URL must be a public HTTPS origin without a path.",
    );
  }

  return site.origin;
}

function validateApi(value) {
  let api;

  try {
    api = new URL(String(value || "").trim());
  } catch {
    throw new Error("Set VITE_API_URL to your backend API URL.");
  }

  if (
    !["http:", "https:"].includes(api.protocol) ||
    api.username ||
    api.password ||
    api.search ||
    api.hash ||
    api.pathname.replace(/\/+$/, "") !== "/api"
  ) {
    throw new Error("VITE_API_URL must end in /api.");
  }

  return api.href.replace(/\/+$/, "");
}

export function buildSitemap(origin, products) {
  const siteOrigin = validateSite(origin);

  if (!Array.isArray(products)) {
    throw new Error("The product catalog must be an array.");
  }

  const routes = new Set([
    "/",
    "/shop",
    "/offers",
    "/help",
  ]);

  for (const product of products) {
    if (!product || typeof product !== "object") {
      throw new Error("The catalog contains an invalid product.");
    }

    if (product.isActive === false) {
      continue;
    }

    const id = product.id ?? product._id;

    if (
      !["string", "number"].includes(typeof id) ||
      !String(id).trim()
    ) {
      throw new Error(
        "A catalog product is missing its canonical ID.",
      );
    }

    routes.add(
      `/product/${encodeURIComponent(String(id))}`,
    );
  }

  if (routes.size > 50000) {
    throw new Error(
      "The catalog exceeds 50,000 URLs and needs a sitemap index.",
    );
  }

  const entries = [...routes].map((route) => {
    const url = `${siteOrigin}${route}`;

    return `  <url><loc>${escapeXml(url)}</loc></url>`;
  });

  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...entries,
    "</urlset>",
    "",
  ].join("\n");

  if (Buffer.byteLength(xml, "utf8") > 50 * 1024 * 1024) {
    throw new Error(
      "The sitemap exceeds 50 MB and needs a sitemap index.",
    );
  }

  return xml;
}

async function loadEnvironment() {
  // Existing deployment variables take precedence.
  // Local overrides take precedence over the base .env file.
  for (const filename of [".env.local", ".env"]) {
    try {
      process.loadEnvFile(path.join(root, filename));
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }
  }
}

async function writeAtomically(filename, contents) {
  const target = path.join(publicDirectory, filename);
  const temporary = `${target}.${process.pid}.tmp`;

  try {
    await fs.writeFile(temporary, contents, "utf8");
    await fs.rename(temporary, target);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

async function main() {
  await loadEnvironment();

  const origin = validateSite(process.env.VITE_SITE_URL);
  const api = validateApi(process.env.VITE_API_URL);

  const response = await fetch(`${api}/products`, {
    signal: AbortSignal.timeout(60000),
    headers: { Accept: "application/json" },
    cache: "no-store",
    redirect: "error",
  });

  if (!response.ok) {
    throw new Error(
      `Product API returned HTTP ${response.status}. Check backend availability.`,
    );
  }

  const data = await response.json();

  if (
    !data ||
    data.success === false ||
    !Array.isArray(data.products)
  ) {
    throw new Error("Unexpected public product API response.");
  }

  // Refuse a response that explicitly reports more pages.
  if (
    Number(data.totalPages) > 1 ||
    Number(data.pagination?.totalPages) > 1 ||
    data.hasMore === true ||
    data.pagination?.hasMore === true
  ) {
    throw new Error(
      "The product API is paginated. Fetch all pages before generating the sitemap.",
    );
  }

  const reportedTotal =
    data.totalProducts ??
    data.pagination?.totalProducts ??
    data.total ??
    data.pagination?.total;

  if (
    reportedTotal != null &&
    Number.isFinite(Number(reportedTotal)) &&
    Number(reportedTotal) > data.products.length
  ) {
    throw new Error(
      "The API returned an incomplete catalog. Sitemap generation stopped.",
    );
  }

  // Validate everything before changing output files.
  const xml = buildSitemap(origin, data.products);

  const robots = [
    "User-agent: *",
    "Allow: /",
    "Disallow: /api/",
    "",
    `Sitemap: ${origin}/sitemap.xml`,
    "",
  ].join("\n");

  await fs.mkdir(publicDirectory, { recursive: true });

  await writeAtomically("sitemap.xml", xml);
  await writeAtomically("robots.txt", robots);

  console.log("Generated public/sitemap.xml and public/robots.txt.");
  console.log(`Canonical website: ${origin}`);
  console.log("Run npm run build to include these files in deployment.");
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === scriptPath
) {
  main().catch((error) => {
    // Avoid printing API URLs, credentials or response bodies.
    const message =
      error instanceof SyntaxError
        ? "The product API returned invalid JSON."
        : error instanceof TypeError
          ? "The request failed. Check API configuration and connectivity."
          : error.name === "TimeoutError"
            ? "The product API timed out. Check backend availability and retry."
            : error.message || "An unexpected error occurred.";

    console.error(`Sitemap generation failed: ${message}`);
    process.exitCode = 1;
  });
}