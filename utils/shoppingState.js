"use strict";

const crypto = require("node:crypto");
const MAX_ROWS = 200, MAX_WISHES = 500, MAX_QUANTITY = 1000000;
const OPERATION_AGE_MS = 7 * 86400000;

function fail(status, code, message, extra = {}) {
  throw Object.assign(new Error(message), { status, code, shopping: true, ...extra });
}
function object(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some(key => !keys.includes(key))) {
    fail(400, "SHOPPING_INPUT_INVALID", "The saved shopping change could not be read.");
  }
}
function text(value, maximum, optional = false) {
  if (optional && (value == null || value === "")) return null;
  if (typeof value !== "string" || !value.trim() || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) {
    fail(400, "SHOPPING_INPUT_INVALID", "A product or option identifier is invalid.");
  }
  return value;
}
function productId(value) {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) value = String(value);
  const id = text(value, 100);
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) fail(400, "SHOPPING_INPUT_INVALID", "A product identifier is invalid.");
  return /^[a-f0-9]{24}$/i.test(id) ? id.toLowerCase() : id;
}
function whole(value, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail(400, "SHOPPING_INPUT_INVALID", "A shopping quantity or revision is invalid.");
  }
  return value;
}
function kit(value) {
  if (value == null) return null;
  object(value, ["id", "kitId", "version", "name", "level", "slotKey"]);
  const result = {
    id: text(value.id, 80), kitId: text(value.kitId, 24).toLowerCase(),
    version: whole(value.version, 0, Number.MAX_SAFE_INTEGER), name: text(value.name, 200),
    level: text(value.level, 20), slotKey: text(value.slotKey, 60),
  };
  if (!/^[a-zA-Z0-9_-]{8,80}$/.test(result.id) || !/^[a-f0-9]{24}$/.test(result.kitId) ||
      result.name.length < 2 || !["beginner", "intermediate", "advanced"].includes(result.level) ||
      !/^[a-z][a-z0-9-]{0,59}$/.test(result.slotKey)) {
    fail(400, "SHOPPING_INPUT_INVALID", "The kit choices need to be reviewed in the kit builder.");
  }
  return result;
}
function line(value, includeQuantity = false) {
  object(value, ["productId", "selectedSize", "selectedColor", "kitGroup", ...(includeQuantity ? ["quantity"] : [])]);
  return {
    productId: productId(value.productId),
    selectedSize: text(value.selectedSize, 50, true),
    selectedColor: text(value.selectedColor, 80, true),
    ...(value.kitGroup != null ? { kitGroup: kit(value.kitGroup) } : {}),
    ...(includeQuantity ? { quantity: whole(value.quantity, 1, MAX_QUANTITY) } : {}),
  };
}
function key(row) {
  return JSON.stringify([row.productId, row.selectedSize, row.selectedColor,
    row.kitGroup?.id || null, row.kitGroup?.slotKey || null]);
}
function selection(value) {
  object(value, ["cart", "wishlist"]);
  if (!Array.isArray(value.cart) || value.cart.length > MAX_ROWS ||
      !Array.isArray(value.wishlist) || value.wishlist.length > MAX_WISHES) {
    fail(400, "SHOPPING_LIMIT_REACHED", "The shopping list is too large to save.");
  }
  const cart = value.cart.map(row => line(row, true));
  if (new Set(cart.map(key)).size !== cart.length) {
    fail(400, "SHOPPING_INPUT_INVALID", "Combine duplicate product selections before saving.");
  }
  return { cart, wishlist: [...new Set(value.wishlist.map(productId))] };
}
function operation(value) {
  object(value, ["id", "issuedAt", "baseRevision", "changes"]);
  const id = text(value.id, 100);
  if (!/^[a-zA-Z0-9_-]{16,100}$/.test(id)) fail(400, "SHOPPING_INPUT_INVALID", "The shopping change identifier is invalid.");
  const baseRevision = whole(value.baseRevision, 0, Number.MAX_SAFE_INTEGER);
  const issuedAt = whole(value.issuedAt, 0, Number.MAX_SAFE_INTEGER);
  if (!Array.isArray(value.changes) || !value.changes.length || value.changes.length > 400) {
    fail(400, "SHOPPING_INPUT_INVALID", "The shopping change is empty or too large.");
  }
  const changes = value.changes.map(change => {
    if (change?.type === "adjust") {
      object(change, ["type", "line", "delta"]);
      const delta = whole(change.delta, -MAX_QUANTITY, MAX_QUANTITY);
      if (!delta) fail(400, "SHOPPING_INPUT_INVALID", "Quantity changes must be nonzero.");
      return { type: "adjust", line: line(change.line), delta };
    }
    if (change?.type === "remove") {
      object(change, ["type", "line"]);
      return { type: "remove", line: line(change.line) };
    }
    if (change?.type === "wish") {
      object(change, ["type", "productId", "saved"]);
      if (typeof change.saved !== "boolean") fail(400, "SHOPPING_INPUT_INVALID", "Choose whether to save this product.");
      return { type: "wish", productId: productId(change.productId), saved: change.saved };
    }
    if (["seed", "replace"].includes(change?.type)) {
      object(change, ["type", "selection", ...(change.type === "replace" ? ["confirmed"] : [])]);
      if (change.type === "replace" && change.confirmed !== true) {
        fail(400, "SHOPPING_REVIEW_REQUIRED", "Confirm replacing the account shopping lists first.");
      }
      return { type: change.type, selection: selection(change.selection), ...(change.type === "replace" ? { confirmed: true } : {}) };
    }
    fail(400, "SHOPPING_INPUT_INVALID", "The shopping change is not supported.");
  });
  const fingerprint = crypto.createHash("sha256").update(JSON.stringify(changes)).digest("hex");
  return { id, issuedAt, baseRevision, changes, fingerprint };
}
function applyChanges(current, changes) {
  let cart = new Map(current.cart.map(row => [key(row), { ...row }]));
  let wishlist = new Set(current.wishlist);
  for (const change of changes) {
    if (change.type === "replace") {
      cart = new Map(change.selection.cart.map(row => [key(row), { ...row }]));
      wishlist = new Set(change.selection.wishlist);
    } else if (change.type === "seed") {
      for (const row of change.selection.cart) {
        const previous = cart.get(key(row));
        cart.set(key(row), { ...row, quantity: Math.max(previous?.quantity || 0, row.quantity) });
      }
      for (const id of change.selection.wishlist) wishlist.add(id);
    } else if (change.type === "adjust") {
      const id = key(change.line), previous = cart.get(id);
      const quantity = (previous?.quantity || 0) + change.delta;
      if (!Number.isSafeInteger(quantity) || quantity > MAX_QUANTITY) {
        fail(409, "SHOPPING_LIMIT_REACHED", "Review this product's quantity before saving across devices.");
      }
      if (quantity <= 0) cart.delete(id);
      else cart.set(id, { ...change.line, quantity });
    } else if (change.type === "remove") cart.delete(key(change.line));
    else if (change.type === "wish") {
      if (change.saved) wishlist.add(change.productId);
      else wishlist.delete(change.productId);
    }
  }
  const next = { cart: [...cart.values()], wishlist: [...wishlist] };
  if (next.cart.length > MAX_ROWS || next.wishlist.length > MAX_WISHES) {
    fail(409, "SHOPPING_LIMIT_REACHED", "Review the size of your shopping lists before saving.");
  }
  return next;
}
function publicState(state) {
  return { version: 1, revision: state?.revision || 0,
    cart: state?.cart || [], wishlist: state?.wishlist || [],
    updatedAt: state?.updatedAt ? new Date(state.updatedAt).toISOString() : null };
}
function owner(value) {
  const id = String(value || "");
  if (!/^[a-f0-9]{24}$/i.test(id)) fail(401, "SHOPPING_AUTH_REQUIRED", "Sign in to save your shopping lists.");
  return id.toLowerCase();
}
function createShoppingService({ store, now = Date.now }) {
  return {
    async read(user) { return publicState(await store.read(owner(user))); },
    async mutate(user, input) {
      user = owner(user);
      const op = operation(input), time = now();
      return store.transaction(user, async tx => {
        if (!await tx.touchAccount()) fail(401, "SHOPPING_AUTH_REQUIRED", "Your account session has ended.");
        const current = publicState(await tx.read());
        const receipt = await tx.receipt(op.id);
        if (receipt) {
          if (receipt.fingerprint !== op.fingerprint) fail(409, "SHOPPING_OPERATION_CONFLICT", "This saved change needs review.");
          return { state: current, duplicate: true };
        }
        if (time - op.issuedAt > OPERATION_AGE_MS || op.issuedAt - time > 300000) {
          fail(409, "SHOPPING_REVIEW_REQUIRED", "These older offline changes need review before replacing your saved lists.", { state: current });
        }
        if (op.baseRevision !== current.revision) {
          fail(409, "SHOPPING_REVISION_CONFLICT", "Your lists changed on another device.", { state: current });
        }
        if (!Number.isSafeInteger(current.revision + 1)) fail(409, "SHOPPING_REVIEW_REQUIRED", "Your saved lists need support review.");
        const next = { ...applyChanges(current, op.changes), revision: current.revision + 1, updatedAt: new Date(time) };
        await tx.save(next);
        await tx.record(op.id, { fingerprint: op.fingerprint, expiresAt: new Date(time + 30 * 86400000) });
        return { state: publicState(next), duplicate: false };
      });
    },
  };
}
module.exports = { createShoppingService, operation, selection, applyChanges, publicState, key, MAX_ROWS, MAX_WISHES, MAX_QUANTITY };
