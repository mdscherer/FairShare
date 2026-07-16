# FairShare Bill Splitter

A private, dependency-free bill splitter. The entire app—markup, styling, calculations, and persistence—is contained in [`index.html`](index.html).

## Use it

Open `index.html` in a modern browser. No install, server, account, or internet connection is required.

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
- JSON import and export for transferring or backing up data
- Responsive, keyboard-accessible interface
- Automatic browser-local persistence and a reset control

## Calculation rules

Money is represented internally as integer cents. Payer contributions and participant obligations must each equal the expense total before it can be saved.

For proportional splits, FairShare uses deterministic largest-remainder allocation. Whole cents are assigned first, then leftover cents go to participants with the largest fractional remainders in group order. This guarantees that every split sums exactly to the original expense.

“Simplify debts” preserves every person's final net balance while matching debtors directly to creditors to use fewer transfers. Turning it off shows obligations aggregated from each individual expense.

## Data and privacy

Data is stored only for the current browser tab using `sessionStorage`; nothing is uploaded. Closing the tab, clearing site data, or choosing **Reset data** removes it. Use **Export** to save a JSON backup and **Import** to restore one. There is no cloud sync or multi-device collaboration.
