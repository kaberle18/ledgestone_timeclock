// Vercel serverless entrypoint. An Express app is a plain (req, res) handler,
// so exporting it is all Vercel needs. Static files in public/ are served by
// Vercel directly (see vercel.json); everything under /api lands here.
// Requires DATABASE_URL (e.g. the Neon Postgres integration) — serverless
// functions have no persistent disk for the local SQLite fallback.
const { createApp } = require('../server');

module.exports = createApp();
