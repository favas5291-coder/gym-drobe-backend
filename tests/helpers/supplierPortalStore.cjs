"use strict";

const real = {
  ...require("../../models/SupplierPortal"),
  Supplier: require("../../models/Supplier"),
};

const copy = (value) =>
  JSON.parse(JSON.stringify(value));

const pathValue = (value, path) =>
  path.split(".").reduce(
    (current, key) => current?.[key],
    value,
  );

const matches = (row, filter) =>
  Object.entries(filter).every(([key, value]) =>
    value == null
      ? pathValue(row, key) == null
      : String(pathValue(row, key)) === String(value),
  );

// This adapter exercises production services and actual Mongoose validation.
// Transactions use serializable snapshots for deterministic fault injection;
// a staging replica-set test is still required before enabling the portal.
function memoryStore() {
  const stores = Object.fromEntries(
    ["Workspace", "Agreement", "Event", "Supplier"].map(
      (key) => [key, new Map()],
    ),
  );

  const models = {};
  let failEvent = false;

  for (const [key, store] of Object.entries(stores)) {
    function hydrate(data, isNew) {
      const doc = new real[key](copy(data));

      doc.$isNew = isNew;

      doc.save = async () => {
        await doc.validate();

        if (key === "Event" && failEvent) {
          throw new Error("Injected audit failure");
        }

        const previous = store.get(String(doc._id));

        if (
          !isNew &&
          previous?.__v !== (doc.__v || 0)
        ) {
          throw Object.assign(
            new Error("Concurrent modification"),
            {
              name: "VersionError",
            },
          );
        }

        const value = copy(
          doc.toObject({
            transform: false,
          }),
        );

        const duplicates = [...store.values()].filter(
          (row) => row._id !== value._id,
        );

        const duplicate =
          key === "Workspace"
            ? duplicates.some(
                (row) =>
                  row.supplier === value.supplier ||
                  (
                    value.ownerUser &&
                    row.ownerUser === value.ownerUser
                  ),
              )
            : key === "Agreement"
              ? duplicates.some(
                  (row) =>
                    row.workspace === value.workspace &&
                    row.version === value.version,
                )
              : key === "Event"
                ? duplicates.some(
                    (row) =>
                      row.workspace === value.workspace &&
                      row.revision === value.revision,
                  )
                : false;

        if (duplicate) {
          throw Object.assign(
            new Error("Duplicate index"),
            {
              code: 11000,
            },
          );
        }

        doc.__v = isNew
          ? 0
          : (doc.__v || 0) + 1;

        doc.createdAt ||= new Date(
          "2026-10-24T12:00:00Z",
        );

        doc.updatedAt = new Date(
          "2026-10-24T12:00:00Z",
        );

        store.set(
          String(doc._id),
          copy(
            doc.toObject({
              transform: false,
            }),
          ),
        );

        isNew = false;
        doc.$isNew = false;

        return doc;
      };

      return doc;
    }

    function query(filter, many, count = false) {
      let skip = 0;
      let limit = Infinity;
      let sort;

      const result = {
        session() {
          return this;
        },

        select() {
          return this;
        },

        maxTimeMS() {
          return this;
        },

        sort(value) {
          sort = value;
          return this;
        },

        skip(value) {
          skip = value;
          return this;
        },

        limit(value) {
          limit = value;
          return this;
        },

        then(resolve, reject) {
          return Promise.resolve()
            .then(() => {
              let rows = [...store.values()].filter(
                (row) => matches(row, filter),
              );

              if (sort) {
                rows.sort((a, b) => {
                  for (
                    const [field, direction]
                    of Object.entries(sort)
                  ) {
                    if (a[field] !== b[field]) {
                      return (
                        (a[field] > b[field] ? 1 : -1) *
                        direction
                      );
                    }
                  }

                  return 0;
                });
              }

              if (count) {
                return rows.length;
              }

              rows = rows
                .slice(skip, skip + limit)
                .map((row) => hydrate(row, false));

              return many
                ? rows
                : rows[0] || null;
            })
            .then(resolve, reject);
        },
      };

      return result;
    }

    const Model = function (values) {
      return hydrate(values, true);
    };

    Model.findOne = (filter) =>
      query(filter, false);

    Model.findById = (id) =>
      query({ _id: id }, false);

    Model.find = (filter) =>
      query(filter, true);

    Model.countDocuments = (filter) =>
      query(filter, true, true);

    Model.updateOne = async (filter, update) => {
      const row = [...store.values()].find(
        (value) => matches(value, filter),
      );

      if (!row) {
        return {
          modifiedCount: 0,
        };
      }

      Object.assign(
        row,
        copy(update.$set),
      );

      return {
        modifiedCount: 1,
      };
    };

    models[key] = Model;
  }

  let tail = Promise.resolve();

  const transaction = (fn) => {
    const next = tail.then(async () => {
      const snapshots = Object.fromEntries(
        Object.entries(stores).map(
          ([key, store]) => [
            key,
            copy([...store]),
          ],
        ),
      );

      try {
        return await fn({});
      } catch (error) {
        for (
          const [key, rows]
          of Object.entries(snapshots)
        ) {
          stores[key].clear();

          for (const [id, value] of rows) {
            stores[key].set(id, value);
          }
        }

        throw error;
      }
    });

    tail = next.catch(() => {});

    return next;
  };

  return {
    ...models,
    transaction,
    stores,

    failAudit(value = true) {
      failEvent = value;
    },
  };
}

module.exports = {
  memoryStore,
};