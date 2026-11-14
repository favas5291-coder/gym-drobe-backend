function brandName(value) {
  return typeof value === "string" ? value.normalize("NFC").trim().replace(/\s+/gu, " ") : "";
}

function brandKey(value) {
  return brandName(value).toLowerCase();
}

module.exports = { brandName, brandKey };
