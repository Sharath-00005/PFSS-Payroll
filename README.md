# PFSS Payroll on Netlify

Static pages + one Netlify Function + **Netlify Database** (managed Postgres). Your payroll data lives in your own Netlify project's database, not in Claude.

```
public/                          the screens (index.html, app.css, app.js)
netlify/functions/api.mjs        the API, served at /api/*
netlify/lib/                     API logic and storage code
netlify/database/migrations/     creates the tables (Netlify applies this on deploy)
netlify.toml                     publish folder and security headers
test/                            automated tests and a local test server
```

## Before you start

- A Netlify account on a **credit-based plan**. Netlify Database is not available on older plans, and an active database uses credits. Check your plan under Billing.
- A GitHub (or GitLab or Bitbucket) account to hold the code. Netlify deploys from there.

## Deploy

1. Create a new **private** repository and upload the contents of this folder.
2. In Netlify choose **Add new project > Import an existing project** and pick the repository. Leave the build command empty. `netlify.toml` sets the rest.
3. Before the first deploy finishes, open **Site configuration > Environment variables** and add
   `SETUP_KEY` = a long random string (20 or more characters). Keep a copy. You type it once, on the first visit.
4. Deploy. Because `@netlify/database` is listed in `package.json`, Netlify creates the Postgres database and runs the migration in `netlify/database/migrations/` as part of the deploy.
5. Open your site. The first screen asks for the setup key and your name. That account becomes the **manager** and can add everyone else under **Users**.
6. **Turn off or restrict Deploy Previews** for this site (Project configuration > Build and deploy). Netlify gives every preview a copy of the production database, and preview links are public, which would expose employee data.

Optional: add your own domain under Domain management. Netlify serves it over HTTPS.

## Roles

| Role | Can do |
|---|---|
| Payroll admin | Add sites, employees and attendance; calculate, validate, submit for approval; generate payslips |
| Manager | All of that, plus approve or reject payroll, change PF/ESI rates, manage users, backup, restore, delete data |
| Viewer | Look only |

The function enforces these rules, so they hold even if someone bypasses the screens. It also refuses changes to an approved month's attendance and to any closed month, and accepts an approval only for a payroll that was calculated, validated and submitted.

## Settings

| Variable | Needed | Meaning |
|---|---|---|
| `SETUP_KEY` | yes | Proves you own the site when creating the first manager. Without it, setup is refused so strangers cannot claim your site. |
| `SESSION_HOURS` | no (12) | How long a sign-in lasts without activity |

## Backups

1. **In the app (manager):** Settings > Download backup. Settings > Restore from backup loads a file again. Works for files up to about 5 MB, which covers many years for a few hundred employees. User accounts are not included.
2. **Database level:** it is standard Postgres. Netlify shows how to get a connection string with `netlify database connect --json` (Netlify CLI 26 or newer), and you can run `pg_dump` against it on a schedule. Keep copies outside Netlify and test a restore once.

## Try it on your computer first (no Netlify needed)

Needs Node 22.13 or newer.

```bash
npm run local        # http://localhost:8888, data in ./local-data, setup key: local-setup
npm test             # automated checks of roles, locking, approval, backup
```

This runs the same API code on a local SQLite file. To test against real Postgres locally, use the Netlify CLI (`netlify dev`), which starts a local Netlify Database.

## Good to know

- **No live push.** Netlify Functions cannot hold open connections, so each open browser tab asks a very small endpoint every 5 seconds whether anything changed (paused while the tab is hidden). Changes from teammates appear within about 5 seconds. Each open tab costs roughly 12 small requests per minute. To reduce that, raise `5000` in the `setInterval(pull,5000)` line of `public/app.js`.
- **Plain CSV bank file.** Edit `bankText()` in `public/app.js` to match your bank's upload format.
- **Default rates** for PF, ESI and professional tax are in Settings. Have your compliance advisor confirm them.
- Passwords are stored as salted scrypt hashes. After 5 wrong sign-ins from one address for one username, further attempts are blocked for 5 minutes.
