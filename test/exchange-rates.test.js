"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { buildExchangeRates } = require("../scripts/update-exchange-rates");

const date = "2026-08-20";
const records = [
  { date, base: "EUR", quote: "USD", rate: 1.2 },
  { date, base: "EUR", quote: "EUR", rate: 1 },
  { date, base: "EUR", quote: "GBP", rate: 0.9 },
  { date, base: "EUR", quote: "CAD", rate: 1.5 },
  { date, base: "EUR", quote: "AUD", rate: 1.8 }
];

test("buildExchangeRates converts API rates to a USD base", () => {
  assert.deepEqual(buildExchangeRates(records), {
    base: "USD",
    updatedAt: date,
    rates: {
      USD: 1,
      EUR: 1 / 1.2,
      GBP: 0.9 / 1.2,
      CAD: 1.5 / 1.2,
      AUD: 1.8 / 1.2
    }
  });
});

test("buildExchangeRates rejects inconsistent rate dates", () => {
  const inconsistent = records.map((record) => (
    record.quote === "GBP" ? { ...record, date: "2026-08-19" } : record
  ));

  assert.throws(
    () => buildExchangeRates(inconsistent),
    /missing a valid GBP rate/
  );
});
