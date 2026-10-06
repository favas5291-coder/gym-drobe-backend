import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

try {
  process.loadEnvFile(path.join(root, ".env"));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

export function buildSitemap(origin, products) {
  const routes = new Set([
    "/",
    "/shop",
    "/offers",
    "/help",
  ]);

  for (const product of products) {
    if (product.isActive === false) continue;

    const id = product.id ?? product._id;

    if (id == null || !String(id).trim()) {
      throw new Error(
        "A catalogue product is missing its canonical ID.",
      );
    }

    routes.add(
      `/product/${encodeURIComponent(String(id))}`,
    );
  }

  if (routes.size > 50000) {
    throw new Error(
      "The catalogue needs a sitemap index.",
    );
  }

  const escape = (value) =>
    value
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&apos;");

  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    [...routes]
      .map(
        (route) =>
          `  <url><loc>${escape(
            new URL(route, origin).href,
          )}</loc></url>`,
      )
      .join("\n") +
    "\n</urlset>\n"
  );
}

async function main() {
  const site = new URL(
    process.env.VITE_SITE_URL || "",
  );

  if (
    site.protocol !== "https:" ||
    site.username ||
    site.password ||
    site.pathname !== "/" ||
    site.search ||
    site.hash ||
    site.hostname === "localhost" ||
    site.hostname === "127.0.0.1"
  ) {
    throw new Error(
      "VITE_SITE_URL must be your public HTTPS origin, without a path.",
    );
  }

  const api = new URL(
    process.env.VITE_API_URL || "",
  );

  if (
    !["http:", "https:"].includes(api.protocol) ||
    api.username ||
    api.password ||
    api.search ||
    api.hash
  ) {
    throw new Error(
      "VITE_API_URL must be the API base URL, ending in /api.",
    );
  }

  const response = await fetch(
    `${api.href.replace(/\/+$/, "")}/products`,
    {
      signal: AbortSignal.timeout(30000),
      headers: {
        Accept: "application/json",
      },
    },
  );

  if (!response.ok) {
    throw new Error(
      "The public product API could not be loaded. Existing sitemap files were not changed.",
    );
  }

  const data = await response.json();

  if (
    data.success === false ||
    !Array.isArray(data.products)
  ) {
    throw new Error(
      "Unexpected product API response. Existing sitemap files were not changed.",
    );
  }

  const xml = buildSitemap(
    site.origin,
    data.products,
  );

  await fs.writeFile(
    path.join(root, "public/sitemap.xml"),
    xml,
  );

  await fs.writeFile(
    path.join(root, "public/robots.txt"),
    `User-agent: *\nAllow: /\nDisallow: /api/\n\nSitemap: ${site.origin}/sitemap.xml\n`,
  );

  console.log(
    `Sitemap generated using ${data.products.length} catalogue products. Run npm run build to include it in dist.`,
  );
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) ===
    fileURLToPath(import.meta.url)
) {
  main().catch(() => {
    console.error(
      "Sitemap generation failed. Check VITE_SITE_URL, VITE_API_URL and backend availability. No fallback or sample products were used.",
    );

    process.exitCode = 1;
  });
}