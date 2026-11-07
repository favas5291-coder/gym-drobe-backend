"use strict";

const { readFileSync } = require("node:fs");
const { inspectStagingConfiguration } = require("../utils/stagingReadiness");

function main(argv = process.argv.slice(2), inherited = process.env) {
  if (argv.length === 1 && argv[0] === "--help") {
    console.log("Usage: npm run staging:check -- [--staging-env .env.staging]");
    console.log("Checks configuration only. Does not start the server or contact external services. Existing environment values take precedence over the selected file.");
    return 0;
  }
  if (argv.length && (argv.length !== 2 || argv[0] !== "--staging-env" || !argv[1] || argv[1].startsWith("--"))) {
    console.log(JSON.stringify({ status: "blocked", code: "STAGING_CHECK_ARGUMENTS_INVALID" }));
    return 1;
  }
  let file = {};
  if (argv.length) {
    try {
      file = require("dotenv").parse(readFileSync(argv[1]));
    } catch {
      console.log(JSON.stringify({ status: "blocked", code: "STAGING_ENV_FILE_UNAVAILABLE" }));
      return 1;
    }
  }
  // Match dotenv.config() precedence. A file cannot silently override a live
  // key or outbound credential already supplied by the hosting environment.
  const report = inspectStagingConfiguration({ ...file, ...inherited });
  console.log(JSON.stringify(report, null, 2));
  return report.status === "configuration-passed" ? 0 : 1;
}

if (require.main === module) {
  try {
    process.exitCode = main();
  } catch {
    // Never print unexpected parser errors or supplied command arguments.
    console.log(JSON.stringify({ status: "blocked", code: "STAGING_CHECK_UNAVAILABLE" }));
    process.exitCode = 1;
  }
}

module.exports = { main };
