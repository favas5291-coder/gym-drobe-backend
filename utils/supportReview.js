// Call only after validating the admin's review queue name.
function supportReviewFilter(review, checkedAt) {
  const filter = {};
  filter.status = { $in: ["open", "waiting"] };
  if (review === "first-reply") {
    filter.createdAt = { $type: "date", $lte: new Date(+checkedAt - 48 * 60 * 60 * 1000) };
    filter["messages.by"] = { $ne: "store" };
  } else {
    // Narrow candidates with an ordinary range, then apply the actual calendar deadline.
    filter.createdAt = { $type: "date", $lte: new Date(+checkedAt - 28 * 86400000) };
    filter.$expr = {
      $lte: [
        { $dateAdd: { startDate: "$createdAt", unit: "month", amount: 1, timezone: "Asia/Kolkata" } },
        checkedAt,
      ],
    };
  }
  return filter;
}

module.exports = { supportReviewFilter };
