"use strict";

const mongoose = require("mongoose");
const crypto = require("node:crypto");

const SupplierModel = require("../models/Supplier");
const models = require("../models/SupplierPortal");

const {
  DAY,
  problem,
  fields,
  text,
  id,
  revision,
  normalizeProfile,
  normalizeTerms,
  digestTerms,
  commercialReadiness,
  trialState,
} = require("./supplierTerms");

const PRIVATE_SUPPLIER =
  "+contact +verification +fulfillment +notes";

const hash = (token) =>
  crypto
    .createHash("sha256")
    .update(token)
    .digest("hex");

const same = (a, b) =>
  a != null &&
  b != null &&
  String(a) === String(b);

const plain = (value) =>
  value?.toObject
    ? value.toObject({ transform: false })
    : value;

function requireActor(actor, admin = false) {
  if (!actor?._id || actor.isActive === false) {
    throw problem(
      401,
      "LOGIN_REQUIRED",
      "Sign in to an active account."
    );
  }

  if (admin && actor.role !== "admin") {
    throw problem(
      403,
      "ADMIN_REQUIRED",
      "Admin access is required."
    );
  }
}

function pageNumber(value) {
  const page =
    value === undefined ? 1 : Number(value);

  if (
    !Number.isSafeInteger(page) ||
    page < 1 ||
    page > 10000
  ) {
    throw problem(
      400,
      "INVALID_PAGE",
      "Choose a valid page."
    );
  }

  return page;
}

