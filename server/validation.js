"use strict";

const CURRENCIES = new Set(["USD", "EUR", "GBP", "CAD", "AUD"]);
const SAFE_ID = /^[A-Za-z][A-Za-z0-9_-]{0,99}$/;
const SPLIT_MODES = new Set(["equal", "exact", "percent", "shares"]);

function validateState(value) {
  if (!value || typeof value !== "object" || !Array.isArray(value.people) || !Array.isArray(value.expenses)) {
    throw validationError("Invalid FairShare report.");
  }

  const personIds = new Set();
  const personNames = new Set();
  const people = value.people.map((person) => {
    const name = typeof person?.name === "string" ? person.name.trim() : "";
    if (!person || typeof person.id !== "string" || !SAFE_ID.test(person.id) || personIds.has(person.id) ||
        !name || name.length > 50 || personNames.has(name.toLocaleLowerCase())) {
      throw validationError("Invalid people data.");
    }
    personIds.add(person.id);
    personNames.add(name.toLocaleLowerCase());
    return { id: person.id, name };
  });

  const expenseIds = new Set();
  const expenses = value.expenses.map((expense) => {
    if (!expense || typeof expense.id !== "string" || !SAFE_ID.test(expense.id) || expenseIds.has(expense.id) ||
        typeof expense.description !== "string" || !expense.description.trim() || expense.description.trim().length > 100 ||
        typeof expense.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(expense.date) ||
        Number.isNaN(new Date(`${expense.date}T12:00:00`).getTime()) ||
        !Number.isSafeInteger(expense.total) || expense.total <= 0 || !SPLIT_MODES.has(expense.splitMode)) {
      throw validationError("Invalid expense data.");
    }
    expenseIds.add(expense.id);
    const paid = validateAmounts(expense.paid, personIds);
    const owed = validateAmounts(expense.owed, personIds);
    if (sum(paid) !== expense.total || sum(owed) !== expense.total) {
      throw validationError("Expense allocations do not balance.");
    }
    const splitDetails = {};
    if (expense.splitDetails && typeof expense.splitDetails === "object" && !Array.isArray(expense.splitDetails)) {
      for (const [id, amount] of Object.entries(expense.splitDetails)) {
        if (personIds.has(id) && Number.isFinite(amount) && amount >= 0) splitDetails[id] = amount;
      }
    }
    return {
      id: expense.id,
      description: expense.description.trim(),
      date: expense.date,
      total: expense.total,
      paid,
      owed,
      splitMode: expense.splitMode,
      splitDetails,
      createdAt: Number.isFinite(expense.createdAt) ? expense.createdAt : Date.now(),
      updatedAt: Number.isFinite(expense.updatedAt) ? expense.updatedAt : Date.now()
    };
  });

  return {
    people,
    expenses,
    currency: CURRENCIES.has(value.currency) ? value.currency : "USD",
    resultCurrency: CURRENCIES.has(value.resultCurrency)
      ? value.resultCurrency
      : (CURRENCIES.has(value.currency) ? value.currency : "USD"),
    expenseView: value.expenseView === "list" ? "list" : "grid",
    simplify: value.simplify !== false
  };
}

function validateAmounts(amounts, personIds) {
  if (!amounts || typeof amounts !== "object" || Array.isArray(amounts)) {
    throw validationError("Invalid expense allocations.");
  }
  const entries = Object.entries(amounts);
  if (!entries.length || entries.some(([id, amount]) =>
    !personIds.has(id) || !Number.isSafeInteger(amount) || amount < 0
  )) {
    throw validationError("Invalid expense allocations.");
  }
  return Object.fromEntries(entries);
}

function sum(amounts) {
  return Object.values(amounts).reduce((total, amount) => total + amount, 0);
}

function validateTitle(value) {
  const title = typeof value === "string" ? value.trim() : "";
  if (!title || title.length > 100) throw validationError("Report name must be between 1 and 100 characters.");
  return title;
}

function validationError(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

module.exports = { validateState, validateTitle };
