#!/usr/bin/env node

"use strict";

const { rename, unlink, writeFile } = require("node:fs/promises");
const path = require("node:path");

const API_URL = "https://api.frankfurter.dev/v2/rates";
const OUTPUT_PATH = path.resolve(__dirname, "..", "assets", "exchange-rates.json");
const CURRENCIES = ["USD", "EUR", "GBP", "CAD", "AUD"];

function buildExchangeRates(records) {
  if (!Array.isArray(records)) {
    throw new Error("The exchange-rate API returned an invalid response.");
  }

  const relevantRates = new Map(
    records
      .filter((record) => CURRENCIES.includes(record?.quote))
      .map((record) => [record.quote, record])
  );
  const usd = relevantRates.get("USD");

  if (!usd || typeof usd.base !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(usd.date)) {
    throw new Error("The exchange-rate API response is missing the USD reference rate.");
  }

  const rates = {};
  for (const currency of CURRENCIES) {
    const record = relevantRates.get(currency);
    if (
      !record ||
      record.base !== usd.base ||
      record.date !== usd.date ||
      typeof record.rate !== "number" ||
      !Number.isFinite(record.rate) ||
      record.rate <= 0
    ) {
      throw new Error(`The exchange-rate API response is missing a valid ${currency} rate.`);
    }
    rates[currency] = currency === "USD" ? 1 : record.rate / usd.rate;
  }

  return {
    base: "USD",
    updatedAt: usd.date,
    rates
  };
}

async function replaceFile(filePath, contents) {
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  try {
    await writeFile(temporaryPath, contents, "utf8");
    await rename(temporaryPath, filePath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => {});
    throw error;
  }
}

async function main() {
  const response = await fetch(API_URL, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(15_000)
  });
  if (!response.ok) {
    throw new Error(`Exchange-rate request failed with status ${response.status}.`);
  }

  const exchangeRates = buildExchangeRates(await response.json());
  await replaceFile(OUTPUT_PATH, `${JSON.stringify(exchangeRates, null, 2)}\n`);
  console.log(`Updated ${OUTPUT_PATH} with rates from ${exchangeRates.updatedAt}.`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Could not update exchange rates: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { buildExchangeRates };
