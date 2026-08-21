"use strict";

process.env.NODE_ENV = "test";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createApp } = require("../server/app");

const user = {
  id: "d".repeat(64),
  name: "API User",
  email: "api@example.com",
  emailVerified: true
};

function state() {
  return {
    people: [{ id: "person_one", name: "One" }],
    expenses: [{
      id: "expense_one",
      description: "Coffee",
      date: "2026-08-20",
      total: 500,
      paid: { person_one: 500 },
      owed: { person_one: 500 },
      splitMode: "equal",
      splitDetails: { person_one: 1 },
      createdAt: 1,
      updatedAt: 1
    }],
    currency: "USD",
    resultCurrency: "USD",
    expenseView: "grid",
    simplify: true
  };
}

async function serverFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "fairshare-api-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const { app } = await createApp({
    dataDir: path.join(root, "data"),
    sessionDir: path.join(root, "sessions"),
    userResolver: (req) => req.get("x-test-user") === "yes" ? user : null
  });
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

test("report APIs require authentication", async (t) => {
  const base = await serverFixture(t);
  const response = await fetch(`${base}/api/reports`);
  assert.equal(response.status, 401);
});

test("report APIs create and return validated state", async (t) => {
  const base = await serverFixture(t);
  const created = await fetch(`${base}/api/reports`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-test-user": "yes" },
    body: JSON.stringify({ title: "API report", state: state() })
  });
  assert.equal(created.status, 201);
  const body = await created.json();

  const loaded = await fetch(`${base}/api/reports/${body.report.id}`, {
    headers: { "x-test-user": "yes" }
  });
  assert.equal(loaded.status, 200);
  assert.equal((await loaded.json()).report.title, "API report");
});

test("report APIs reject malformed and oversized JSON", async (t) => {
  const base = await serverFixture(t);
  const malformed = await fetch(`${base}/api/reports`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-test-user": "yes" },
    body: JSON.stringify({ title: "", state: {} })
  });
  assert.equal(malformed.status, 400);

  const oversized = await fetch(`${base}/api/reports`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-test-user": "yes" },
    body: JSON.stringify({ padding: "x".repeat(5 * 1024 * 1024 + 1) })
  });
  assert.equal(oversized.status, 413);
});
