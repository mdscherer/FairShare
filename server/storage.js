"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const { validateState, validateTitle } = require("./validation");

class ReportStore {
  constructor(root) {
    this.root = path.resolve(root);
    this.locks = new Map();
  }

  userId(issuer, subject) {
    return crypto.createHash("sha256").update(`${issuer}:${subject}`).digest("hex");
  }

  emailHash(email) {
    return crypto.createHash("sha256").update(normalizeEmail(email)).digest("hex");
  }

  async initialize() {
    await Promise.all(["users", "report-index", "link-index", "access", "pending"].map((name) =>
      fs.mkdir(path.join(this.root, name), { recursive: true })
    ));
  }

  async createReport(user, input) {
    const title = validateTitle(input.title);
    const state = validateState(input.state);
    return this.withLock(`user:${user.id}`, async () => {
      const reports = await this.listReports(user.id);
      if (reports.some((report) => report.role === "owner" && report.title.toLocaleLowerCase() === title.toLocaleLowerCase())) {
        throw httpError(409, "You already have a report with that name.");
      }
      const now = new Date().toISOString();
      const report = {
        schemaVersion: 1,
        id: crypto.randomUUID(),
        title,
        owner: publicUser(user),
        editors: [],
        invitations: [],
        links: [],
        revision: 1,
        createdAt: now,
        updatedAt: now,
        state
      };
      await fs.mkdir(this.userReportsDir(user.id), { recursive: true });
      await this.writeJson(this.reportPath(user.id, report.id), report);
      await this.writeJson(this.reportIndexPath(report.id), { ownerId: user.id });
      await this.addAccess(user.id, report.id, "owner");
      return this.present(report, user.id);
    });
  }

