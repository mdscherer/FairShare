"use strict";

const { WebSocketServer, WebSocket } = require("ws");

class CollaborationHub {
  constructor({ server, sessionMiddleware, store }) {
    this.store = store;
    this.rooms = new Map();
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });

    server.on("upgrade", (request, socket, head) => {
      const url = new URL(request.url, "http://localhost");
      if (url.pathname !== "/ws") return socket.destroy();
      sessionMiddleware(request, {}, () => {
        const user = request.session?.passport?.user;
        if (!user?.id) return socket.destroy();
        request.user = user;
        this.wss.handleUpgrade(request, socket, head, (ws) => this.wss.emit("connection", ws, request));
      });
    });

    this.wss.on("connection", (ws, request) => {
      ws.userId = request.user.id;
      ws.isAlive = true;
      ws.on("pong", () => { ws.isAlive = true; });
      ws.on("message", (raw) => this.handleMessage(ws, raw));
      ws.on("close", () => this.leave(ws));
      ws.send(JSON.stringify({ type: "ready" }));
    });

    this.heartbeat = setInterval(() => {
      for (const ws of this.wss.clients) {
        if (!ws.isAlive) {
          ws.terminate();
          continue;
        }
        ws.isAlive = false;
        ws.ping();
      }
    }, 30000);
    this.heartbeat.unref();
  }

  async handleMessage(ws, raw) {
    try {
      const message = JSON.parse(raw.toString());
      if (message.type === "unsubscribe") {
        this.leave(ws);
        return;
      }
      if (message.type !== "subscribe" || typeof message.reportId !== "string") return;
      if (!await this.store.canAccess(ws.userId, message.reportId)) {
        ws.send(JSON.stringify({ type: "error", message: "Report access denied." }));
        return;
      }
      this.leave(ws);
      ws.reportId = message.reportId;
      ws.clientId = validClientId(message.clientId);
      if (!this.rooms.has(ws.reportId)) this.rooms.set(ws.reportId, new Set());
      this.rooms.get(ws.reportId).add(ws);
      ws.send(JSON.stringify({ type: "subscribed", reportId: ws.reportId }));
    } catch {
      ws.send(JSON.stringify({ type: "error", message: "Invalid collaboration message." }));
    }
  }

  leave(ws) {
    if (!ws.reportId) return;
    const room = this.rooms.get(ws.reportId);
    room?.delete(ws);
    if (!room?.size) this.rooms.delete(ws.reportId);
    ws.reportId = null;
  }

  async broadcast(report, source) {
    const room = this.rooms.get(report.id);
    if (!room) return;
    for (const ws of room) {
      const isSource = Boolean(source?.clientId) &&
        ws.userId === source.userId && ws.clientId === source.clientId;
      if (!isSource && ws.readyState === WebSocket.OPEN) {
        try {
          const authorizedReport = await this.store.getReport(ws.userId, report.id);
          ws.send(JSON.stringify({ type: "report", report: authorizedReport }));
        } catch {
          ws.close(1008, "Access revoked");
        }
      }
    }
  }

  revoke(reportId, userId) {
    const room = this.rooms.get(reportId);
    if (!room) return;
    for (const ws of room) {
      if (ws.userId === userId) {
        ws.send(JSON.stringify({ type: "access-revoked", reportId }));
        ws.close(1008, "Access revoked");
      }
    }
  }
}

function validClientId(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{8,100}$/.test(value) ? value : null;
}

module.exports = { CollaborationHub };
