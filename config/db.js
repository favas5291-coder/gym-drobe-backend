const mongoose = require("mongoose");

const connectDB = async () => {
  const mongoURI = process.env.MONGO_URI;

  if (!mongoURI) {
    throw new Error(
      "MONGO_URI is missing from backend/.env"
    );
  }

  try {
    const conn = await mongoose.connect(mongoURI, {
      serverSelectionTimeoutMS: 10000,
    });

    console.log(
      `✅ MongoDB Connected: ${conn.connection.host}`
    );

    return conn;
  } catch (error) {
    console.error("❌ MongoDB connection failed:");
    console.error(error.message);

    throw error;
  }
};

module.exports = connectDB;