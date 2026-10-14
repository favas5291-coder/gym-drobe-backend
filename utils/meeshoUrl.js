function normalizeMeeshoLink(value) {
  if (value == null || value === "") return "";
  if (typeof value !== "string") throw new Error("Meesho Product Link must be a URL.");
  const input = value.trim();
  if (!input) return "";
  if (input.length > 2000 || /[\u0000-\u0020\u007f\\]/.test(input)) throw new Error("Use a valid HTTPS Meesho listing link without spaces or backslashes.");
  let url;
  try { url = new URL(input); } catch { throw new Error("Enter a valid HTTPS Meesho listing link."); }
  if (url.protocol !== "https:" ||
      !["meesho.com", "www.meesho.com"].includes(url.hostname) ||
      url.username || url.password || url.port || url.pathname === "/") {
    throw new Error("Use an HTTPS product link on meesho.com or www.meesho.com, without login credentials or a custom port.");
  }
  if (url.href.length > 2000) throw new Error("Meesho Product Link cannot exceed 2,000 characters.");
  return url.href;
}
function safeMeeshoLink(value) {
  try { return normalizeMeeshoLink(value); } catch { return ""; }
}
module.exports = { normalizeMeeshoLink, safeMeeshoLink };
