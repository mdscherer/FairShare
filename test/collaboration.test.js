"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");
const { CollaborationHub } = require("../server/collaboration");

function fakeSocket(userId, clientId) {
  return {
    userId,
    clientId,
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
  const sourceDevice = fakeSocket("owner", "client_source");
  const otherDevice = fakeSocket("owner", "client_other");
  const editor = fakeSocket("editor", "client_editor");
  const blocked = fakeSocket("blocked", "client_blocked");
  hub.rooms.set("report-id", new Set([sourceDevice, otherDevice, editor, blocked]));

  await hub.broadcast(
    { id: "report-id" },
    { userId: "owner", clientId: "client_source" }
  );
  assert.equal(sourceDevice.messages.length, 0);
  assert.equal(otherDevice.messages[0].report.role, "owner");
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