  async listReports(userId) {
    const access = await this.readJson(this.accessPath(userId), []);
    const reports = [];
    for (const entry of access) {
      try {
        const report = await this.getRaw(entry.reportId);
        const role = roleFor(report, userId);
        if (!role) continue;
        reports.push({
          id: report.id,
          title: report.title,
          role,
          owner: report.owner,
          revision: report.revision,
          updatedAt: report.updatedAt
        });
      } catch (error) {
        if (error.status !== 404) throw error;
      }
    }
    return reports.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async getReport(userId, reportId) {
    const report = await this.getRaw(reportId);
    if (!roleFor(report, userId)) throw httpError(403, "You do not have access to this report.");
    return this.present(report, userId);
  }

  async canAccess(userId, reportId) {
    try {
      const report = await this.getRaw(reportId);
      return Boolean(roleFor(report, userId));
    } catch {
      return false;
    }
  }

  async updateReport(userId, reportId, input) {
    const indexedReport = await this.getRaw(reportId);
    return this.withLock(`user:${indexedReport.owner.id}`, () => this.withLock(`report:${reportId}`, async () => {
      const report = await this.getRaw(reportId);
      if (!roleFor(report, userId)) throw httpError(403, "You do not have access to this report.");
      if (!Number.isInteger(input.baseRevision) || input.baseRevision !== report.revision) {
        const error = httpError(409, "This report was changed by another user.");
        error.latest = this.present(report, userId);
        throw error;
      }
      const title = validateTitle(input.title);
      if (title.toLocaleLowerCase() !== report.title.toLocaleLowerCase()) {
        const reports = await this.listReports(report.owner.id);
        if (reports.some((item) => item.id !== report.id && item.role === "owner" &&
            item.title.toLocaleLowerCase() === title.toLocaleLowerCase())) {
          throw httpError(409, "You already have a report with that name.");
        }
      }
      report.title = title;
      report.state = validateState(input.state);
      report.revision += 1;
      report.updatedAt = new Date().toISOString();
      await this.writeJson(this.reportPath(report.owner.id, report.id), report);
      return this.present(report, userId);
    }));
  }

  async getSharing(ownerId, reportId) {
    const report = await this.requireOwner(ownerId, reportId);
    return {
      editors: report.editors,
      invitations: report.invitations.map(({ emailHash, ...invite }) => invite),
      links: report.links.map(({ tokenHash, ...link }) => link)
    };
  }

  async inviteEmail(ownerId, reportId, email) {
    const normalized = normalizeEmail(email);
    if (!isEmail(normalized)) throw httpError(400, "Enter a valid Google account email.");
    return this.withLock(`report:${reportId}`, async () => {
      const report = await this.requireOwner(ownerId, reportId);
      if (normalizeEmail(report.owner.email) === normalized ||
          report.editors.some((editor) => normalizeEmail(editor.email) === normalized)) {
        throw httpError(409, "That user already has access.");
      }
      const emailHash = this.emailHash(normalized);
      if (report.invitations.some((invite) => invite.emailHash === emailHash)) {
        throw httpError(409, "That email is already invited.");
      }
      const invitation = { id: crypto.randomUUID(), email: normalized, emailHash, createdAt: new Date().toISOString() };
      report.invitations.push(invitation);
      report.updatedAt = new Date().toISOString();
      await this.writeJson(this.reportPath(report.owner.id, report.id), report);
      await this.updateList(this.pendingPath(emailHash), (items) => [
        ...items.filter((item) => item.reportId !== report.id),
        { reportId: report.id }
      ]);
      return { id: invitation.id, email: invitation.email, createdAt: invitation.createdAt };
    });
  }

  async removeInvitation(ownerId, reportId, invitationId) {
    return this.withLock(`report:${reportId}`, async () => {
      const report = await this.requireOwner(ownerId, reportId);
      const invitation = report.invitations.find((item) => item.id === invitationId);
      if (!invitation) throw httpError(404, "Invitation not found.");
      report.invitations = report.invitations.filter((item) => item.id !== invitationId);
      await this.writeJson(this.reportPath(report.owner.id, report.id), report);
      await this.updateList(this.pendingPath(invitation.emailHash), (items) =>
        items.filter((item) => item.reportId !== report.id)
      );
    });
  }

  async createLink(ownerId, reportId) {
    return this.withLock(`report:${reportId}`, async () => {
      const report = await this.requireOwner(ownerId, reportId);
      const token = crypto.randomBytes(32).toString("base64url");
      const link = {
        id: crypto.randomUUID(),
        tokenHash: hashToken(token),
        createdAt: new Date().toISOString()
      };
      report.links.push(link);
      await this.writeJson(this.reportPath(report.owner.id, report.id), report);
      await this.writeJson(this.linkIndexPath(link.tokenHash), { reportId: report.id, linkId: link.id });
      return { id: link.id, token, createdAt: link.createdAt };
    });
  }

  async revokeLink(ownerId, reportId, linkId) {
    return this.withLock(`report:${reportId}`, async () => {
      const report = await this.requireOwner(ownerId, reportId);
      const link = report.links.find((item) => item.id === linkId);
      if (!link) throw httpError(404, "Share link not found.");
      report.links = report.links.filter((item) => item.id !== linkId);
      await this.writeJson(this.reportPath(report.owner.id, report.id), report);
      await fs.rm(this.linkIndexPath(link.tokenHash), { force: true });
    });
  }

  async acceptLink(user, token) {
    if (typeof token !== "string" || token.length < 20) throw httpError(400, "Invalid share link.");
    const tokenHash = hashToken(token);
    const index = await this.readJson(this.linkIndexPath(tokenHash), null);
    if (!index?.reportId) throw httpError(404, "This share link is invalid or has been revoked.");
    const accepted = await this.withLock(`report:${index.reportId}`, async () => {
      const report = await this.getRaw(index.reportId);
      if (!report.links.some((link) => link.id === index.linkId && safeEqual(link.tokenHash, tokenHash))) return false;
      await this.addEditor(report, user);
      return true;
    });
    if (!accepted) throw httpError(404, "This share link is invalid or has been revoked.");
    return this.getReport(user.id, index.reportId);
  }

  async claimPending(user) {
    if (!user.emailVerified || !user.email) return [];
    const pendingPath = this.pendingPath(this.emailHash(user.email));
    const pending = await this.readJson(pendingPath, []);
    const processed = new Set(pending.map((item) => item.reportId));
    const accepted = [];
    for (const { reportId } of pending) {
      await this.withLock(`report:${reportId}`, async () => {
        const report = await this.getRaw(reportId);
        const emailHash = this.emailHash(user.email);
        if (!report.invitations.some((invite) => invite.emailHash === emailHash)) return;
        report.invitations = report.invitations.filter((invite) => invite.emailHash !== emailHash);
        await this.addEditor(report, user);
        accepted.push(reportId);
      });
    }
    await this.updateList(pendingPath, (items) => items.filter((item) => !processed.has(item.reportId)));
    return accepted;
  }

  async removeEditor(ownerId, reportId, editorId) {
    return this.withLock(`report:${reportId}`, async () => {
      const report = await this.requireOwner(ownerId, reportId);
      if (!report.editors.some((editor) => editor.id === editorId)) throw httpError(404, "Editor not found.");
      report.editors = report.editors.filter((editor) => editor.id !== editorId);
      await this.writeJson(this.reportPath(report.owner.id, report.id), report);
      await this.updateList(this.accessPath(editorId), (items) =>
        items.filter((item) => item.reportId !== report.id)
      );
    });
  }

  async addEditor(report, user) {
    if (report.owner.id !== user.id && !report.editors.some((editor) => editor.id === user.id)) {
      report.editors.push(publicUser(user));
    }
    report.updatedAt = new Date().toISOString();
    await this.writeJson(this.reportPath(report.owner.id, report.id), report);
    await this.addAccess(user.id, report.id, report.owner.id === user.id ? "owner" : "editor");
  }

  async requireOwner(userId, reportId) {
    const report = await this.getRaw(reportId);
    if (report.owner.id !== userId) throw httpError(403, "Only the report owner can manage sharing.");
    return report;
  }

  async getRaw(reportId) {
    if (!isUuid(reportId)) throw httpError(404, "Report not found.");
    const index = await this.readJson(this.reportIndexPath(reportId), null);
    if (!index?.ownerId || !/^[a-f0-9]{64}$/.test(index.ownerId)) throw httpError(404, "Report not found.");
    const report = await this.readJson(this.reportPath(index.ownerId, reportId), null);
    if (!report) throw httpError(404, "Report not found.");
    return report;
  }

  present(report, userId) {
    return {
      id: report.id,
      title: report.title,
      role: roleFor(report, userId),
      owner: report.owner,
      revision: report.revision,
      createdAt: report.createdAt,
      updatedAt: report.updatedAt,
      state: report.state
    };
  }

  async addAccess(userId, reportId, role) {
    await this.updateList(this.accessPath(userId), (items) => [
      ...items.filter((item) => item.reportId !== reportId),
      { reportId, role }
    ]);
  }

  async updateList(filename, transform) {
    return this.withLock(`file:${filename}`, async () => {
      const current = await this.readJson(filename, []);
      await this.writeJson(filename, transform(current));
    });
  }

  async readJson(filename, fallback) {
    try {
      return JSON.parse(await fs.readFile(filename, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return fallback;
      throw error;
    }
  }

  async writeJson(filename, value) {
    await fs.mkdir(path.dirname(filename), { recursive: true });
    const temporary = `${filename}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(value, null, 2), { encoding: "utf8", mode: 0o600 });
    await fs.rename(temporary, filename);
  }

  withLock(key, task) {
    const prior = this.locks.get(key) || Promise.resolve();
    const next = prior.then(task);
    const tracked = next.then(
      () => {
        if (this.locks.get(key) === tracked) this.locks.delete(key);
      },
      () => {
        if (this.locks.get(key) === tracked) this.locks.delete(key);
      }
    );
    this.locks.set(key, tracked);
    return next;
  }

  userReportsDir(userId) { return path.join(this.root, "users", userId, "reports"); }
  reportPath(userId, reportId) { return path.join(this.userReportsDir(userId), `${reportId}.json`); }
  reportIndexPath(reportId) { return path.join(this.root, "report-index", `${reportId}.json`); }
  linkIndexPath(tokenHash) { return path.join(this.root, "link-index", `${tokenHash}.json`); }
  accessPath(userId) { return path.join(this.root, "access", `${userId}.json`); }
  pendingPath(emailHash) { return path.join(this.root, "pending", `${emailHash}.json`); }
}

function roleFor(report, userId) {
  if (report.owner.id === userId) return "owner";
  if (report.editors.some((editor) => editor.id === userId)) return "editor";
  return null;
}

function publicUser(user) {
  return { id: user.id, name: user.name || "Google user", email: user.email || "" };
}

function normalizeEmail(email) {
  return typeof email === "string" ? email.trim().toLocaleLowerCase() : "";
}

function isEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254;
}

function isUuid(value) {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function safeEqual(left, right) {
  return typeof left === "string" && left.length === right.length &&
    crypto.timingSafeEqual(Buffer.from(left), Buffer.from(right));
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

module.exports = { ReportStore, httpError };
