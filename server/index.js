"use strict";

require("dotenv").config();
const http = require("node:http");
const { createApp } = require("./app");
const { CollaborationHub } = require("./collaboration");

async function start() {
  const { app, store, sessionMiddleware } = await createApp();
  const server = http.createServer(app);
  const hub = new CollaborationHub({ server, sessionMiddleware, store });
  app.locals.hub = hub;
  const port = Number(process.env.PORT) || 3000;
  server.listen(port, () => {
    console.log(`FairShare is running at ${process.env.BASE_URL || `http://localhost:${port}`}`);
  });
}

start().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