function createSupplierPortalService({
  Workspace = models.Workspace,
  Agreement = models.Agreement,
  Event = models.Event,
  Supplier = SupplierModel,

  transaction = (fn) =>
    mongoose.connection.transaction(fn, {
      readConcern: {
        level: "snapshot",
      },

      writeConcern: {
        w: "majority",
      },

      readPreference: "primary",
      maxCommitTimeMS: 10000,
    }),

  now = () => new Date(),

  tokenBytes = () =>
    crypto.randomBytes(32).toString("hex"),
} = {}) {
  async function workspaceFor(
    actor,
    workspaceId,
    session,
    privateInvite = false
  ) {
    requireActor(actor);

    const filter = workspaceId
      ? { _id: id(workspaceId) }
      : { ownerUser: actor._id };

    if (actor.role !== "admin") {
      filter.ownerUser = actor._id;
    }

    let query = Workspace.findOne(filter)
      .session(session || null)
      .maxTimeMS(5000);

    if (privateInvite) {
      query = query.select("+invitation");
    }

    const workspace = await query;

    if (!workspace) {
      throw problem(
        404,
        "SUPPLIER_WORKSPACE_NOT_FOUND",
        "Supplier workspace not found."
      );
    }

    return workspace;
  }

  function expectRevision(workspace, value) {
    if (
      (workspace.__v || 0) !== revision(value)
    ) {
      throw problem(
        409,
        "SUPPLIER_CHANGED",
        "This record changed. Reload it before saving again."
      );
    }
  }

  async function event(
    workspace,
    actor,
    action,
    detail,
    session
  ) {
    await new Event({
      workspace: workspace._id,
      actor: actor._id,
      action,
      revision: workspace.__v || 0,
      detail,
    }).save({ session });
  }

  async function save(
    workspace,
    actor,
    action,
    detail,
    session
  ) {
    // Force a compare-and-swap version increment
    // even for repeated status values.
    workspace.markModified("status");

    await workspace.save({ session });

    await event(
      workspace,
      actor,
      action,
      detail,
      session
    );
  }

  function agreementView(agreement) {
    if (!agreement) {
      return null;
    }

    return {
      id: String(agreement._id),
      version: agreement.version,
      status: agreement.status,
      terms: plain(agreement.terms),
      digest: agreement.digest,

      acceptance:
        agreement.acceptance?.acceptedAt
          ? {
              signerName:
                agreement.acceptance.signerName,

              acceptedAt:
                agreement.acceptance.acceptedAt,

              digest:
                agreement.acceptance.digest,
            }
          : null,
    };
  }

  async function view(workspace, session) {
    // Sequential reads are intentional:
    // callers may be inside a transaction.
    const supplier = await Supplier.findById(
      workspace.supplier
    )
      .session(session || null)
      .maxTimeMS(5000);

    if (!supplier) {
      throw problem(
        409,
        "SUPPLIER_RECORD_MISSING",
        "The linked supplier needs admin review."
      );
    }

    const accepted = workspace.acceptedAgreement
      ? await Agreement.findOne({
          _id: workspace.acceptedAgreement,
          workspace: workspace._id,
        }).session(session || null)
      : null;

    const offered = workspace.offeredAgreement
      ? await Agreement.findOne({
          _id: workspace.offeredAgreement,
          workspace: workspace._id,
        }).session(session || null)
      : null;

    return {
      id: String(workspace._id),
      revision: workspace.__v || 0,

      supplier: {
        id: String(supplier._id),
        name: supplier.name,
        code: supplier.supplierCode,
        status: supplier.status,
      },

      hasOwner: Boolean(workspace.ownerUser),
      status: workspace.status,

      profile: plain(workspace.profile),
      submittedAt: workspace.submittedAt || null,
      approvedAt: workspace.approvedAt || null,
      statusReason: workspace.statusReason || "",

      readiness: commercialReadiness(
        workspace,
        accepted,
        now()
      ),

      offeredAgreement: agreementView(offered),
      acceptedAgreement: agreementView(accepted),

      // Routing, documents, banking and
      // settlements are separate gated phases.
      capabilities: {
        orderRouting: false,
        documentUpload: false,
        banking: false,
        settlements: false,
      },
    };
  }

  async function get(actor, workspaceId) {
    const workspace = await workspaceFor(
      actor,
      workspaceId
    );

    return view(workspace);
  }

  async function list(
    actor,
    { page: rawPage, status = "" } = {}
  ) {
    requireActor(actor, true);

    const page = pageNumber(rawPage);

    const allowed = [
      "pending-verification",
      "approved",
      "rejected",
      "suspended",
      "inactive",
    ];

    if (status && !allowed.includes(status)) {
      throw problem(
        400,
        "INVALID_STATUS",
        "Choose a valid supplier status."
      );
    }

    const filter = status ? { status } : {};

    const rows = await Workspace.find(filter)
      .sort({
        updatedAt: -1,
        _id: -1,
      })
      .skip((page - 1) * 20)
      .limit(20)
      .maxTimeMS(5000);

    const total = await Workspace.countDocuments(
      filter
    ).maxTimeMS(5000);

    // Bounded reads; no unbounded catalogue
    // or private customer data.
    const workspaces = [];

    for (const row of rows) {
      workspaces.push(await view(row));
    }

    return {
      workspaces,
      page,
      pages: Math.max(
        1,
        Math.ceil(total / 20)
      ),
      total,
    };
  }

  async function apply(actor, input) {
    requireActor(actor);

    fields(input, ["profile"]);

    const profile = normalizeProfile(
      input.profile
    );

    const timestamp = now();

    return transaction(async (session) => {
      const existing = await Workspace.findOne({
        ownerUser: actor._id,
      }).session(session);

      if (existing) {
        throw problem(
          409,
          "SUPPLIER_ALREADY_ENROLLED",
          "Your account already has a supplier workspace. Reload it."
        );
      }

      const supplier = new Supplier({
        name: profile.legalName,
        status: "draft",

        contact: {
          name: profile.contactName,
          email: actor.email,
          phone: profile.phone,
        },
      });

      const workspace = new Workspace({
        supplier: supplier._id,
        ownerUser: actor._id,
        profile,
        submittedAt: timestamp,
        status: "pending-verification",
      });

      supplier.portalWorkspace = workspace._id;

      await supplier.save({ session });
      await workspace.save({ session });

      await event(
        workspace,
        actor,
        "application-submitted",
        "Supplier submitted business and dispatch details.",
        session
      );

      return view(workspace, session);
    });
  }

  async function updateProfile(actor, input) {
    requireActor(actor);

    fields(input, [
      "revision",
      "profile",
    ]);

    const profile = normalizeProfile(
      input.profile
    );

    return transaction(async (session) => {
      const workspace = await workspaceFor(
        actor,
        undefined,
        session
      );

      expectRevision(
        workspace,
        input.revision
      );

      if (
        workspace.acceptedAgreement ||
        ![
          "pending-verification",
          "rejected",
        ].includes(workspace.status)
      ) {
        throw problem(
          409,
          "SUPPLIER_PROFILE_LOCKED",
          "Accepted or approved business details require admin review before changing."
        );
      }

      const supplier = await Supplier.findById(
        workspace.supplier
      )
        .select(PRIVATE_SUPPLIER)
        .session(session);

      if (
        !supplier ||
        supplier.status !== "draft"
      ) {
        throw problem(
          409,
          "SUPPLIER_PROFILE_LOCKED",
          "The existing supplier record needs admin review."
        );
      }

      supplier.name = profile.legalName;

      supplier.contact = {
        name: profile.contactName,
        email: actor.email,
        phone: profile.phone,
      };

      supplier.verification = {
        status: "pending",
        verifiedAt: null,
        verifiedBy: null,
        notes: "",
      };

      await supplier.save({ session });

      if (workspace.offeredAgreement) {
        await Agreement.updateOne(
          {
            _id: workspace.offeredAgreement,
            workspace: workspace._id,
            status: "offered",
          },
          {
            $set: {
              status: "withdrawn",
            },
          },
          { session }
        );

        workspace.offeredAgreement = undefined;
      }

      workspace.profile = profile;
      workspace.submittedAt = now();
      workspace.status = "pending-verification";
      workspace.statusReason = "";

      await save(
        workspace,
        actor,
        "profile-resubmitted",
        "Changed details require review and a fresh terms offer.",
        session
      );

      return view(workspace, session);
    });
  }

  async function invite(
    actor,
    input,
    workspaceId
  ) {
    requireActor(actor, true);

    fields(
      input,
      workspaceId
        ? ["revision", "email"]
        : ["supplierId", "email"]
    );

    const email = text(
      input.email,
      "Invitation email",
      150
    ).toLowerCase();

    if (
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
    ) {
      throw problem(
        400,
        "INVALID_EMAIL",
        "Enter a valid invitation email."
      );
    }

    const code = tokenBytes();

    const expiresAt = new Date(
      now().getTime() + 7 * DAY
    );

    return transaction(async (session) => {
      let workspace;

      if (workspaceId) {
        workspace = await workspaceFor(
          actor,
          workspaceId,
          session,
          true
        );

        expectRevision(
          workspace,
          input.revision
        );

        if (workspace.ownerUser) {
          throw problem(
            409,
            "SUPPLIER_ALREADY_CLAIMED",
            "This workspace already belongs to a supplier account."
          );
        }
      } else {
        const supplier = await Supplier.findById(
          id(input.supplierId)
        ).session(session);

        if (
          !supplier ||
          supplier.status !== "draft"
        ) {
          throw problem(
            409,
            "DRAFT_SUPPLIER_REQUIRED",
            "Select an existing draft supplier for onboarding."
          );
        }

        const existing = await Workspace.findOne({
          supplier: supplier._id,
        }).session(session);

        if (existing) {
          throw problem(
            409,
            "SUPPLIER_ALREADY_ENROLLED",
            "This supplier already has a workspace."
          );
        }

        workspace = new Workspace({
          supplier: supplier._id,
        });

        supplier.portalWorkspace = workspace._id;

        await supplier.save({ session });
      }

      workspace.invitation = {
        tokenHash: hash(code),
        email,
        expiresAt,
      };

      await save(
        workspace,
        actor,
        "invitation-created",
        "A seven-day invitation code was created. No message was sent.",
        session
      );

      return {
        workspace: await view(
          workspace,
          session
        ),

        invitation: {
          code,
          email,
          expiresAt,
        },
      };
    });
  }

  async function claim(actor, input) {
    requireActor(actor);

    fields(input, ["code"]);

    if (
      typeof input.code !== "string" ||
      !/^[a-f0-9]{64}$/.test(input.code)
    ) {
      throw problem(
        400,
        "INVITATION_INVALID",
        "Check the invitation code."
      );
    }

    return transaction(async (session) => {
      const existing = await Workspace.findOne({
        ownerUser: actor._id,
      }).session(session);

      if (existing) {
        throw problem(
          409,
          "SUPPLIER_ALREADY_ENROLLED",
          "Your account already has a supplier workspace. Reload it."
        );
      }

      const workspace = await Workspace.findOne({
        "invitation.tokenHash": hash(input.code),
      })
        .select("+invitation")
        .session(session);

      if (
        !workspace ||
        workspace.ownerUser ||
        workspace.invitation.expiresAt <= now() ||
        workspace.invitation.email !==
          String(actor.email).toLowerCase()
      ) {
        throw problem(
          400,
          "INVITATION_INVALID",
          "This invitation is invalid, expired or intended for a different sign-in email."
        );
      }

      workspace.ownerUser = actor._id;
      workspace.invitation = undefined;

      await save(
        workspace,
        actor,
        "invitation-claimed",
        "Supplier account connected; business details and acceptance are still required.",
        session
      );

      return view(workspace, session);
    });
  }

  async function offer(
    actor,
    workspaceId,
    input
  ) {
    requireActor(actor, true);

    fields(input, [
      "revision",
      "terms",
    ]);

    const normalized = normalizeTerms(
      input.terms,
      now()
    );

    return transaction(async (session) => {
      const workspace = await workspaceFor(
        actor,
        workspaceId,
        session
      );

      expectRevision(
        workspace,
        input.revision
      );

      if (
        !workspace.ownerUser ||
        !workspace.submittedAt ||
        workspace.status !== "pending-verification"
      ) {
        throw problem(
          409,
          "SUPPLIER_DETAILS_REQUIRED",
          "The supplier must submit business details before a trial offer."
        );
      }

      if (workspace.acceptedAgreement) {
        throw problem(
          409,
          "TERMS_ALREADY_ACCEPTED",
          "Accepted trial terms are immutable. Renewals require a separate future workflow."
        );
      }

      if (workspace.offeredAgreement) {
        await Agreement.updateOne(
          {
            _id: workspace.offeredAgreement,
            workspace: workspace._id,
            status: "offered",
          },
          {
            $set: {
              status: "withdrawn",
            },
          },
          { session }
        );
      }

      const terms = {
        ...normalized,
        supplierLegalName:
          workspace.profile.legalName,
      };

      const agreement = new Agreement({
        workspace: workspace._id,
        version: workspace.agreementVersion + 1,
        terms,
        digest: digestTerms(terms),
        offeredBy: actor._id,
      });

      await agreement.save({ session });

      workspace.agreementVersion =
        agreement.version;

      workspace.offeredAgreement =
        agreement._id;

      await save(
        workspace,
        actor,
        "terms-offered",
        `Commercial terms version ${agreement.version} offered; no acceptance implied.`,
        session
      );

      return view(workspace, session);
    });
  }

  async function accept(actor, input) {
    requireActor(actor);

    fields(input, [
      "revision",
      "agreementId",
      "digest",
      "signerName",
      "accepted",
      "authorized",
    ]);

    const agreementId = id(
      input.agreementId
    );

    const signerName = text(
      input.signerName,
      "Authorized signer's name",
      100,
      2
    );

    if (
      input.accepted !== true ||
      input.authorized !== true ||
      !/^[a-f0-9]{64}$/.test(input.digest || "")
    ) {
      throw problem(
        400,
        "EXPLICIT_ACCEPTANCE_REQUIRED",
        "Read the terms and explicitly confirm acceptance and authority to sign."
      );
    }

    return transaction(async (session) => {
      const workspace = await workspaceFor(
        actor,
        undefined,
        session
      );

      const agreement = await Agreement.findOne({
        _id: agreementId,
        workspace: workspace._id,
      }).session(session);

      if (
        !agreement ||
        agreement.digest !== input.digest
      ) {
        throw problem(
          409,
          "TERMS_CHANGED",
          "Reload and review the exact terms before accepting."
        );
      }

      if (
        same(
          workspace.acceptedAgreement,
          agreement._id
        ) &&
        agreement.status === "accepted" &&
        same(
          agreement.acceptance?.user,
          actor._id
        ) &&
        agreement.acceptance.signerName ===
          signerName
      ) {
        // Exact repeat: no new audit event or trial reset.
        return view(workspace, session);
      }

      expectRevision(
        workspace,
        input.revision
      );

      if (
        workspace.acceptedAgreement ||
        workspace.status !== "pending-verification" ||
        !same(
          workspace.offeredAgreement,
          agreement._id
        ) ||
        agreement.status !== "offered" ||
        agreement.terms.offerExpiresAt <= now()
      ) {
        throw problem(
          409,
          "TERMS_NOT_ACCEPTABLE",
          "This offer is no longer available. Ask the admin for a new offer."
        );
      }

      agreement.status = "accepted";

      agreement.acceptance = {
        user: actor._id,
        signerName,
        acceptedAt: now(),
        digest: agreement.digest,
      };

      agreement.acceptance.authorityConfirmed =
        true;

      agreement.acceptance.method =
        "authenticated-explicit-acceptance-v1";

      await agreement.save({ session });

      workspace.acceptedAgreement =
        agreement._id;

      workspace.offeredAgreement = undefined;

      await save(
        workspace,
        actor,
        "terms-accepted",
        `Supplier explicitly accepted commercial terms version ${agreement.version}.`,
        session
      );

      return view(workspace, session);
    });
  }

  async function setStatus(
    actor,
    workspaceId,
    input
  ) {
    requireActor(actor, true);

    fields(input, [
      "revision",
      "status",
      "reason",
    ]);

    if (
      ![
        "approved",
        "rejected",
        "suspended",
        "inactive",
      ].includes(input.status)
    ) {
      throw problem(
        400,
        "INVALID_STATUS",
        "Choose an approval, rejection, suspension or inactive status."
      );
    }

    const reason = text(
      input.reason,
      "Review reason",
      1000,
      3
    );

    return transaction(async (session) => {
      const workspace = await workspaceFor(
        actor,
        workspaceId,
        session
      );

      expectRevision(
        workspace,
        input.revision
      );

      if (input.status === "approved") {
        const agreement = await Agreement.findOne({
          _id: workspace.acceptedAgreement || null,
          workspace: workspace._id,
          status: "accepted",
        }).session(session);

        if (
          !workspace.ownerUser ||
          !workspace.submittedAt ||
          !agreement?.acceptance?.acceptedAt
        ) {
          throw problem(
            409,
            "APPROVAL_REQUIREMENTS_MISSING",
            "Supplier details and explicit commercial acceptance are required before approval."
          );
        }

        if (
          trialState(workspace, now()).state ===
          "review-required"
        ) {
          throw problem(
            409,
            "TRIAL_EXPIRED",
            "The trial has expired. Approval cannot reset it or increase commission."
          );
        }

        if (!workspace.trial?.startAt) {
          const startAt = new Date(
            Math.max(
              now().getTime(),
              new Date(
                agreement.terms.effectiveFrom
              ).getTime()
            )
          );

          workspace.trial = {
            startAt,

            endAt: new Date(
              startAt.getTime() +
                agreement.terms.trialDays * DAY
            ),
          };

          workspace.approvedAt = now();
          workspace.approvedBy = actor._id;
        }
      }

      workspace.status = input.status;
      workspace.statusReason = reason;

      await save(
        workspace,
        actor,
        `status-${input.status}`,
        reason,
        session
      );

      return view(workspace, session);
    });
  }

  async function history(
    actor,
    workspaceId,
    rawPage
  ) {
    const workspace = await workspaceFor(
      actor,
      workspaceId
    );

    const page = pageNumber(rawPage);

    const events = await Event.find({
      workspace: workspace._id,
    })
      .sort({ revision: -1 })
      .skip((page - 1) * 30)
      .limit(31)
      .maxTimeMS(5000);

    return {
      page,
      hasMore: events.length > 30,

      events: events.slice(0, 30).map((row) => ({
        action: row.action,
        detail: row.detail,
        createdAt: row.createdAt,
        revision: row.revision,
      })),
    };
  }

  return {
    get,
    list,
    apply,
    updateProfile,
    invite,
    claim,
    offer,
    accept,
    setStatus,
    history,
  };
}

module.exports = {
  createSupplierPortalService,
  requireActor,
};