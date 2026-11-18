const { quoteParcel } = require("../utils/logistics/shiprocketRates");

async function main() {
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
    if (input.length > 4096) throw new Error("Expected one parcel.");
  }
  let parcel;
  try { parcel = JSON.parse(input); } catch { throw new Error("Expected one parcel in JSON."); }
  console.log(JSON.stringify({ currency: "INR", quotes: await quoteParcel(parcel) }, null, 2));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
