"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  memoryStore,
} = require("./helpers/supplierPortalStore.cjs");

const {
  createSupplierPortalService,
} = require("../utils/supplierPortalService");

const {
  normalizeTerms,
  digestTerms,
  commercialReadiness,
  DAY,
} = require("../utils/supplierTerms");

const {
  Workspace,
} = require("../models/SupplierPortal");

const Supplier = require("../models/Supplier");

const owner = {
  _id: "507f1f77bcf86cd799439011",
  email: "owner@example.test",
  role: "customer",
  isActive: true,
};

const other = {
  ...owner,
  _id: "507f1f77bcf86cd799439012",
  email: "other@example.test",
};

const admin = {
  ...owner,
  _id: "507f1f77bcf86cd799439013",
  role: "admin",
};

const profile = {
  legalName: "Fixture Fitness",
  contactName: "Fixture Owner",
  phone: "918888888888",
  gstin: "",

  dispatchAddress: {
    addressLine: "12 Test Road",
    city: "Kozhikode",
    state: "Kerala",
    pincode: "673001",
    country: "IN",
  },
};

const terms = {
  title: "90-day supplier trial",

  text:
    "Fixture commercial terms for the supplier trial; no automatic renewal.",

  commissionBps: 500,
  shippingResponsibility: "supplier",
  gatewayFeeResponsibility: "gymdrobe",

  returnResponsibility:
    "Responsibilities must follow the agreed return policy and applicable rights.",

  effectiveFrom: "2026-10-24T12:00:00Z",
  offerExpiresAt: "2026-10-31T12:00:00Z",
};

function setup() {
  const store = memoryStore();

  let time = new Date("2026-10-24T12:00:00Z");
  let sequence = 0;

  const service = createSupplierPortalService({
    ...store,

    now: () => time,

    tokenBytes: () =>
      (++sequence).toString(16).padStart(64, "0"),
  });

  return {
    ...store,
    service,

    clock(value) {
      time = new Date(value);
    },

    now: () => time,
  };
}

async function offered(ctx) {
  let workspace = await ctx.service.apply(
    owner,
    { profile },
  );

  workspace = await ctx.service.offer(
    admin,
    workspace.id,
    {
      revision: workspace.revision,
      terms,
    },
  );

  return workspace;
}

function acceptance(workspace, changes = {}) {
  return {
    revision: workspace.revision,
    agreementId: workspace.offeredAgreement.id,
    digest: workspace.offeredAgreement.digest,
    signerName: "Fixture Owner",
    accepted: true,
    authorized: true,
    ...changes,
  };
}

test(
  "application creates an existing Supplier draft and an isolated workspace with no assumed terms",
  async () => {
    const ctx = setup();

    const workspace = await ctx.service.apply(
      owner,
      { profile },
    );

    assert.equal(
      workspace.status,
      "pending-verification",
    );

    assert.equal(
      workspace.supplier.status,
      "draft",
    );

    assert.equal(
      workspace.acceptedAgreement,
      null,
    );

    assert.equal(
      workspace.readiness.ready,
      false,
    );

    assert.equal(
      workspace.capabilities.orderRouting,
      false,
    );

    assert.equal(ctx.stores.Supplier.size, 1);
    assert.equal(ctx.stores.Event.size, 1);

    assert.equal(
      [...ctx.stores.Supplier.values()][0]
        .portalWorkspace,
      workspace.id,
    );

    await assert.rejects(
      ctx.service.get(other, workspace.id),
      {
        code: "SUPPLIER_WORKSPACE_NOT_FOUND",
      },
    );

    await assert.rejects(
      ctx.service.history(other, workspace.id),
      {
        code: "SUPPLIER_WORKSPACE_NOT_FOUND",
      },
    );
  },
);

test(
  "supplier input cannot grant approval, change owner, set commission or write bank details",
  async () => {
    const ctx = setup();

    for (const key of [
      "status",
      "ownerUser",
      "role",
      "bankAccount",
      "commissionBps",
    ]) {
      await assert.rejects(
        ctx.service.apply(owner, {
          profile,
          [key]: "forged",
        }),
        {
          code: "INVALID_SUPPLIER_INPUT",
        },
      );
    }

    await assert.rejects(
      ctx.service.apply(owner, {
        profile: {
          ...profile,

          dispatchAddress: {
            ...profile.dispatchAddress,
            pincode: "000000",
          },
        },
      }),
      {
        code: "INVALID_SUPPLIER_INPUT",
      },
    );

    await assert.rejects(
      ctx.service.list(owner),
      {
        code: "ADMIN_REQUIRED",
      },
    );

    await assert.rejects(
      ctx.service.apply(
        {
          ...owner,
          isActive: false,
        },
        { profile },
      ),
      {
        code: "LOGIN_REQUIRED",
      },
    );
  },
);

