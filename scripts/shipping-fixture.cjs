"use strict";
const { openShippingFixture } = require("../utils/marketplace/shippingFixture");

async function run([command, id, ...args]) {
  const commands = ["book", "lose-response", "recover", "inspect", "track"];
  if (!commands.includes(command) || !id || args.length !== (command === "track" ? 3 : 0)) {
    throw new Error("Usage: shipping-fixture.cjs book|lose-response|recover|inspect <fulfilmentId>, or track <fulfilmentId> <reference> <stage> <ISO timestamp>.");
  }
  const fixture = await openShippingFixture();
  try {
    let result;
    if (command === "track") result = await fixture.track(id, ...args);
    else if (command === "inspect") result = await fixture.inspect(id);
    else result = await fixture.book(id, { recover: command === "recover", loseResponse: command === "lose-response" });
    console.log(JSON.stringify(result, null, 2));
  } finally { await fixture.close(); }
}

run(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
