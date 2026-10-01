# Time Clock

A simple time clock web app.

- **Accounts** – sign up with any email + password (no verification). Passwords are hashed with bcrypt; sessions use an httpOnly cookie.
- **Clock in / clock out** – one button, with a live timer while you're on the clock.
- **History & totals** – filter by **Day**, **Week**, **Weeks** (2–8 week span, e.g. a pay period), or **Month**, step back and forward with ‹ ›, and see the total hours for that range. Each row shows clock in, clock out, hours for that shift, and the running cumulative total.
- **Add past entries** – **+ Add entry** logs a shift you forgot to clock (date, clock in, clock out). If clock out is earlier than clock in it's treated as an overnight shift. Entries can't be in the future or overlap an existing shift.
- **Delete entries** – each row has a **Delete** button that opens a confirmation pop-up showing the entry first (Cancel is the default). Deleting the shift you're currently on clocks you out without saving it.
- **Data tab (activity log)** – a permanent paper trail of everything done on the account: account created, sign-ins (and failed sign-in attempts), sign-outs, clock in/out, past entries added, entries deleted (with a full copy of the deleted record), and PDF exports. Each event records the exact time, IP address and device. The log is append-only (there is no way to edit or delete it), each action and its log record are saved in the same database transaction, and it can be filtered by action or downloaded as CSV.
- **Works at any width** – full desktop, half-screen windows, tablets and phones (on phones each entry shows as a compact card).
- **PDF export** – one page, US Letter portrait. The top shows the date range and total hours worked; below it is every transaction in the range (date, clock in, clock out, hours, cumulative hours). With a lot of entries the table shrinks its text to stay on one page; past ~90 rows it notes how many entries were left off (they're still counted in the total).

## Deploy on Vercel

Same setup as Horizon Pro: the code lives on GitHub and Vercel redeploys on every push to `main`.

1. In Vercel: **Add New → Project**, import `kaberle18/ledgestone_timeclock`. Leave the framework as **Other**; `vercel.json` already sets everything.
2. In the project: **Storage → Connect Database → Neon (Postgres)**. This injects `DATABASE_URL`. Tables are created automatically on the first request.
3. Optional: **Settings → Environment Variables →** add `JWT_SECRET` (any long random string). If unset, one is generated and stored in the database.
4. Redeploy (or push to `main`). Done.

Vercel functions have no permanent disk, so `DATABASE_URL` is required there. Session cookies are marked `Secure` automatically on Vercel.

**Troubleshooting:** open `https://<your-site>/api/health`. It shows `{"ok":true,"database":"postgres"}` when everything is connected, or the exact problem (for example, `DATABASE_URL` missing or pasted wrong). Changes to environment variables only take effect after a redeploy.

## Run it locally

Requires **Node.js 22** (22.13+; uses the built-in `node:sqlite` when no Postgres is configured).

```bash
npm install
npm start          # http://localhost:3000
npm test
```

Without `DATABASE_URL`, data goes in a local SQLite file at `data/timeclock.db` (git-ignored), so there's nothing to set up. With `DATABASE_URL`, it uses Postgres, just like production.

| Env var | Default | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | unset (→ SQLite) | Postgres connection string (Neon on Vercel) |
| `JWT_SECRET` | auto-generated and stored in the DB | Session signing secret |
| `PGSSL` | SSL on | Set to `false` for a local Postgres without SSL |
| `PORT` | `3000` | HTTP port (local server only) |
| `DB_FILE` | `data/timeclock.db` | SQLite path (local only) |
| `COOKIE_SECURE` | on when running on Vercel | Set to `1` to force `Secure` cookies elsewhere |

`npm test` runs against in-memory SQLite. To run the same tests against a throwaway Postgres database: `TEST_DATABASE_URL=postgres://... npm test` (it drops and recreates the tables).

## How it works

| File | What it does |
| --- | --- |
| `api/index.js` | Vercel serverless entry (wraps the Express app) |
| `server.js` | Express API: register/login/logout, clock in/out, list entries for a date range, PDF export |
| `db.js` | Database layer (`users`, `entries`, `activity`): Postgres when `DATABASE_URL` is set, otherwise SQLite |
| `pdf.js` | One-page PDF report (PDFKit) |
| `public/` | The web UI (plain HTML/CSS/JS) |
| `test/` | API + PDF tests (`node --test`) |

Times are stored in UTC. The browser computes the selected range in your local time and sends your time zone with the export, so the PDF shows the same times you see on screen. A shift belongs to the day/period it was **clocked in** on. A shift that's still open counts up to "now" and shows as *In progress*.
