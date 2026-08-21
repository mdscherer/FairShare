"use strict";

const path = require("node:path");
const express = require("express");
const session = require("express-session");
const FileStoreFactory = require("session-file-store");
const helmet = require("helmet");
const { Passport } = require("passport");
const { Strategy: GoogleStrategy } = require("passport-google-oauth20");
const { ReportStore } = require("./storage");

async function createApp(options = {}) {
  const root = path.resolve(__dirname, "..");
  const dataDir = path.resolve(options.dataDir || process.env.DATA_DIR || path.join(root, "data"));
  const publicDirectories = ["css", "js", "assets"].map((name) => path.join(root, name));
  if (publicDirectories.some((directory) => dataDir === directory || dataDir.startsWith(`${directory}${path.sep}`))) {
    throw new Error("DATA_DIR must not be inside a publicly served directory.");
  }
  const store = options.store || new ReportStore(dataDir);
  await store.initialize();

  const app = express();
  if (process.env.NODE_ENV === "production") app.set("trust proxy", 1);
  app.disable("x-powered-by");
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        styleSrc: ["'self'", "https://cdnjs.cloudflare.com"],
        fontSrc: ["'self'", "https://cdnjs.cloudflare.com", "data:"],
        scriptSrc: ["'self'"],
        connectSrc: ["'self'", "ws:", "wss:"],
        imgSrc: ["'self'", "data:"]
      }
    }
  }));

  const FileStore = FileStoreFactory(session);
  const sessionSecret = process.env.SESSION_SECRET ||
    (process.env.NODE_ENV === "test" ? "test-secret-not-for-production-123456" : "");
  if (sessionSecret.length < 32) {
    throw new Error("SESSION_SECRET must contain at least 32 characters.");
  }
  const sessionMiddleware = session({
    name: "fairshare.sid",
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: 7 * 24 * 60 * 60 * 1000
    },
    store: new FileStore({
      path: path.resolve(options.sessionDir || path.join(root, "sessions")),
      retries: 1,
      logFn() {}
    })
  });

  const passport = new Passport();
  passport.serializeUser((user, done) => done(null, user));
  passport.deserializeUser((user, done) => done(null, user));
  configureGoogle(passport, store);

  app.use(sessionMiddleware);
  app.use(passport.initialize());
  app.use(passport.session());
  if (options.userResolver) {
    app.use(async (req, _res, next) => {
      try {
        const user = await options.userResolver(req);
        if (user) {
          req.user = user;
          req.session.passport = { user };
        }
        next();
      } catch (error) {
        next(error);
      }
    });
  }
  app.use(express.json({ limit: "5mb", type: "application/json" }));

  app.get("/api/auth/me", (req, res) => {
    res.json({ user: req.user ? publicIdentity(req.user) : null, googleConfigured: googleConfigured() });
  });

  app.get("/auth/google", (req, res, next) => {
    if (!googleConfigured()) return res.status(503).send("Google sign-in is not configured.");
    if (typeof req.query.returnTo === "string" && /^\/(?![\\/])/.test(req.query.returnTo)) {
      req.session.returnTo = req.query.returnTo;
    }
    passport.authenticate("google", {
      scope: ["profile", "email"],
      prompt: "select_account",
      state: true
    })(req, res, next);
  });

  app.get("/auth/google/callback", (req, res, next) => {
    if (!googleConfigured()) return res.status(503).send("Google sign-in is not configured.");
    passport.authenticate("google", { failureRedirect: "/?auth=failed" }, async (error, user) => {
      if (error || !user) return res.redirect("/?auth=failed");
      req.logIn(user, async (loginError) => {
        if (loginError) return next(loginError);
        try {
          await store.claimPending(user);
          const returnTo = req.session.returnTo || "/";
          delete req.session.returnTo;
          res.redirect(returnTo);
        } catch (claimError) {
          next(claimError);
        }
      });
    })(req, res, next);
  });

  app.post("/api/auth/logout", requireJson, (req, res, next) => {
    req.logout((error) => {
      if (error) return next(error);
      req.session.destroy((sessionError) => {
        if (sessionError) return next(sessionError);
        res.clearCookie("fairshare.sid");
        res.status(204).end();
      });
    });
  });

  const api = express.Router();
  api.use(requireAuth);
  api.get("/reports", asyncRoute(async (req, res) => {
    await store.claimPending(req.user);
    res.json({ reports: await store.listReports(req.user.id) });
  }));
  api.post("/reports", requireJson, verifyOrigin, asyncRoute(async (req, res) => {
    const report = await store.createReport(req.user, req.body);
    res.status(201).json({ report });
  }));
  api.get("/reports/:reportId", asyncRoute(async (req, res) => {
    res.json({ report: await store.getReport(req.user.id, req.params.reportId) });
  }));
  api.put("/reports/:reportId", requireJson, verifyOrigin, asyncRoute(async (req, res) => {
    const report = await store.updateReport(req.user.id, req.params.reportId, req.body);
    req.app.locals.hub?.broadcast(report, req.user.id);
    res.json({ report });
  }));
  api.get("/reports/:reportId/sharing", asyncRoute(async (req, res) => {
    res.json(await store.getSharing(req.user.id, req.params.reportId));
  }));
  api.post("/reports/:reportId/invitations", requireJson, verifyOrigin, asyncRoute(async (req, res) => {
    const invitation = await store.inviteEmail(req.user.id, req.params.reportId, req.body.email);
    res.status(201).json({ invitation });
  }));
  api.delete("/reports/:reportId/invitations/:invitationId", requireJson, verifyOrigin, asyncRoute(async (req, res) => {
    await store.removeInvitation(req.user.id, req.params.reportId, req.params.invitationId);
    res.status(204).end();
  }));
  api.post("/reports/:reportId/links", requireJson, verifyOrigin, asyncRoute(async (req, res) => {
    const link = await store.createLink(req.user.id, req.params.reportId);
    res.status(201).json({ link });
  }));
  api.delete("/reports/:reportId/links/:linkId", requireJson, verifyOrigin, asyncRoute(async (req, res) => {
    await store.revokeLink(req.user.id, req.params.reportId, req.params.linkId);
    res.status(204).end();
  }));
  api.delete("/reports/:reportId/editors/:editorId", requireJson, verifyOrigin, asyncRoute(async (req, res) => {
    await store.removeEditor(req.user.id, req.params.reportId, req.params.editorId);
    req.app.locals.hub?.revoke(req.params.reportId, req.params.editorId);
    res.status(204).end();
  }));
  api.post("/invitations/link", requireJson, verifyOrigin, asyncRoute(async (req, res) => {
    const report = await store.acceptLink(req.user, req.body.token);
    res.json({ report });
  }));
  app.use("/api", api);

  app.use("/css", express.static(path.join(root, "css")));
  app.use("/js", express.static(path.join(root, "js")));
  app.use("/assets", express.static(path.join(root, "assets")));
  app.get("/", (_req, res) => res.sendFile(path.join(root, "index.html")));

  app.use((error, req, res, _next) => {
    const status = Number.isInteger(error.status) ? error.status : 500;
    if (status >= 500) console.error(error);
    if (req.path.startsWith("/api/")) {
      const payload = { error: status >= 500 ? "The server could not complete the request." : error.message };
      if (error.latest) payload.latest = error.latest;
      return res.status(status).json(payload);
    }
    res.status(status).send(status >= 500 ? "Server error" : error.message);
  });

  return { app, store, sessionMiddleware };
}

