// Required indexes must finish before the HTTP listener opens. Independent
// collections can initialize together instead of paying one DB round trip each.
async function initializeIndexes(models) {
  const results = await Promise.allSettled(
    models.map((model) => Promise.resolve().then(() => model.createIndexes())),
  );
  // Wait for every operation before propagating an error so shutdown never
  // disconnects MongoDB while another collection is still creating its indexes.
  const failure = results.find((result) => result.status === "rejected");
  if (failure) throw failure.reason;
}

module.exports = initializeIndexes;
