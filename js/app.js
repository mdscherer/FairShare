    (() => {
      "use strict";

      const STORAGE_KEY = "fairshare.bill-splitter.v1";
      const CURRENCIES = {
        USD: { locale: "en-US", symbol: "$" },
        EUR: { locale: "de-DE", symbol: "€" },
        GBP: { locale: "en-GB", symbol: "£" },
        CAD: { locale: "en-CA", symbol: "$" },
        AUD: { locale: "en-AU", symbol: "$" }
      };

      const emptyState = () => ({
        people: [],
        expenses: [],
        currency: "USD",
        resultCurrency: "USD",
        expenseView: "grid",
        simplify: true
      });

      let state = loadState();
      let exchangeRates = null;
      let editingExpenseId = null;
      let splitMode = "equal";
      let toastTimer = null;

      const $ = (selector) => document.querySelector(selector);
      const els = {
        currencySelect: $("#currencySelect"),
        resultCurrencySelect: $("#resultCurrencySelect"),
        peopleCount: $("#peopleCount"),
        personForm: $("#personForm"),
        personName: $("#personName"),
        peopleList: $("#peopleList"),
        addExpenseBtn: $("#addExpenseBtn"),
        importBtn: $("#importBtn"),
        exportBtn: $("#exportBtn"),
        importFile: $("#importFile"),
        expenseCount: $("#expenseCount"),
        listViewBtn: $("#listViewBtn"),
        gridViewBtn: $("#gridViewBtn"),
        expenseList: $("#expenseList"),
        expenseTable: $("#expenseTable"),
        expenseTableBody: $("#expenseTableBody"),
        expensesEmpty: $("#expensesEmpty"),
        totalSpending: $("#totalSpending"),
        simplifyToggle: $("#simplifyToggle"),
        balanceList: $("#balanceList"),
        settlementList: $("#settlementList"),
        resetBtn: $("#resetBtn"),
        dialog: $("#expenseDialog"),
        dialogTitle: $("#dialogTitle"),
        expenseForm: $("#expenseForm"),
        description: $("#expenseDescription"),
        date: $("#expenseDate"),
        amount: $("#expenseAmount"),
        currencySymbol: $("#currencySymbol"),
        payerRows: $("#payerRows"),
        owedRows: $("#owedRows"),
        splitTabs: $("#splitTabs"),
        owedColumnTitle: $("#owedColumnTitle"),
        paidStatus: $("#paidStatus"),
        owedStatus: $("#owedStatus"),
        formError: $("#formError"),
        closeDialogBtn: $("#closeDialogBtn"),
        cancelExpenseBtn: $("#cancelExpenseBtn"),
        deleteExpenseBtn: $("#deleteExpenseBtn"),
        toast: $("#toast")
      };

      function makeId(prefix) {
        if (globalThis.crypto && crypto.randomUUID) return `${prefix}_${crypto.randomUUID()}`;
        return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
      }

      function escapeHtml(value) {
        return String(value)
          .replaceAll("&", "&amp;")
          .replaceAll("<", "&lt;")
          .replaceAll(">", "&gt;")
          .replaceAll('"', "&quot;")
          .replaceAll("'", "&#039;");
      }

      function parseCents(value) {
        const normalized = String(value ?? "").trim().replace(/,/g, "");
        if (!/^\d+(?:\.\d{0,2})?$/.test(normalized)) return null;
        const [whole, fraction = ""] = normalized.split(".");
        const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
        return Number.isSafeInteger(cents) ? cents : null;
      }

      function centsToInput(cents) {
        return (Number(cents || 0) / 100).toFixed(2);
      }

      function formatMoney(cents) {
        return formatCurrency(cents, state.currency);
      }

      function formatCurrency(cents, currency) {
        const config = CURRENCIES[currency] || CURRENCIES.USD;
        return new Intl.NumberFormat(config.locale, {
          style: "currency",
          currency
        }).format((cents || 0) / 100);
      }

      function formatResultMoney(cents) {
        const target = state.resultCurrency || state.currency;
        if (target === state.currency) return formatCurrency(cents, target);
        const sourceRate = exchangeRates?.[state.currency];
        const targetRate = exchangeRates?.[target];
        if (!sourceRate || !targetRate) return formatCurrency(cents, state.currency);
        return formatCurrency(Math.round(cents * targetRate / sourceRate), target);
      }

      async function loadExchangeRates() {
        try {
          const response = await fetch("assets/exchange-rates.json", { cache: "no-store" });
          if (!response.ok) throw new Error(`Exchange-rate request failed with status ${response.status}.`);
          const data = await response.json();
          if (!data || typeof data !== "object" || !CURRENCIES[data.base] ||
              !data.rates || typeof data.rates !== "object") {
            throw new Error("The exchange-rate file has an invalid format.");
          }
          const rates = {};
          Object.keys(CURRENCIES).forEach((currency) => {
            const rate = data.rates[currency];
            if (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0) {
              throw new Error(`The exchange-rate file is missing a valid ${currency} rate.`);
            }
            rates[currency] = rate;
          });
          exchangeRates = rates;
          els.resultCurrencySelect.disabled = false;
          els.resultCurrencySelect.title = data.updatedAt
            ? `Exchange rates updated ${data.updatedAt}`
            : `Rates relative to ${data.base}`;
          renderBalances();
        } catch (error) {
          console.error(error);
          state.resultCurrency = state.currency;
          saveState();
          els.resultCurrencySelect.value = state.resultCurrency;
          els.resultCurrencySelect.disabled = true;
          els.resultCurrencySelect.title = "Exchange rates are unavailable";
          renderBalances();
          showToast("Could not load exchange rates. Results remain in the expense currency.");
        }
      }

      function allocateByWeights(totalCents, entries) {
        const valid = entries.filter((entry) => entry.weight > 0);
        const totalWeight = valid.reduce((sum, entry) => sum + entry.weight, 0);
        if (!valid.length || !Number.isFinite(totalWeight) || totalWeight <= 0) return {};

        const allocations = {};
        const remainders = [];
        let assigned = 0;
        valid.forEach((entry, index) => {
          const exact = totalCents * entry.weight / totalWeight;
          const floor = Math.floor(exact);
          allocations[entry.id] = floor;
          assigned += floor;
          remainders.push({ id: entry.id, remainder: exact - floor, index });
        });
        remainders.sort((a, b) => b.remainder - a.remainder || a.index - b.index);
        for (let i = 0; i < totalCents - assigned; i += 1) {
          allocations[remainders[i % remainders.length].id] += 1;
        }
        return allocations;
      }

      function calculateNets() {
        const nets = Object.fromEntries(state.people.map((person) => [person.id, 0]));
        state.expenses.forEach((expense) => {
          Object.entries(expense.paid).forEach(([id, cents]) => {
            if (id in nets) nets[id] += cents;
          });
          Object.entries(expense.owed).forEach(([id, cents]) => {
            if (id in nets) nets[id] -= cents;
          });
        });
        return nets;
      }

      function matchBalances(nets) {
        const debtors = [];
        const creditors = [];
        state.people.forEach((person, index) => {
          const amount = nets[person.id] || 0;
          if (amount < 0) debtors.push({ id: person.id, amount: -amount, index });
          if (amount > 0) creditors.push({ id: person.id, amount, index });
        });
        debtors.sort((a, b) => b.amount - a.amount || a.index - b.index);
        creditors.sort((a, b) => b.amount - a.amount || a.index - b.index);

        const transfers = [];
        let d = 0;
        let c = 0;
        while (d < debtors.length && c < creditors.length) {
          const amount = Math.min(debtors[d].amount, creditors[c].amount);
          if (amount > 0) transfers.push({ from: debtors[d].id, to: creditors[c].id, amount });
          debtors[d].amount -= amount;
          creditors[c].amount -= amount;
          if (debtors[d].amount === 0) d += 1;
          if (creditors[c].amount === 0) c += 1;
        }
        return transfers;
      }

      function rawTransfers() {
        const pairTotals = new Map();
        state.expenses.forEach((expense) => {
          const ids = new Set([...Object.keys(expense.paid), ...Object.keys(expense.owed)]);
          const expenseNets = {};
          ids.forEach((id) => {
            expenseNets[id] = (expense.paid[id] || 0) - (expense.owed[id] || 0);
          });
          const transfers = matchSpecificBalances(expenseNets, [...ids]);
          transfers.forEach(({ from, to, amount }) => {
            const forward = `${from}|${to}`;
            const reverse = `${to}|${from}`;
            const opposing = pairTotals.get(reverse) || 0;
            if (opposing >= amount) {
              pairTotals.set(reverse, opposing - amount);
            } else {
              pairTotals.delete(reverse);
              pairTotals.set(forward, (pairTotals.get(forward) || 0) + amount - opposing);
            }
          });
        });
        return [...pairTotals.entries()]
          .filter(([, amount]) => amount > 0)
          .map(([pair, amount]) => {
            const [from, to] = pair.split("|");
            return { from, to, amount };
          })
          .sort((a, b) => b.amount - a.amount);
      }

      function matchSpecificBalances(nets, orderedIds) {
        const debtors = orderedIds
          .filter((id) => (nets[id] || 0) < 0)
          .map((id) => ({ id, amount: -nets[id] }));
        const creditors = orderedIds
          .filter((id) => (nets[id] || 0) > 0)
          .map((id) => ({ id, amount: nets[id] }));
        const result = [];
        let d = 0;
        let c = 0;
        while (d < debtors.length && c < creditors.length) {
          const amount = Math.min(debtors[d].amount, creditors[c].amount);
          result.push({ from: debtors[d].id, to: creditors[c].id, amount });
          debtors[d].amount -= amount;
          creditors[c].amount -= amount;
          if (!debtors[d].amount) d += 1;
          if (!creditors[c].amount) c += 1;
        }
        return result;
      }

      function saveState() {
        try {
          sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state));
        } catch {
          showToast("Could not save to this browser.");
        }
      }

      function loadState() {
        try {
          const parsed = JSON.parse(sessionStorage.getItem(STORAGE_KEY));
          if (!parsed || !Array.isArray(parsed.people) || !Array.isArray(parsed.expenses)) return emptyState();
          return {
            people: parsed.people.filter((person) => person && typeof person.id === "string" && typeof person.name === "string"),
            expenses: parsed.expenses.filter(isValidStoredExpense),
            currency: CURRENCIES[parsed.currency] ? parsed.currency : "USD",
            resultCurrency: CURRENCIES[parsed.resultCurrency] ? parsed.resultCurrency : (CURRENCIES[parsed.currency] ? parsed.currency : "USD"),
            expenseView: parsed.expenseView === "list" ? "list" : "grid",
            simplify: parsed.simplify !== false
          };
        } catch {
          return emptyState();
        }
      }

      function isValidStoredExpense(expense) {
        return expense &&
          typeof expense.id === "string" &&
          typeof expense.description === "string" &&
          Number.isSafeInteger(expense.total) &&
          expense.total >= 0 &&
          expense.paid && typeof expense.paid === "object" &&
          expense.owed && typeof expense.owed === "object";
      }

      function parseImportedState(value) {
        if (!value || typeof value !== "object" || !Array.isArray(value.people) || !Array.isArray(value.expenses)) {
          throw new Error("The JSON file is not a FairShare export.");
        }

        const safeId = /^[A-Za-z][A-Za-z0-9_-]{0,99}$/;
        const personIds = new Set();
        const personNames = new Set();
        const people = value.people.map((person) => {
          const name = typeof person?.name === "string" ? person.name.trim() : "";
          if (!person || typeof person.id !== "string" || !safeId.test(person.id) || personIds.has(person.id) ||
              !name || name.length > 50 || personNames.has(name.toLocaleLowerCase())) {
            throw new Error("The file contains invalid people data.");
          }
          personIds.add(person.id);
          personNames.add(name.toLocaleLowerCase());
          return { id: person.id, name };
        });

        const expenseIds = new Set();
        const expenses = value.expenses.map((expense) => {
          if (!expense || typeof expense.id !== "string" || !safeId.test(expense.id) || expenseIds.has(expense.id) ||
              typeof expense.description !== "string" || !expense.description.trim() || expense.description.trim().length > 100 ||
              typeof expense.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(expense.date) ||
              Number.isNaN(new Date(`${expense.date}T12:00:00`).getTime()) ||
              !Number.isSafeInteger(expense.total) || expense.total <= 0 ||
              !["equal", "exact", "percent", "shares"].includes(expense.splitMode)) {
            throw new Error("The file contains invalid expense data.");
          }
          expenseIds.add(expense.id);

          const readAmounts = (amounts) => {
            if (!amounts || typeof amounts !== "object" || Array.isArray(amounts)) {
              throw new Error("The file contains invalid expense allocations.");
            }
            const entries = Object.entries(amounts);
            if (!entries.length || entries.some(([id, amount]) =>
              !personIds.has(id) || !Number.isSafeInteger(amount) || amount < 0
            )) {
              throw new Error("The file contains invalid expense allocations.");
            }
            return Object.fromEntries(entries);
          };

          const paid = readAmounts(expense.paid);
          const owed = readAmounts(expense.owed);
          if (Object.values(paid).reduce((sum, amount) => sum + amount, 0) !== expense.total ||
              Object.values(owed).reduce((sum, amount) => sum + amount, 0) !== expense.total) {
            throw new Error("An imported expense does not balance.");
          }

          const splitDetails = {};
          if (expense.splitDetails && typeof expense.splitDetails === "object" && !Array.isArray(expense.splitDetails)) {
            Object.entries(expense.splitDetails).forEach(([id, amount]) => {
              if (personIds.has(id) && Number.isFinite(amount) && amount >= 0) splitDetails[id] = amount;
            });
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
          currency: CURRENCIES[value.currency] ? value.currency : "USD",
          resultCurrency: CURRENCIES[value.resultCurrency]
            ? value.resultCurrency
            : (CURRENCIES[value.currency] ? value.currency : "USD"),
          expenseView: value.expenseView === "list" ? "list" : "grid",
          simplify: value.simplify !== false
        };
      }

      function personById(id) {
        return state.people.find((person) => person.id === id);
      }

      function initials(name) {
        return name.trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
      }

      function render() {
        els.currencySelect.value = state.currency;
        els.currencySelect.disabled = state.expenses.length > 0;
        els.currencySelect.title = state.expenses.length > 0
          ? "Reset or remove all expenses to change the expense currency"
          : "Currency used when entering expenses";
        els.resultCurrencySelect.value = state.resultCurrency;
        els.currencySymbol.textContent = CURRENCIES[state.currency].symbol;
        els.simplifyToggle.checked = state.simplify;
        renderPeople();
        renderExpenses();
        renderBalances();
      }

      function renderPeople() {
        els.peopleCount.textContent = String(state.people.length);
        if (!state.people.length) {
          els.peopleList.innerHTML = '<li class="empty"><strong>No one here yet</strong>Add everyone sharing expenses.</li>';
          return;
        }
        els.peopleList.innerHTML = state.people.map((person) => `
          <li class="person-row">
            <span class="avatar" aria-hidden="true">${escapeHtml(initials(person.name))}</span>
            <span class="person-name" title="${escapeHtml(person.name)}">${escapeHtml(person.name)}</span>
            <span class="person-actions">
              <button class="icon-btn" type="button" data-action="rename-person" data-id="${person.id}" aria-label="Rename ${escapeHtml(person.name)}">✎</button>
              <button class="icon-btn" type="button" data-action="delete-person" data-id="${person.id}" aria-label="Remove ${escapeHtml(person.name)}">✕</button>
            </span>
          </li>
        `).join("");
      }

      function renderExpenses() {
        const hasExpenses = state.expenses.length > 0;
        const listView = state.expenseView === "list";
        els.listViewBtn.setAttribute("aria-pressed", String(listView));
        els.gridViewBtn.setAttribute("aria-pressed", String(!listView));
        els.expensesEmpty.hidden = hasExpenses;
        els.expenseList.hidden = !hasExpenses || listView;
        els.expenseTable.hidden = !hasExpenses || !listView;
        els.expenseCount.textContent = `${state.expenses.length} ${state.expenses.length === 1 ? "purchase" : "purchases"}`;
        const sorted = [...state.expenses].sort((a, b) => b.date.localeCompare(a.date) || b.createdAt - a.createdAt);

        if (listView) {
          els.expenseList.innerHTML = "";
          els.expenseTableBody.innerHTML = sorted.map((expense) => `
            <tr>
              <td><time datetime="${escapeHtml(expense.date)}">${escapeHtml(formatExpenseDate(expense.date))}</time></td>
              <td>
                <button class="expense-list-edit" type="button" data-action="edit-expense" data-id="${expense.id}">
                  ${escapeHtml(expense.description)}
                </button>
              </td>
              <td class="expense-table-amount">${formatMoney(expense.total)}</td>
            </tr>
          `).join("");
          return;
        }

        els.expenseTableBody.innerHTML = "";
        els.expenseList.innerHTML = sorted.map((expense) => {
          const date = parseLocalDate(expense.date);
          const paidNames = Object.entries(expense.paid)
            .filter(([, amount]) => amount > 0)
            .map(([id, amount]) => `${personById(id)?.name || "Removed"} ${formatMoney(amount)}`)
            .join(", ");
          const participantCount = Object.values(expense.owed).filter((amount) => amount > 0).length;
          return `
            <li class="expense-card">
              <time class="expense-date" datetime="${escapeHtml(expense.date)}">${date.month}<strong>${date.day}</strong></time>
              <div class="expense-main">
                <h4 class="expense-title">${escapeHtml(expense.description)}</h4>
                <p class="expense-meta">Paid by ${escapeHtml(paidNames)}</p>
                <p class="expense-split">Split ${splitModeLabel(expense.splitMode)} between ${participantCount} ${participantCount === 1 ? "person" : "people"}</p>
              </div>
              <div class="expense-side">
                <div class="expense-amount">${formatMoney(expense.total)}</div>
                <div class="expense-buttons">
                  <button class="btn btn-quiet" type="button" data-action="edit-expense" data-id="${expense.id}">Edit</button>
                </div>
              </div>
            </li>
          `;
        }).join("");
      }

      function formatExpenseDate(value) {
        const date = new Date(`${value}T12:00:00`);
        if (Number.isNaN(date.getTime())) return "—";
        return date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
      }

      function parseLocalDate(value) {
        const date = new Date(`${value}T12:00:00`);
        if (Number.isNaN(date.getTime())) return { month: "—", day: "—" };
        return {
          month: date.toLocaleDateString(undefined, { month: "short" }),
          day: date.toLocaleDateString(undefined, { day: "2-digit" })
        };
      }

      function splitModeLabel(mode) {
        return ({ equal: "equally", exact: "by exact amounts", percent: "by percentage", shares: "by shares" })[mode] || "custom";
      }

      function renderBalances() {
        const total = state.expenses.reduce((sum, expense) => sum + expense.total, 0);
        const nets = calculateNets();
        els.totalSpending.textContent = formatResultMoney(total);

        if (!state.people.length) {
          els.balanceList.innerHTML = '<li class="empty">Balances appear after people are added.</li>';
        } else {
          els.balanceList.innerHTML = state.people.map((person) => {
            const net = nets[person.id] || 0;
            const className = net > 0 ? "money-positive" : net < 0 ? "money-negative" : "money-neutral";
            const label = net > 0 ? "gets back" : net < 0 ? "owes overall" : "settled up";
            return `
              <li class="balance-row">
                <div><strong>${escapeHtml(person.name)}</strong><small>${label}</small></div>
                <span class="balance-money ${className}">${net > 0 ? "+" : net < 0 ? "−" : ""}${formatResultMoney(Math.abs(net))}</span>
              </li>
            `;
          }).join("");
        }

        const transfers = state.simplify ? matchBalances(nets) : rawTransfers();
        if (!transfers.length) {
          els.settlementList.innerHTML = '<li class="empty"><strong>All settled up</strong>No payments are needed.</li>';
        } else {
          els.settlementList.innerHTML = transfers.map((transfer) => `
            <li class="settlement">
              <strong>${escapeHtml(personById(transfer.from)?.name || "Removed")}</strong>
              <span class="arrow" aria-label="pays">→</span>
              <span>${escapeHtml(personById(transfer.to)?.name || "Removed")}</span>
              <strong>${formatResultMoney(transfer.amount)}</strong>
            </li>
          `).join("");
        }
      }

      function openExpenseDialog(expense = null) {
        if (state.people.length < 1) {
          els.personName.focus();
          showToast("Add at least one person first.");
          return;
        }
        editingExpenseId = expense?.id || null;
        splitMode = expense?.splitMode || "equal";
        els.dialogTitle.textContent = expense ? "Edit expense" : "Add expense";
        els.deleteExpenseBtn.hidden = !expense;
        els.description.value = expense?.description || "";
        els.date.value = expense?.date || todayString();
        els.amount.value = expense ? centsToInput(expense.total) : "";
        els.formError.textContent = "";
        renderPayerRows(expense);
        renderOwedRows(expense);
        updateSplitTabs();
        updateAllocationPreview();
        els.dialog.showModal();
        requestAnimationFrame(() => els.description.focus());
      }

      function todayString() {
        const now = new Date();
        const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
        return local.toISOString().slice(0, 10);
      }

      function renderPayerRows(expense) {
        els.payerRows.innerHTML = state.people.map((person, index) => `
          <tr>
            <td>
              <div class="table-person"><span class="avatar" aria-hidden="true">${escapeHtml(initials(person.name))}</span>${escapeHtml(person.name)}</div>
            </td>
            <td>${index === 0 ? "Payer" : "Optional payer"}</td>
            <td>
              <span class="input-group">
                <span class="input-prefix">${CURRENCIES[state.currency].symbol}</span>
                <input class="input payer-input" data-id="${person.id}" inputmode="decimal" aria-label="${escapeHtml(person.name)} paid" value="${expense?.paid[person.id] ? centsToInput(expense.paid[person.id]) : ""}" placeholder="0.00">
              </span>
            </td>
          </tr>
        `).join("");
      }

      function renderOwedRows(expense) {
        els.owedRows.innerHTML = state.people.map((person) => {
          const existingValue = expense?.splitDetails?.[person.id];
          const included = expense ? (expense.owed[person.id] || 0) > 0 || existingValue === 0 : true;
          return `
            <tr>
              <td>
                <label class="check-person">
                  <input class="participant-check" data-id="${person.id}" type="checkbox" ${included ? "checked" : ""}>
                  <span class="table-person"><span class="avatar" aria-hidden="true">${escapeHtml(initials(person.name))}</span>${escapeHtml(person.name)}</span>
                </label>
              </td>
              <td>${included ? "Included" : "Excluded"}</td>
              <td>
                <div class="owed-input-wrap">
                  <input class="input owed-input" data-id="${person.id}" inputmode="decimal" aria-label="${escapeHtml(person.name)} split value" value="${existingValue ?? defaultSplitValue(expense, person.id)}" ${splitMode === "equal" ? "readonly" : ""} ${included ? "" : "disabled"}>
                  <span class="unit">${splitUnit()}</span>
                  <span class="preview" data-preview-id="${person.id}"></span>
                </div>
              </td>
            </tr>
          `;
        }).join("");
        els.owedColumnTitle.textContent = splitMode === "equal" ? "Owes" : splitMode === "exact" ? "Amount" : splitMode === "percent" ? "Percent" : "Shares";
      }

      function defaultSplitValue(expense, personId) {
        if (!expense) return splitMode === "shares" ? "1" : "";
        if (splitMode === "exact") return centsToInput(expense.owed[personId] || 0);
        return splitMode === "shares" ? "1" : "";
      }

      function splitUnit() {
        if (splitMode === "exact") return CURRENCIES[state.currency].symbol;
        if (splitMode === "percent") return "%";
        if (splitMode === "shares") return "×";
        return "";
      }

      function setSplitMode(mode) {
        if (!["equal", "exact", "percent", "shares"].includes(mode) || mode === splitMode) return;
        splitMode = mode;
        const draft = captureOwedDraft();
        renderOwedRows();
        restoreParticipantSelection(draft);
        updateSplitTabs();
        updateAllocationPreview();
      }

      function captureOwedDraft() {
        return [...els.owedRows.querySelectorAll(".participant-check")].map((check) => ({
          id: check.dataset.id,
          checked: check.checked
        }));
      }

      function restoreParticipantSelection(draft) {
        draft.forEach((item) => {
          const check = els.owedRows.querySelector(`.participant-check[data-id="${CSS.escape(item.id)}"]`);
          if (check) check.checked = item.checked;
          const input = els.owedRows.querySelector(`.owed-input[data-id="${CSS.escape(item.id)}"]`);
          if (input) input.disabled = !item.checked;
        });
      }

      function updateSplitTabs() {
        els.splitTabs.querySelectorAll(".split-tab").forEach((tab) => {
          tab.setAttribute("aria-selected", String(tab.dataset.mode === splitMode));
        });
      }

      function readAllocation() {
        const total = parseCents(els.amount.value);
        const participants = [...els.owedRows.querySelectorAll(".participant-check")]
          .filter((check) => check.checked)
          .map((check) => check.dataset.id);
        if (total === null || total <= 0) return { error: "Enter a valid total greater than zero." };
        if (!participants.length) return { error: "Include at least one participant." };

        if (splitMode === "equal") {
          return {
            owed: allocateByWeights(total, participants.map((id) => ({ id, weight: 1 }))),
            details: Object.fromEntries(participants.map((id) => [id, 1]))
          };
        }

        const values = [];
        for (const id of participants) {
          const input = els.owedRows.querySelector(`.owed-input[data-id="${CSS.escape(id)}"]`);
          const raw = input.value.trim();
          const value = Number(raw);
          if (raw === "" || !Number.isFinite(value) || value < 0) {
            return { error: `Enter a valid ${splitMode === "shares" ? "share" : "value"} for every participant.` };
          }
          values.push({ id, value });
        }

        if (splitMode === "exact") {
          const owed = {};
          let sum = 0;
          for (const entry of values) {
            const cents = parseCents(String(entry.value));
            if (cents === null) return { error: "Exact amounts may have at most two decimal places." };
            owed[entry.id] = cents;
            sum += cents;
          }
          if (sum !== total) return { error: `Exact amounts must total ${formatMoney(total)} (currently ${formatMoney(sum)}).` };
          return { owed, details: Object.fromEntries(values.map((entry) => [entry.id, entry.value])) };
        }

        const sum = values.reduce((acc, entry) => acc + entry.value, 0);
        if (splitMode === "percent" && Math.abs(sum - 100) > 0.000001) {
          return { error: `Percentages must total 100% (currently ${sum.toFixed(2)}%).` };
        }
        if (splitMode === "shares" && sum <= 0) return { error: "Shares must total more than zero." };
        return {
          owed: allocateByWeights(total, values.map((entry) => ({ id: entry.id, weight: entry.value }))),
          details: Object.fromEntries(values.map((entry) => [entry.id, entry.value]))
        };
      }

      function readPaid(total) {
        const paid = {};
        let sum = 0;
        for (const input of els.payerRows.querySelectorAll(".payer-input")) {
          if (!input.value.trim()) continue;
          const cents = parseCents(input.value);
          if (cents === null) return { error: "Paid amounts must be valid currency amounts." };
          if (cents > 0) paid[input.dataset.id] = cents;
          sum += cents;
        }
        if (!Object.keys(paid).length) return { error: "Enter at least one payer contribution." };
        if (sum !== total) return { error: `Paid amounts must total ${formatMoney(total)} (currently ${formatMoney(sum)}).` };
        return { paid };
      }

      function updateAllocationPreview() {
        const allocation = readAllocation();
        const total = parseCents(els.amount.value);
        els.owedRows.querySelectorAll("[data-preview-id]").forEach((preview) => {
          const value = allocation.owed?.[preview.dataset.previewId];
          preview.textContent = Number.isInteger(value) ? formatMoney(value) : "";
        });
        els.owedStatus.textContent = allocation.error || `Owed total: ${formatMoney(total || 0)}`;

        const inputs = [...els.payerRows.querySelectorAll(".payer-input")];
        const paidSum = inputs.reduce((sum, input) => sum + (parseCents(input.value) || 0), 0);
        els.paidStatus.textContent = `Paid total: ${formatMoney(paidSum)}`;
      }

      function saveExpense(event) {
        event.preventDefault();
        els.formError.textContent = "";
        const description = els.description.value.trim();
        const total = parseCents(els.amount.value);
        if (!description) return showFormError("Add a description.");
        if (!els.date.value) return showFormError("Choose a date.");
        if (total === null || total <= 0) return showFormError("Enter a valid total greater than zero.");

        const paidResult = readPaid(total);
        if (paidResult.error) return showFormError(paidResult.error);
        const allocation = readAllocation();
        if (allocation.error) return showFormError(allocation.error);

        const existingIndex = state.expenses.findIndex((expense) => expense.id === editingExpenseId);
        const existing = existingIndex >= 0 ? state.expenses[existingIndex] : null;
        const expense = {
          id: existing?.id || makeId("expense"),
          description,
          date: els.date.value,
          total,
          paid: paidResult.paid,
          owed: allocation.owed,
          splitMode,
          splitDetails: allocation.details,
          createdAt: existing?.createdAt || Date.now(),
          updatedAt: Date.now()
        };
        if (existingIndex >= 0) state.expenses.splice(existingIndex, 1, expense);
        else state.expenses.push(expense);
        saveState();
        render();
        els.dialog.close();
        showToast(existing ? "Expense updated." : "Expense added.");
      }

      function showFormError(message) {
        els.formError.textContent = message;
        els.formError.scrollIntoView({ block: "nearest", behavior: "smooth" });
      }

      function deleteExpense(id = editingExpenseId) {
        const expense = state.expenses.find((item) => item.id === id);
        if (!expense || !confirm(`Delete “${expense.description}”? This cannot be undone.`)) return;
        state.expenses = state.expenses.filter((item) => item.id !== id);
        saveState();
        render();
        if (els.dialog.open) els.dialog.close();
        showToast("Expense deleted.");
      }

      function addPerson(event) {
        event.preventDefault();
        const name = els.personName.value.trim();
        if (!name) return;
        if (state.people.some((person) => person.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
          showToast("That name is already in the group.");
          return;
        }
        state.people.push({ id: makeId("person"), name });
        els.personName.value = "";
        saveState();
        render();
        els.personName.focus();
      }

      function renamePerson(id) {
        const person = personById(id);
        if (!person) return;
        const nextName = prompt("Rename this person:", person.name)?.trim();
        if (!nextName || nextName === person.name) return;
        if (state.people.some((item) => item.id !== id && item.name.toLocaleLowerCase() === nextName.toLocaleLowerCase())) {
          showToast("That name is already in the group.");
          return;
        }
        person.name = nextName.slice(0, 50);
        saveState();
        render();
      }

      function removePerson(id) {
        const person = personById(id);
        if (!person) return;
        const referenced = state.expenses.some((expense) => id in expense.paid || id in expense.owed);
        if (referenced) {
          showToast(`${person.name} is part of an expense. Delete or edit those expenses first.`);
          return;
        }
        if (!confirm(`Remove ${person.name} from the group?`)) return;
        state.people = state.people.filter((item) => item.id !== id);
        saveState();
        render();
      }

      function resetData() {
        if (!state.people.length && !state.expenses.length) return;
        if (!confirm("Delete all people and expenses from this browser?")) return;
        const currency = state.currency;
        const resultCurrency = state.resultCurrency;
        const expenseView = state.expenseView;
        state = emptyState();
        state.currency = currency;
        state.resultCurrency = resultCurrency;
        state.expenseView = expenseView;
        saveState();
        render();
        showToast("All data cleared.");
      }

      function exportData() {
        const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = `fairshare-${todayString()}.json`;
        document.body.appendChild(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(url);
        showToast("Data exported.");
      }

      async function importData(event) {
        const [file] = event.target.files;
        if (!file) return;
        try {
          if (file.size > 5 * 1024 * 1024) throw new Error("The JSON file is too large.");
          const importedState = parseImportedState(JSON.parse(await file.text()));
          if ((state.people.length || state.expenses.length) &&
              !confirm("Replace all current people and expenses with the imported data?")) return;
          state = importedState;
          saveState();
          render();
          if (els.dialog.open) els.dialog.close();
          showToast("Data imported.");
        } catch (error) {
          showToast(error instanceof SyntaxError ? "The selected file is not valid JSON." : error.message);
        } finally {
          event.target.value = "";
        }
      }

      function showToast(message) {
        clearTimeout(toastTimer);
        els.toast.textContent = message;
        els.toast.classList.add("show");
        toastTimer = setTimeout(() => els.toast.classList.remove("show"), 2800);
      }

      els.personForm.addEventListener("submit", addPerson);
      els.addExpenseBtn.addEventListener("click", () => openExpenseDialog());
      els.importBtn.addEventListener("click", () => els.importFile.click());
      els.exportBtn.addEventListener("click", exportData);
      els.importFile.addEventListener("change", importData);
      els.resetBtn.addEventListener("click", resetData);
      els.currencySelect.addEventListener("change", () => {
        state.currency = els.currencySelect.value;
        saveState();
        render();
        if (els.dialog.open) updateAllocationPreview();
      });
      els.resultCurrencySelect.addEventListener("change", () => {
        state.resultCurrency = els.resultCurrencySelect.value;
        saveState();
        renderBalances();
      });
      function setExpenseView(view) {
        state.expenseView = view === "list" ? "list" : "grid";
        saveState();
        renderExpenses();
      }
      els.listViewBtn.addEventListener("click", () => setExpenseView("list"));
      els.gridViewBtn.addEventListener("click", () => setExpenseView("grid"));
      els.simplifyToggle.addEventListener("change", () => {
        state.simplify = els.simplifyToggle.checked;
        saveState();
        renderBalances();
      });
      els.peopleList.addEventListener("click", (event) => {
        const button = event.target.closest("button[data-action]");
        if (!button) return;
        if (button.dataset.action === "rename-person") renamePerson(button.dataset.id);
        if (button.dataset.action === "delete-person") removePerson(button.dataset.id);
      });
      els.expenseList.addEventListener("click", (event) => {
        const button = event.target.closest("button[data-action='edit-expense']");
        if (!button) return;
        openExpenseDialog(state.expenses.find((expense) => expense.id === button.dataset.id));
      });
      els.expenseTableBody.addEventListener("click", (event) => {
        const button = event.target.closest("button[data-action='edit-expense']");
        if (!button) return;
        openExpenseDialog(state.expenses.find((expense) => expense.id === button.dataset.id));
      });
      els.splitTabs.addEventListener("click", (event) => {
        const tab = event.target.closest("[data-mode]");
        if (tab) setSplitMode(tab.dataset.mode);
      });
      els.amount.addEventListener("input", updateAllocationPreview);
      els.payerRows.addEventListener("input", updateAllocationPreview);
      els.owedRows.addEventListener("input", updateAllocationPreview);
      els.owedRows.addEventListener("change", (event) => {
        if (!event.target.classList.contains("participant-check")) return;
        const row = event.target.closest("tr");
        const input = row.querySelector(".owed-input");
        input.disabled = !event.target.checked;
        row.children[1].textContent = event.target.checked ? "Included" : "Excluded";
        updateAllocationPreview();
      });
      els.expenseForm.addEventListener("submit", saveExpense);
      els.closeDialogBtn.addEventListener("click", () => els.dialog.close());
      els.cancelExpenseBtn.addEventListener("click", () => els.dialog.close());
      els.deleteExpenseBtn.addEventListener("click", () => deleteExpense());
      els.dialog.addEventListener("click", (event) => {
        if (event.target === els.dialog) els.dialog.close();
      });

      render();
      loadExchangeRates();
    })();
