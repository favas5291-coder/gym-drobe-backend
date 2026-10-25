const dns = require("node:dns");
const { isIP } = require("node:net");
const mongoose = require("mongoose");

let dnsConfigured = false;

function configureMongoDns() {
  if (dnsConfigured) return;

  const configured = String(
    process.env.MONGO_DNS_SERVERS || "",
  ).trim();

  if (!configured) return;

  const servers = configured
    .split(",")
    .map((value) => value.trim());

  if (
    servers.some((value) => isIP(value) === 0)
  ) {
    throw new Error(
      "MONGO_DNS_SERVERS must contain comma-separated DNS IP addresses.",
    );
  }

  // Apply the optional override before the first MongoDB DNS lookup.
  // Leave the resolver unchanged when no override is configured.
  dns.setServers(servers);
  dnsConfigured = true;
}

const connectDB = async () => {
  const mongoURI = process.env.MONGO_URI;

  if (!mongoURI) {
    throw new Error(
      "MONGO_URI is missing from backend/.env",
    );
  }

  try {
    configureMongoDns();

    const conn = await mongoose.connect(mongoURI, {
      serverSelectionTimeoutMS: 10000,
    });

    console.log(
      `✅ MongoDB Connected: ${conn.connection.host}`,
    );

    return conn;
  } catch (error) {
    console.error("❌ MongoDB connection failed:");
    console.error(error.message);

    throw error;
  }
};

module.exports = connectDB;