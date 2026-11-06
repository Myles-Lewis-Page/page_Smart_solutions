'use strict';
// Federal tax estimate for a W-2 salary plus a sole proprietor side business.
// Estimator only: it is not tax advice and does not replace a return.
// Defaults are for tax year 2026, single filer:
//   standard deduction $16,100, Social Security wage base $184,500,
//   brackets per IRS Rev. Proc. 2025-32.

const DEFAULT_BRACKETS_2026 = [
  { upTo: 12400, rate: 0.10 },
  { upTo: 50400, rate: 0.12 },
  { upTo: 105700, rate: 0.22 },
  { upTo: 201775, rate: 0.24 },
  { upTo: 256225, rate: 0.32 },
  { upTo: 640600, rate: 0.35 },
  { upTo: null, rate: 0.37 },
];

const r2 = n => Math.round((Number(n) || 0) * 100) / 100;

function newTaxYear() {
  return {
    salary: 0,
    fed_withholding: 0,
    std_deduction: 16100,
    ss_wage_base: 184500,
    brackets: DEFAULT_BRACKETS_2026,
    qbi_enabled: false,
  };
}

function bracketTax(taxable, brackets) {
  let tax = 0;
  let prev = 0;
  const parts = [];
  for (const b of brackets) {
    const cap = b.upTo == null ? Infinity : Number(b.upTo);
    const amount = Math.max(0, Math.min(taxable, cap) - prev);
    if (amount > 0) {
      parts.push({ rate: b.rate, amount: r2(amount), tax: r2(amount * b.rate) });
      tax += amount * b.rate;
    }
    prev = cap;
    if (taxable <= cap) break;
  }
  return { tax, parts };
}

/**
 * @param {object} i  { revenue, expenses, mileageDeduction, salary, withholding,
 *                      stdDeduction, ssWageBase, brackets, qbiEnabled }
 */
function computeTax(i) {
  const revenue = r2(i.revenue);
  const expenses = r2(i.expenses);
  const mileageDeduction = r2(i.mileageDeduction);
  const salary = Math.max(0, Number(i.salary) || 0);
  const withholding = Math.max(0, Number(i.withholding) || 0);
  const std = Math.max(0, Number(i.stdDeduction) || 0);
  const wageBase = Number(i.ssWageBase) || 0;
  const brackets = i.brackets;

  const netProfit = r2(revenue - expenses - mileageDeduction);

  // Self-employment tax: 92.35% of net profit, owed once that reaches $400.
  const seEarnings = Math.max(0, netProfit) * 0.9235;
  const seApplies = seEarnings >= 400;
  let seTax = 0;
  if (seApplies) {
    const ssRoom = Math.max(0, wageBase - salary); // W-2 wages use the Social Security base first
    seTax = Math.min(seEarnings, ssRoom) * 0.124 + seEarnings * 0.029;
  }
  const halfSe = seTax / 2;

  const agi = salary + netProfit - halfSe;
  const qbi = i.qbiEnabled && netProfit > 0
    ? Math.min(0.2 * (netProfit - halfSe), 0.2 * Math.max(0, agi - std))
    : 0;
  const taxableIncome = Math.max(0, agi - std - qbi);

  const combined = bracketTax(taxableIncome, brackets);
  const salaryOnly = bracketTax(Math.max(0, salary - std), brackets);
  const incomeTax = combined.tax;
  const salaryTax = salaryOnly.tax;
  const sideIncomeTax = incomeTax - salaryTax;
  const sideTotalTax = sideIncomeTax + seTax;
  const totalTax = incomeTax + seTax;
  const top = combined.parts[combined.parts.length - 1];

  return {
    revenue, expenses, mileageDeduction, netProfit,
    seEarnings: r2(seEarnings), seApplies, seTax: r2(seTax), halfSe: r2(halfSe),
    salary: r2(salary), agi: r2(agi), stdDeduction: r2(std), qbiDeduction: r2(qbi),
    taxableIncome: r2(taxableIncome),
    incomeTax: r2(incomeTax), salaryTax: r2(salaryTax), sideIncomeTax: r2(sideIncomeTax),
    sideTotalTax: r2(sideTotalTax), takeHome: r2(netProfit - sideTotalTax),
    totalTax: r2(totalTax), withholding: r2(withholding), balance: r2(totalTax - withholding),
    marginalRate: top ? top.rate : 0,
    brackets: combined.parts,
    setAsidePct: netProfit > 0 ? Math.round((sideTotalTax / netProfit) * 1000) / 10 : 0,
  };
}

module.exports = { computeTax, bracketTax, newTaxYear, DEFAULT_BRACKETS_2026 };
