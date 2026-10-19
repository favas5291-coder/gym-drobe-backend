const fs = require("node:fs");
const path = require("node:path");

const {
  spawnSync,
} = require("node:child_process");

const root = process.cwd();
const files = [];
const missing = [];

function collect(directory) {
  if (!fs.existsSync(directory)) {
    return;
  }

  const entries = fs.readdirSync(
    directory,
    { withFileTypes: true },
  );

  for (const entry of entries) {
    const filename = path.join(
      directory,
      entry.name,
    );

    if (entry.isDirectory()) {
      collect(filename);
    } else if (
      entry.isFile() &&
      /\.(?:js|cjs)$/.test(entry.name)
    ) {
      files.push(filename);
    }
  }
}

if (
  !fs.existsSync(
    path.join(root, "server.js"),
  )
) {
  console.error(
    "Run this command from your backend folder containing server.js.",
  );

  process.exit(1);
}

files.push(
  path.join(root, "server.js"),
);

for (const folder of [
  "config",
  "models",
  "middleware",
  "controllers",
  "routes",
  "utils",
]) {
  collect(
    path.join(root, folder),
  );
}

for (const filename of files) {
  const source = fs.readFileSync(
    filename,
    "utf8",
  );

  const relative = path.relative(
    root,
    filename,
  );

  if (!source.trim()) {
    missing.push(
      `${relative} -> file is empty`,
    );

    continue;
  }

  const syntax = spawnSync(
    process.execPath,
    ["--check", filename],
    {
      encoding: "utf8",
      timeout: 10000,
    },
  );

  if (
    syntax.error ||
    syntax.status !== 0
  ) {
    missing.push(
      `${relative} -> JavaScript syntax is invalid; run node --check on this file`,
    );
  }

  const imports = source.matchAll(
    /\brequire\s*\(\s*["'](\.[^"']+)["']\s*\)/g,
  );

  for (const match of imports) {
    try {
      require.resolve(
        path.resolve(
          path.dirname(filename),
          match[1],
        ),
      );
    } catch {
      missing.push(
        `${relative} -> ${match[1]}`,
      );
    }
  }
}

if (missing.length) {
  console.error(
    "Backend file checks failed:",
  );

  for (
    const message of
    [...new Set(missing)].sort()
  ) {
    console.error(message);
  }

  process.exitCode = 1;
} else {
  console.log(
    `Checked ${files.length} backend files. No empty files, syntax errors or missing local imports found.`,
  );

  console.log(
    "Next: npm run dev",
  );
}

console.log(
  "This check does not execute your application, read .env, or connect to MongoDB or Razorpay.",
);