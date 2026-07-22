# FairShare Bill Splitter

A private, dependency-free bill splitter. The project layout uses [`index.html`](index.html) for markup, [`css/styles.css`](css/styles.css) for styles, [`js/app.js`](js/app.js) for application logic, and [`assets/exchange-rates.json`](assets/exchange-rates.json) for exchange rates.

## Use it

Serve this directory with any static web server, then open `index.html` in a modern browser. For example, run `python -m http.server` and visit `http://localhost:8000`. A server is required so the browser can load the exchange-rate JSON file.

1. Add everyone in the group.
2. Add an expense with its date, total, and one or more payer contributions.
3. Select who participated, exclude anyone who should not share the expense, and split the cost equally, by exact amounts, percentages, or weighted shares.
4. Review each person's net balance and the suggested payments.

## Features

- Any number of people and dated expenses
- Multiple payers on one expense
- Per-expense participant exclusion
- Equal, exact, percentage, and weighted-share splits
- Edit and delete expenses; rename and remove unused people
- Per-person net totals and explicit “who pays whom” settlements
- Optional debt simplification to reduce the number of payments
- USD, EUR, GBP, CAD, and AUD display formats
- Conversion of results between USD, EUR, GBP, CAD, and AUD
- JSON import and export for transferring or backing up data
- Responsive, keyboard-accessible interface
- Automatic browser-local persistence and a reset control

## Calculation rules

Money is represented internally as integer cents. Payer contributions and participant obligations must each equal the expense total before it can be saved.

Expenses remain stored in the selected expense currency, which is locked while expenses exist. Totals, balances, and suggested payments are converted for display into the selected results currency using the rates in [`assets/exchange-rates.json`](assets/exchange-rates.json). Rates are relative to the file's `base` currency and converted amounts are rounded to the nearest cent.

For proportional splits, FairShare uses deterministic largest-remainder allocation. Whole cents are assigned first, then leftover cents go to participants with the largest fractional remainders in group order. This guarantees that every split sums exactly to the original expense.

“Simplify debts” preserves every person's final net balance while matching debtors directly to creditors to use fewer transfers. Turning it off shows obligations aggregated from each individual expense.

## Data and privacy

Data is stored only for the current browser tab using `sessionStorage`; nothing is uploaded. Closing the tab, clearing site data, or choosing **Reset data** removes it. Use **Export** to save a JSON backup and **Import** to restore one. There is no cloud sync or multi-device collaboration.
