"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");
const { CollaborationHub } = require("../server/collaboration");

function fakeSocket(userId) {
  return {
    userId,
    readyState: 1,
    messages: [],
    send(value) { this.messages.push(JSON.parse(value)); },
    close() { this.closed = true; }
  };
}

test("collaboration broadcasts only authorized user-specific reports", async (t) => {
  const server = new EventEmitter();
  const store = {
    async getReport(userId, reportId) {
      if (userId === "blocked") {
        const error = new Error("Denied");
        error.status = 403;
        throw error;
      }
      return { id: reportId, role: userId === "owner" ? "owner" : "editor", revision: 2 };
    },
    async canAccess(userId) { return userId !== "blocked"; }
  };
  const hub = new CollaborationHub({
    server,
    store,
    sessionMiddleware(_req, _res, next) { next(); }
  });
  t.after(() => {
    clearInterval(hub.heartbeat);
    hub.wss.close();
  });
  const owner = fakeSocket("owner");
  const editor = fakeSocket("editor");
  const blocked = fakeSocket("blocked");
  hub.rooms.set("report-id", new Set([owner, editor, blocked]));

  await hub.broadcast({ id: "report-id" }, "owner");
  assert.equal(owner.messages.length, 0);
  assert.equal(editor.messages[0].report.role, "editor");
  assert.equal(blocked.closed, true);
});

test("collaboration refuses unauthorized room subscriptions", async (t) => {
  const server = new EventEmitter();
  const hub = new CollaborationHub({
    server,
    store: { async canAccess() { return false; } },
    sessionMiddleware(_req, _res, next) { next(); }
  });
  t.after(() => {
    clearInterval(hub.heartbeat);
    hub.wss.close();
  });
  const socket = fakeSocket("stranger");
  await hub.handleMessage(socket, Buffer.from(JSON.stringify({ type: "subscribe", reportId: "secret" })));
  assert.equal(socket.messages[0].type, "error");
  assert.equal(hub.rooms.size, 0);
});
