# FairShare Bill Splitter

A collaborative bill splitter using Google sign-in, filesystem-backed JSON reports, and live WebSocket updates. The browser interface remains plain HTML, CSS, and JavaScript; the Node.js server handles authentication, authorization, persistence, and sharing.

## Local setup

FairShare requires Node.js 20 or newer.

1. Run `npm install`.
2. Copy `.env.example` to `.env` and replace the example secrets.
3. In Google Cloud Console, create an OAuth 2.0 Web application and add `http://localhost:3000/auth/google/callback` as an authorized redirect URI.
4. Run `npm start` and visit `http://localhost:3000`.

`SESSION_SECRET` must be a random value of at least 32 characters. In production, set `BASE_URL` to the public HTTPS origin and register its `/auth/google/callback` URL with Google. The server trusts a reverse proxy only in production and marks session cookies secure there.

Run the automated checks with `npm test`.

## Exchange rates

Run `npm run update:exchange-rates` to refresh `assets/exchange-rates.json` from Frankfurter. The updater requires no configuration or additional dependencies and preserves the existing file if the request or response validation fails.

It can be run from any working directory, which makes it suitable for cron. For example, this updates the rates every day at 03:00:

```cron
0 3 * * * /usr/bin/node /path/to/FairShare/scripts/update-exchange-rates.js
```

## Use it

1. Add everyone in the group.
2. Add an expense with its date, total, and one or more payer contributions.
3. Select who participated, exclude anyone who should not share the expense, and split the cost equally, by exact amounts, percentages, or weighted shares.
4. Give the report a name and sign in with Google. Changes then autosave to the server.
5. Use **Share** to invite another Google account by email or create a private edit link.
6. Review each person's net balance and the suggested payments. Collaborator changes appear live.

## Features

- Any number of people and dated expenses
- Multiple payers on one expense
- Per-expense participant exclusion
- Equal, exact, percentage, and weighted-share splits
- Edit and delete expenses; rename and remove unused people
- Switchable list and grid views for expenses
- Per-person net totals and explicit “who pays whom” settlements
- Optional debt simplification to reduce the number of payments
- USD, EUR, GBP, CAD, and AUD display formats
- Conversion of results between USD, EUR, GBP, CAD, and AUD
- JSON import for migrating existing local reports
- Responsive, keyboard-accessible interface
- Named server reports, autosaving, and a retry/flush Save control
- Owner-managed email and private-link sharing
- Live updates with revision conflict protection
- Browser-local guest drafts and a reset control

## Calculation rules

Money is represented internally as integer cents. Payer contributions and participant obligations must each equal the expense total before it can be saved.

Expenses remain stored in the selected expense currency, which is locked while expenses exist. Totals, balances, and suggested payments are converted for display into the selected results currency using the rates in [`assets/exchange-rates.json`](assets/exchange-rates.json). Rates are relative to the file's `base` currency and converted amounts are rounded to the nearest cent.

For proportional splits, FairShare uses deterministic largest-remainder allocation. Whole cents are assigned first, then leftover cents go to participants with the largest fractional remainders in group order. This guarantees that every split sums exactly to the original expense.

“Simplify debts” preserves every person's final net balance while matching debtors directly to creditors to use fewer transfers. Turning it off shows obligations aggregated from each individual expense.

## Data and privacy

Unsigned-in drafts are stored in the current browser tab using `sessionStorage`. After sign-in, named reports are uploaded and autosaved as JSON under `data/users/<owner-id>/reports/`. User and report directory names are server-generated or derived from a one-way hash; client input is never used as a filesystem path.

Reports remain in the owner's directory when shared. Access-control lists, per-user report indexes, pending email invitations, and hashed private-link tokens are stored under `data/`. Private link tokens are shown only when created; only their hashes are persisted. The `data/`, `sessions/`, `.env`, and `node_modules/` paths are ignored by Git and are never exposed as static routes.

The filesystem store is intended as an initial single-server persistence layer. Back up `data/` and `sessions/`, and do not run multiple application instances against the same directory. A database and shared session store should replace it before horizontal scaling.