test(
  "duplicate submissions create one workspace and one supplier, with no orphan record",
  async () => {
    const ctx = setup();

    const results = await Promise.allSettled([
      ctx.service.apply(owner, { profile }),
      ctx.service.apply(owner, { profile }),
    ]);

    assert.equal(
      results.filter(
        (result) => result.status === "fulfilled",
      ).length,
      1,
    );

    assert.equal(ctx.stores.Workspace.size, 1);
    assert.equal(ctx.stores.Supplier.size, 1);
  },
);

test(
  "audit failure rolls back the supplier, workspace and invitation together",
  async () => {
    const ctx = setup();

    ctx.failAudit();

    await assert.rejects(
      ctx.service.apply(owner, { profile }),
    );

    assert.equal(ctx.stores.Supplier.size, 0);
    assert.equal(ctx.stores.Workspace.size, 0);
    assert.equal(ctx.stores.Event.size, 0);
  },
);

test(
  "admin cannot approve without supplier acceptance, and supplier cannot offer or approve",
  async () => {
    const ctx = setup();
    const workspace = await offered(ctx);

    await assert.rejects(
      ctx.service.setStatus(
        admin,
        workspace.id,
        {
          revision: workspace.revision,
          status: "approved",
          reason: "Reviewed",
        },
      ),
      {
        code: "APPROVAL_REQUIREMENTS_MISSING",
      },
    );

    await assert.rejects(
      ctx.service.setStatus(
        owner,
        workspace.id,
        {
          revision: workspace.revision,
          status: "approved",
          reason: "Forged",
        },
      ),
      {
        code: "ADMIN_REQUIRED",
      },
    );

    await assert.rejects(
      ctx.service.offer(
        owner,
        workspace.id,
        {
          revision: workspace.revision,
          terms,
        },
      ),
      {
        code: "ADMIN_REQUIRED",
      },
    );
  },
);

test(
  "terms have an explicit integer commission and zero trial fees; neither missing nor fractional rates are assumed",
  () => {
    const now = new Date(terms.effectiveFrom);

    for (const commissionBps of [
      undefined,
      -1,
      10001,
      0.5,
      "500",
    ]) {
      assert.throws(
        () =>
          normalizeTerms(
            {
              ...terms,
              commissionBps,
            },
            now,
          ),
        {
          code: "INVALID_SUPPLIER_INPUT",
        },
      );
    }

    const normalized = normalizeTerms(
      terms,
      now,
    );

    assert.equal(normalized.trialDays, 90);
    assert.equal(normalized.joiningFeePaise, 0);
    assert.equal(normalized.monthlyFeePaise, 0);

    assert.notEqual(
      digestTerms(normalized),
      digestTerms({
        ...normalized,
        commissionBps: 1500,
      }),
    );
  },
);

test(
  "exact terms, signer authority and explicit acceptance are mandatory",
  async () => {
    const ctx = setup();
    const workspace = await offered(ctx);

    for (const change of [
      { accepted: false },
      { authorized: false },
      { signerName: "" },
      { digest: "0".repeat(64) },
    ]) {
      await assert.rejects(
        ctx.service.accept(
          owner,
          acceptance(workspace, change),
        ),
      );
    }

    await assert.rejects(
      ctx.service.accept(
        other,
        acceptance(workspace),
      ),
      {
        code: "SUPPLIER_WORKSPACE_NOT_FOUND",
      },
    );

    assert.equal(
      ctx.stores.Agreement.values()
        .next().value.status,
      "offered",
    );
  },
);

test(
  "replaced, expired and stale offers cannot be accepted",
  async () => {
    const ctx = setup();
    const old = await offered(ctx);

    const replacement = await ctx.service.offer(
      admin,
      old.id,
      {
        revision: old.revision,

        terms: {
          ...terms,
          commissionBps: 600,
        },
      },
    );

    await assert.rejects(
      ctx.service.accept(
        owner,
        acceptance(old),
      ),
      {
        code: "SUPPLIER_CHANGED",
      },
    );

    await assert.rejects(
      ctx.service.accept(owner, {
        ...acceptance(old),
        revision: replacement.revision,
      }),
      {
        code: "TERMS_NOT_ACCEPTABLE",
      },
    );

    ctx.clock(terms.offerExpiresAt);

    await assert.rejects(
      ctx.service.accept(
        owner,
        acceptance(replacement),
      ),
      {
        code: "TERMS_NOT_ACCEPTABLE",
      },
    );
  },
);

