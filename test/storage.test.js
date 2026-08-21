"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { ReportStore } = require("../server/storage");
const { validateState } = require("../server/validation");

function sampleState() {
  return {
    people: [
      { id: "person_alex", name: "Alex" },
      { id: "person_blair", name: "Blair" }
    ],
    expenses: [{
      id: "expense_dinner",
      description: "Dinner",
      date: "2026-08-20",
      total: 4200,
      paid: { person_alex: 4200 },
      owed: { person_alex: 2100, person_blair: 2100 },
      splitMode: "equal",
      splitDetails: { person_alex: 1, person_blair: 1 },
      createdAt: 1,
      updatedAt: 1
    }],
    currency: "USD",
    resultCurrency: "USD",
    expenseView: "grid",
    simplify: true
  };
}

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "fairshare-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new ReportStore(root);
  await store.initialize();
  return store;
}

const owner = {
  id: "a".repeat(64),
  name: "Owner",
  email: "owner@example.com",
  emailVerified: true
};
const editor = {
  id: "b".repeat(64),
  name: "Editor",
  email: "editor@example.com",
  emailVerified: true
};
const stranger = {
  id: "c".repeat(64),
  name: "Stranger",
  email: "stranger@example.com",
  emailVerified: true
};

test("validates balanced report state and rejects malformed allocations", () => {
  assert.deepEqual(validateState(sampleState()), sampleState());
  const invalid = sampleState();
  invalid.expenses[0].owed.person_alex = 1;
  assert.throws(() => validateState(invalid), /balance/);
});

test("creates, lists, loads, and revision-updates an owned report", async (t) => {
  const store = await fixture(t);
  const created = await store.createReport(owner, { title: "Trip", state: sampleState() });
  assert.equal(created.revision, 1);
  assert.equal((await store.listReports(owner.id))[0].role, "owner");

  const updated = await store.updateReport(owner.id, created.id, {
    title: "Trip 2026",
    state: sampleState(),
    baseRevision: 1
  });
  assert.equal(updated.revision, 2);
  assert.equal((await store.getReport(owner.id, created.id)).title, "Trip 2026");
  await assert.rejects(
    store.updateReport(owner.id, created.id, { title: "Stale", state: sampleState(), baseRevision: 1 }),
    (error) => error.status === 409 && error.latest.revision === 2
  );
});

test("enforces unique owned titles and isolates unauthorized users", async (t) => {
  const store = await fixture(t);
  const report = await store.createReport(owner, { title: "Trip", state: sampleState() });
  await assert.rejects(
    store.createReport(owner, { title: " trip ", state: sampleState() }),
    (error) => error.status === 409
  );
  await assert.rejects(store.getReport(stranger.id, report.id), (error) => error.status === 403);
  await assert.rejects(
    store.updateReport(stranger.id, report.id, { title: "No", state: sampleState(), baseRevision: 1 }),
    (error) => error.status === 403
  );
});

test("claims verified-email invitations and limits sharing management to owner", async (t) => {
  const store = await fixture(t);
  const report = await store.createReport(owner, { title: "Trip", state: sampleState() });
  await store.inviteEmail(owner.id, report.id, "EDITOR@example.com");
  assert.equal((await store.getSharing(owner.id, report.id)).invitations.length, 1);
  assert.deepEqual(await store.claimPending(editor), [report.id]);
  assert.equal((await store.getReport(editor.id, report.id)).role, "editor");
  await assert.rejects(store.getSharing(editor.id, report.id), (error) => error.status === 403);

  await store.removeEditor(owner.id, report.id, editor.id);
  await assert.rejects(store.getReport(editor.id, report.id), (error) => error.status === 403);
});

test("accepts and revokes hashed bearer invitation links", async (t) => {
  const store = await fixture(t);
  const report = await store.createReport(owner, { title: "Trip", state: sampleState() });
  const link = await store.createLink(owner.id, report.id);
  const reportFile = await fs.readFile(store.reportPath(owner.id, report.id), "utf8");
  assert.equal(reportFile.includes(link.token), false);

  const accepted = await store.acceptLink(editor, link.token);
  assert.equal(accepted.role, "editor");

  const secondLink = await store.createLink(owner.id, report.id);
  await store.revokeLink(owner.id, report.id, secondLink.id);
  await assert.rejects(store.acceptLink(stranger, secondLink.token), (error) => error.status === 404);
});

test("server-generated identifiers cannot escape storage directories", async (t) => {
  const store = await fixture(t);
  await assert.rejects(store.getReport(owner.id, "../../secret"), (error) => error.status === 404);
});
