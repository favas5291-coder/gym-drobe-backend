"use strict";

const Order = require("../../models/Order");
const { Fulfilment } = require("../../models/Marketplace");
const { reportWindow, dailyOperations } = require("../../utils/dailyOperations");

module.exports = async function getDailyOperations(req, res) {
  let window;
  try {
    window = reportWindow(req.query.date, req.query.source);
  } catch (error) {
    return res.status(400).json({ success: false, message: error.message });
  }
  try {
    const report = await dailyOperations(Order, Fulfilment.collection.name, window);
    return res.json({ success: true, report });
  } catch (error) {
    console.error("Daily operations query failed", error.codeName || error.name);
    return res.status(503).json({ success: false, message: "Daily report unavailable. Check the report index, database health and daily volume." });
  }
};