test(
  "repeated and concurrent acceptance records one immutable receipt and one audit event",
  async () => {
    const ctx = setup();
    const workspace = await offered(ctx);
    const body = acceptance(workspace);

    const [a, b] = await Promise.all([
      ctx.service.accept(owner, body),
      ctx.service.accept(owner, body),
    ]);

    assert.equal(
      a.acceptedAgreement.digest,
      workspace.offeredAgreement.digest,
    );

    assert.equal(
      a.revision,
      b.revision,
    );

    assert.equal(
      [...ctx.stores.Event.values()].filter(
        (event) => event.action === "terms-accepted",
      ).length,
      1,
    );

    assert.equal(
      a.readiness.trial.state,
      "not-started",
    );

    await assert.rejects(
      ctx.service.offer(
        admin,
        workspace.id,
        {
          revision: a.revision,
          terms,
        },
      ),
      {
        code: "TERMS_ALREADY_ACCEPTED",
      },
    );
  },
);

test(
  "approval starts exactly 90 days; suspension/resume cannot reset expiry or increase commission",
  async () => {
    const ctx = setup();

    let workspace = await offered(ctx);

    workspace = await ctx.service.accept(
      owner,
      acceptance(workspace),
    );

    workspace = await ctx.service.setStatus(
      admin,
      workspace.id,
      {
        revision: workspace.revision,
        status: "approved",

        reason:
          "Business and applicable documents reviewed",
      },
    );

    const end = new Date(
      workspace.readiness.trial.endAt,
    ).getTime();

    assert.equal(
      end - ctx.now().getTime(),
      90 * DAY,
    );

    assert.equal(
      workspace.readiness.ready,
      true,
    );

    workspace = await ctx.service.setStatus(
      admin,
      workspace.id,
      {
        revision: workspace.revision,
        status: "suspended",
        reason: "Dispatch issue under review",
      },
    );

    assert.equal(
      workspace.readiness.ready,
      false,
    );

    ctx.clock(
      new Date(ctx.now().getTime() + DAY),
    );

    workspace = await ctx.service.setStatus(
      admin,
      workspace.id,
      {
        revision: workspace.revision,
        status: "approved",
        reason: "Issue resolved",
      },
    );

    assert.equal(
      new Date(
        workspace.readiness.trial.endAt,
      ).getTime(),
      end,
    );

    ctx.clock(new Date(end));

    workspace = await ctx.service.get(owner);

    assert.equal(
      workspace.readiness.ready,
      false,
    );

    assert.equal(
      workspace.readiness.trial.state,
      "review-required",
    );

    assert.equal(
      workspace.acceptedAgreement
        .terms.commissionBps,
      500,
    );

    await assert.rejects(
      ctx.service.setStatus(
        admin,
        workspace.id,
        {
          revision: workspace.revision,
          status: "approved",
          reason: "Attempt reset",
        },
      ),
      {
        code: "TRIAL_EXPIRED",
      },
    );
  },
);

test(
  "future effective dates keep commercial readiness closed until the agreed start",
  async () => {
    const ctx = setup();

    let workspace = await ctx.service.apply(
      owner,
      { profile },
    );

    workspace = await ctx.service.offer(
      admin,
      workspace.id,
      {
        revision: workspace.revision,

        terms: {
          ...terms,
          effectiveFrom: "2026-11-01T00:00:00Z",
        },
      },
    );

    workspace = await ctx.service.accept(
      owner,
      acceptance(workspace),
    );

    workspace = await ctx.service.setStatus(
      admin,
      workspace.id,
      {
        revision: workspace.revision,
        status: "approved",
        reason: "Reviewed",
      },
    );

    assert.equal(
      workspace.readiness.trial.state,
      "scheduled",
    );

    assert.equal(
      workspace.readiness.ready,
      false,
    );
  },
);

