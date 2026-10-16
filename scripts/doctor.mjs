import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const failures = [];
const files = [];

async function exists(filename) {
  try {
    return (await fs.stat(filename)).isFile();
  } catch {
    return false;
  }
}

async function collect(directory) {
  const entries = await fs.readdir(directory, {
    withFileTypes: true,
  });

  for (const entry of entries) {
    const filename = path.join(
      directory,
      entry.name,
    );

    if (entry.isDirectory()) {
      await collect(filename);
    } else if (
      entry.isFile() &&
      /\.(?:js|jsx|mjs|cjs)$/.test(entry.name)
    ) {
      files.push(filename);
    }
  }
}

async function resolveLocal(filename, specifier) {
  const clean = specifier.split(/[?#]/)[0];

  const target = clean.startsWith("/src/")
    ? path.join(root, clean.slice(1))
    : path.resolve(
        path.dirname(filename),
        clean,
      );

  const candidates = path.extname(target)
    ? [target]
    : [
        target,
        ...[
          ".js",
          ".jsx",
          ".mjs",
          ".cjs",
          ".json",
        ].map((extension) => target + extension),
        ...[
          "index.js",
          "index.jsx",
          "index.mjs",
          "index.cjs",
        ].map((name) => path.join(target, name)),
      ];

  for (const candidate of candidates) {
    if (await exists(candidate)) {
      return true;
    }
  }

  return false;
}

async function main() {
  const [major, minor] = process.versions.node
    .split(".")
    .map(Number);

  if (
    major < 22 ||
    (major === 22 && minor < 12)
  ) {
    failures.push("Use Node 22.12 or newer.");
  }

  for (const name of [
    "index.html",
    "src/main.js",
    "src/App.jsx",
    "vite.config.js",
    "scripts/generate-sitemap.mjs",
  ]) {
    if (!(await exists(path.join(root, name)))) {
      failures.push(`Missing entry point: ${name}`);
    }
  }

  try {
    const manifest = JSON.parse(
      await fs.readFile(
        path.join(root, "package.json"),
        "utf8",
      ),
    );

    if (
      !manifest.scripts?.dev ||
      !manifest.scripts?.build ||
      !manifest.scripts?.test
    ) {
      failures.push(
        "package.json must define dev, build and test scripts.",
      );
    }
  } catch {
    failures.push(
      "package.json is missing or contains invalid JSON.",
    );
  }

  await collect(path.join(root, "src"));

  for (const filename of files) {
    const source = await fs.readFile(
      filename,
      "utf8",
    );

    const specifiers = new Set();

    for (const expression of [
      /\b(?:import|export)\s+(?:[^;"']*?\s+from\s*)?["']([^"']+)["']/g,
      /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    ]) {
      for (const match of source.matchAll(expression)) {
        specifiers.add(match[1]);
      }
    }

    for (const specifier of specifiers) {
      if (
        !specifier.startsWith(".") &&
        !specifier.startsWith("/src/")
      ) {
        continue;
      }

      if (
        !(await resolveLocal(filename, specifier))
      ) {
        failures.push(
          `${path.relative(root, filename)} -> missing ${specifier}`,
        );
      }
    }
  }

  if (failures.length) {
    console.error("Frontend checks failed:");

    for (const failure of failures) {
      console.error(`- ${failure}`);
    }

    process.exitCode = 1;
    return;
  }

  console.log(
    `Checked entry points, package scripts, Node version and local imports in ${files.length} source files.`,
  );

  console.log(
    "No application code was executed and no environment files or external services were accessed.",
  );

  console.log(
    "Run npm test, then npm run build with your deployment environment configured.",
  );
}

main().catch(() => {
  console.error(
    "Frontend checks could not finish. Check the project folders and file permissions.",
  );

  process.exitCode = 1;
});