function configureGoogle(passport, store) {
  if (!googleConfigured()) return;
  const baseUrl = (process.env.BASE_URL || "http://localhost:3000").replace(/\/$/, "");
  passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: `${baseUrl}/auth/google/callback`
  }, async (_accessToken, _refreshToken, profile, done) => {
    try {
      const email = profile.emails?.[0]?.value || "";
      const user = {
        id: store.userId("https://accounts.google.com", profile.id),
        name: profile.displayName || "Google user",
        email,
        emailVerified: profile._json?.email_verified === true
      };
      done(null, user);
    } catch (error) {
      done(error);
    }
  }));
}

function googleConfigured() {
  return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

function publicIdentity(user) {
  return { id: user.id, name: user.name, email: user.email };
}

function requireAuth(req, res, next) {
  if (!req.user?.id) return res.status(401).json({ error: "Sign in with Google to continue." });
  next();
}

function requireJson(req, res, next) {
  if (!req.is("application/json")) return res.status(415).json({ error: "Requests must use application/json." });
  next();
}

function verifyOrigin(req, res, next) {
  const origin = req.get("origin");
  if (!origin) return next();
  const expected = `${req.protocol}://${req.get("host")}`;
  if (origin !== expected) return res.status(403).json({ error: "Cross-origin request rejected." });
  next();
}

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

module.exports = { createApp };