test(
  "changing a pending profile withdraws its offer and demands fresh review",
  async () => {
    const ctx = setup();
    const workspace = await offered(ctx);

    const changed = await ctx.service.updateProfile(
      owner,
      {
        revision: workspace.revision,

        profile: {
          ...profile,
          legalName: "Updated Fitness",
        },
      },
    );

    assert.equal(
      changed.offeredAgreement,
      null,
    );

    assert.equal(
      changed.status,
      "pending-verification",
    );

    assert.equal(
      changed.supplier.name,
      "Updated Fitness",
    );

    assert.equal(
      [...ctx.stores.Agreement.values()][0].status,
      "withdrawn",
    );

    await assert.rejects(
      ctx.service.updateProfile(owner, {
        revision: workspace.revision,
        profile,
      }),
      {
        code: "SUPPLIER_CHANGED",
      },
    );
  },
);

test(
  "invitations are hashed, bound to the sign-in email, expire, and can only be claimed once",
  async () => {
    const ctx = setup();

    const supplier = new ctx.Supplier({
      name: "Invited Fitness",
    });

    await supplier.save();

    const invited = await ctx.service.invite(
      admin,
      {
        supplierId: String(supplier._id),
        email: owner.email,
      },
    );

    const stored = [
      ...ctx.stores.Workspace.values(),
    ][0];

    assert.notEqual(
      stored.invitation.tokenHash,
      invited.invitation.code,
    );

    assert.equal(
      JSON.stringify(
        invited.workspace,
      ).includes("invitation"),
      false,
    );

    const publicDoc =
      new Workspace(stored).toJSON();

    assert.equal(
      publicDoc.invitation,
      undefined,
    );

    await assert.rejects(
      ctx.service.claim(other, {
        code: invited.invitation.code,
      }),
      {
        code: "INVITATION_INVALID",
      },
    );

    const claimed = await ctx.service.claim(
      owner,
      {
        code: invited.invitation.code,
      },
    );

    assert.equal(
      claimed.hasOwner,
      true,
    );

    assert.equal(
      claimed.submittedAt,
      null,
    );

    assert.equal(
      [...ctx.stores.Workspace.values()][0]
        .invitation,
      undefined,
    );

    await assert.rejects(
      ctx.service.claim(owner, {
        code: invited.invitation.code,
      }),
      {
        code: "SUPPLIER_ALREADY_ENROLLED",
      },
    );
  },
);

test(
  "reissuing an invitation revokes the old code, and expiry is enforced without a scheduler",
  async () => {
    const ctx = setup();

    const supplier = new ctx.Supplier({
      name: "Invited Fitness",
    });

    await supplier.save();

    const first = await ctx.service.invite(
      admin,
      {
        supplierId: String(supplier._id),
        email: owner.email,
      },
    );

    const second = await ctx.service.invite(
      admin,
      {
        revision: first.workspace.revision,
        email: owner.email,
      },
      first.workspace.id,
    );

    await assert.rejects(
      ctx.service.claim(owner, {
        code: first.invitation.code,
      }),
      {
        code: "INVITATION_INVALID",
      },
    );

    ctx.clock(second.invitation.expiresAt);

    await assert.rejects(
      ctx.service.claim(owner, {
        code: second.invitation.code,
      }),
      {
        code: "INVITATION_INVALID",
      },
    );
  },
);

test(
  "legacy activation cannot enable enrolled suppliers before marketplace fulfilment is implemented",
  async () => {
    const supplier = new Supplier({
      name: "Enrolled Fitness",
      portalWorkspace: "507f1f77bcf86cd799439020",
      status: "active",

      contact: {
        email: owner.email,
      },

      verification: {
        status: "verified",
        verifiedBy: admin._id,
        verifiedAt: new Date(),
      },

      fulfillment: {
        dispatchToCustomer: true,
        preparationDaysMin: 1,
        preparationDaysMax: 2,
      },
    });

    await assert.rejects(
      supplier.validate(),
      /Marketplace suppliers remain drafts/,
    );
  },
);

test(
  "readiness rejects an accepted agreement belonging to a different workspace",
  () => {
    const now = new Date(terms.effectiveFrom);

    const workspace = {
      _id: "one",
      status: "approved",
      ownerUser: owner._id,
      submittedAt: now,
      acceptedAgreement: "terms",

      trial: {
        startAt: now,
        endAt: new Date(+now + DAY),
      },
    };

    const result = commercialReadiness(
      workspace,
      {
        _id: "terms",
        workspace: "other",
        status: "accepted",

        acceptance: {
          acceptedAt: now,
        },
      },
      now,
    );

    assert.equal(
      result.ready,
      false,
    );
  },
);