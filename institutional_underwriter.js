#!/usr/bin/env node
/**
 * institutional_underwriter.js — Institutional-Grade Deal Analyzer
 *
 * Builds a comprehensive financial model for converting a large
 * commercial property into a Live-Work-Play residential community.
 *
 * Produces a formatted "Tear Sheet" for the console and a structured
 * JSON export for dashboard integration.
 */

const fs = require("fs");
const path = require("path");

const INPUT_PATH = path.join(__dirname, "output", "massive_unicorns.json");
const OUTPUT_PATH = path.join(__dirname, "output", "underwritten_deal_1.json");

// ---------------------------------------------------------------------------
// Baseline assumptions
// ---------------------------------------------------------------------------

const ASSUMPTIONS = {
  // Physical
  efficiencyRatio: 0.75,           // 75% usable for apartments
  avgUnitSqFt: 500,                // sq ft per unit

  // Construction
  conversionCostPerSqFt: 175,      // $/usable sq ft, heavy repositioning

  // Revenue
  stabilizedRentPerUnit: 2200,     // $/month
  annualRentGrowth: 0.03,          // 3% annual escalation

  // Operating
  opExRatio: 0.35,                 // 35% of Gross Potential Rent
  vacancyRate: 0.05,               // 5% economic vacancy
  managementFee: 0.04,             // 4% of EGI (included in opEx)

  // Subject-To acquisition
  existingDebtPerSqFt: 100,        // $/total sq ft — debt assumed
  interestRate: 0.055,             // 5.5% on assumed debt
  loanTermYears: 30,               // amortization

  // Exit
  exitCapRate: 0.055,              // 5.5% cap rate at disposition
  holdPeriodYears: 5,              // projected hold

  // Other
  closingCostsPct: 0.02,           // 2% of acquisition
  conversionTimeline: 18,          // months to stabilization
};

// ---------------------------------------------------------------------------
// Financial model
// ---------------------------------------------------------------------------

function underwriteDeal(property) {
  const A = ASSUMPTIONS;
  const totalSqFt = property.buildingSqFt || 0;

  // --- Physical ---
  const usableSqFt = Math.floor(totalSqFt * A.efficiencyRatio);
  const amenitySqFt = totalSqFt - usableSqFt;
  const totalUnits = Math.floor(usableSqFt / A.avgUnitSqFt);

  // --- Unit mix (modeled distribution) ---
  const studioCount = Math.floor(totalUnits * 0.20);
  const oneBedCount = Math.floor(totalUnits * 0.45);
  const twoBedCount = Math.floor(totalUnits * 0.25);
  const threeBedCount = totalUnits - studioCount - oneBedCount - twoBedCount;

  const unitMix = {
    studio:  { count: studioCount,  sqft: 400,  rent: Math.round(A.stabilizedRentPerUnit * 0.80) },
    oneBed:  { count: oneBedCount,  sqft: 500,  rent: A.stabilizedRentPerUnit },
    twoBed:  { count: twoBedCount,  sqft: 700,  rent: Math.round(A.stabilizedRentPerUnit * 1.40) },
    threeBed:{ count: threeBedCount,sqft: 950,  rent: Math.round(A.stabilizedRentPerUnit * 1.80) },
  };

  // --- Acquisition (Subject-To) ---
  const existingDebt = totalSqFt * A.existingDebtPerSqFt;
  const closingCosts = existingDebt * A.closingCostsPct;

  // --- Conversion costs ---
  const hardCosts = usableSqFt * A.conversionCostPerSqFt;
  const softCosts = Math.round(hardCosts * 0.12); // 12% of hard (arch, eng, permits)
  const contingency = Math.round(hardCosts * 0.08); // 8% contingency
  const totalConversionCost = hardCosts + softCosts + contingency;

  // --- Total project cost ---
  const totalProjectCost = existingDebt + closingCosts + totalConversionCost;
  const equityRequired = closingCosts + totalConversionCost; // fresh cash needed
  const costPerUnit = Math.round(totalProjectCost / totalUnits);
  const costPerSqFt = Math.round(totalProjectCost / totalSqFt);

  // --- Revenue ---
  const grossPotentialRent = totalUnits * A.stabilizedRentPerUnit * 12;
  const vacancyLoss = grossPotentialRent * A.vacancyRate;
  const effectiveGrossIncome = grossPotentialRent - vacancyLoss;

  // Ancillary income (parking, coworking, amenity fees)
  const ancillaryIncome = Math.round(totalUnits * 75 * 12); // $75/unit/month
  const totalRevenue = effectiveGrossIncome + ancillaryIncome;

  // --- Expenses ---
  const operatingExpenses = Math.round(grossPotentialRent * A.opExRatio);

  // --- NOI ---
  const stabilizedNOI = totalRevenue - operatingExpenses;

  // --- Debt service ---
  const monthlyRate = A.interestRate / 12;
  const numPayments = A.loanTermYears * 12;
  const monthlyPayment = existingDebt * (monthlyRate * Math.pow(1 + monthlyRate, numPayments)) /
    (Math.pow(1 + monthlyRate, numPayments) - 1);
  const annualDebtService = Math.round(monthlyPayment * 12);

  // --- Cash flow ---
  const cashFlowBeforeDebt = stabilizedNOI;
  const cashFlowAfterDebt = stabilizedNOI - annualDebtService;
  const cashOnCashReturn = equityRequired > 0 ? cashFlowAfterDebt / equityRequired : 0;

  // --- Return metrics ---
  const yieldOnCost = totalProjectCost > 0 ? stabilizedNOI / totalProjectCost : 0;
  const exitValuation = Math.round(stabilizedNOI / A.exitCapRate);
  const createdEquity = exitValuation - totalProjectCost;
  const equityMultiple = equityRequired > 0 ? (equityRequired + createdEquity) / equityRequired : 0;

  // --- Year 5 projection ---
  const year5NOI = Math.round(stabilizedNOI * Math.pow(1 + A.annualRentGrowth, A.holdPeriodYears - 1));
  const year5Valuation = Math.round(year5NOI / A.exitCapRate);
  const year5Equity = year5Valuation - existingDebt; // rough remaining debt (interest-only approx)

  return {
    property: {
      id: property.id,
      address: property.address,
      folio: property.folio,
      owner: property.owner,
      ownerState: property.ownerMailingState,
      distressScore: property.distressScore,
      dorDescription: property.dorDescription,
      zones: {
        cra: property.insideCRA ? property.zones.cra.name.trim() : null,
        oz: property.insideOZ ? property.zones.opportunityZone.tract : null,
      },
    },
    physical: {
      totalSqFt,
      usableSqFt,
      amenitySqFt,
      totalUnits,
      avgUnitSqFt: A.avgUnitSqFt,
      efficiencyRatio: A.efficiencyRatio,
      unitMix,
    },
    acquisition: {
      existingDebt,
      closingCosts,
      debtPerSqFt: A.existingDebtPerSqFt,
    },
    conversion: {
      hardCosts,
      softCosts,
      contingency,
      totalConversionCost,
      costPerUsableSqFt: A.conversionCostPerSqFt,
      timelineMonths: A.conversionTimeline,
    },
    capitalStack: {
      totalProjectCost,
      existingDebt,
      equityRequired,
      costPerUnit,
      costPerSqFt,
      leverageRatio: existingDebt / totalProjectCost,
    },
    revenue: {
      grossPotentialRent,
      vacancyLoss,
      effectiveGrossIncome,
      ancillaryIncome,
      totalRevenue,
      rentPerUnit: A.stabilizedRentPerUnit,
    },
    expenses: {
      operatingExpenses,
      opExRatio: A.opExRatio,
    },
    returns: {
      stabilizedNOI,
      annualDebtService,
      cashFlowAfterDebt,
      yieldOnCost,
      cashOnCashReturn,
      exitCapRate: A.exitCapRate,
      exitValuation,
      createdEquity,
      equityMultiple,
    },
    projection: {
      holdPeriodYears: A.holdPeriodYears,
      annualRentGrowth: A.annualRentGrowth,
      year5NOI,
      year5Valuation,
      year5Equity,
    },
    assumptions: A,
    generatedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Console tear sheet
// ---------------------------------------------------------------------------

function $(n) { return "$" + Math.round(n).toLocaleString(); }
function pct(n) { return (n * 100).toFixed(2) + "%"; }
function line(w) { return "─".repeat(w || 62); }

function printTearSheet(deal) {
  const p = deal.property;
  const ph = deal.physical;
  const acq = deal.acquisition;
  const conv = deal.conversion;
  const cap = deal.capitalStack;
  const rev = deal.revenue;
  const exp = deal.expenses;
  const ret = deal.returns;
  const proj = deal.projection;
  const mix = ph.unitMix;

  console.log();
  console.log("┌" + line() + "┐");
  console.log("│     INSTITUTIONAL DEAL TEAR SHEET — CONFIDENTIAL          │");
  console.log("│     BHT Capital Group — Live-Work-Play Conversion         │");
  console.log("├" + line() + "┤");

  console.log("│  PROPERTY OVERVIEW                                        │");
  console.log("├" + line() + "┤");
  console.log(`│  Address:        ${p.address}`);
  console.log(`│  Folio:          ${p.folio}`);
  console.log(`│  Current Owner:  ${p.owner} (${p.ownerState})`);
  console.log(`│  Current Use:    ${p.dorDescription}`);
  console.log(`│  Distress Score: ${p.distressScore}/6`);
  if (p.zones.cra) console.log(`│  CRA Zone:       ${p.zones.cra}`);
  if (p.zones.oz) console.log(`│  Opportunity Zone: Tract ${p.zones.oz}`);

  console.log("├" + line() + "┤");
  console.log("│  PHYSICAL PROGRAM                                         │");
  console.log("├" + line() + "┤");
  console.log(`│  Gross Building Area:    ${ph.totalSqFt.toLocaleString()} sq ft`);
  console.log(`│  Usable Residential:     ${ph.usableSqFt.toLocaleString()} sq ft  (${pct(ph.efficiencyRatio)} eff.)`);
  console.log(`│  Amenity / Common:       ${ph.amenitySqFt.toLocaleString()} sq ft`);
  console.log(`│  Total Units:            ${ph.totalUnits}`);
  console.log(`│`);
  console.log(`│  Unit Mix:`);
  console.log(`│    Studios    ${mix.studio.count} units   @ ${mix.studio.sqft} sf   ${$(mix.studio.rent)}/mo`);
  console.log(`│    1-Bed      ${mix.oneBed.count} units   @ ${mix.oneBed.sqft} sf   ${$(mix.oneBed.rent)}/mo`);
  console.log(`│    2-Bed      ${mix.twoBed.count} units   @ ${mix.twoBed.sqft} sf   ${$(mix.twoBed.rent)}/mo`);
  console.log(`│    3-Bed      ${mix.threeBed.count} units   @ ${mix.threeBed.sqft} sf   ${$(mix.threeBed.rent)}/mo`);

  console.log("├" + line() + "┤");
  console.log("│  CAPITAL STACK                                            │");
  console.log("├" + line() + "┤");
  console.log(`│  Existing Debt (Subject-To):  ${$(acq.existingDebt)}   @ ${$(acq.debtPerSqFt)}/sf`);
  console.log(`│  Closing Costs:               ${$(acq.closingCosts)}`);
  console.log(`│  Hard Costs (Conversion):     ${$(conv.hardCosts)}   @ ${$(conv.costPerUsableSqFt)}/usable sf`);
  console.log(`│  Soft Costs (12%):            ${$(conv.softCosts)}`);
  console.log(`│  Contingency (8%):            ${$(conv.contingency)}`);
  console.log(`│  ${line(58)}`);
  console.log(`│  TOTAL PROJECT COST:          ${$(cap.totalProjectCost)}`);
  console.log(`│  Cost Per Unit:               ${$(cap.costPerUnit)}`);
  console.log(`│  Cost Per Sq Ft:              ${$(cap.costPerSqFt)}`);
  console.log(`│`);
  console.log(`│  Assumed Debt:                ${$(cap.existingDebt)}   (${pct(cap.leverageRatio)} LTC)`);
  console.log(`│  EQUITY REQUIRED:             ${$(cap.equityRequired)}`);

  console.log("├" + line() + "┤");
  console.log("│  STABILIZED INCOME & EXPENSE (Year 1)                     │");
  console.log("├" + line() + "┤");
  console.log(`│  Gross Potential Rent:         ${$(rev.grossPotentialRent)}`);
  console.log(`│  Less: Vacancy (5%):          (${$(rev.vacancyLoss)})`);
  console.log(`│  Effective Gross Income:       ${$(rev.effectiveGrossIncome)}`);
  console.log(`│  Ancillary Income:             ${$(rev.ancillaryIncome)}`);
  console.log(`│  TOTAL REVENUE:                ${$(rev.totalRevenue)}`);
  console.log(`│`);
  console.log(`│  Operating Expenses (35%):    (${$(exp.operatingExpenses)})`);
  console.log(`│  ${line(58)}`);
  console.log(`│  STABILIZED NOI:               ${$(ret.stabilizedNOI)}`);
  console.log(`│`);
  console.log(`│  Annual Debt Service:         (${$(ret.annualDebtService)})`);
  console.log(`│  CASH FLOW AFTER DEBT:         ${$(ret.cashFlowAfterDebt)}`);

  console.log("├" + line() + "┐");
  console.log("│  RETURN METRICS                                           │");
  console.log("├" + line() + "┤");
  console.log(`│  Yield on Cost (YOC):         ${pct(ret.yieldOnCost)}`);
  console.log(`│  Cash-on-Cash Return:         ${pct(ret.cashOnCashReturn)}`);
  console.log(`│  Exit Cap Rate:               ${pct(ret.exitCapRate)}`);
  console.log(`│  Exit Valuation:              ${$(ret.exitValuation)}`);
  console.log(`│  Total Created Equity:        ${$(ret.createdEquity)}`);
  console.log(`│  Equity Multiple:             ${ret.equityMultiple.toFixed(2)}x`);

  console.log("├" + line() + "┤");
  console.log("│  5-YEAR PROJECTION                                        │");
  console.log("├" + line() + "┤");
  console.log(`│  Year 5 NOI (3% growth):      ${$(proj.year5NOI)}`);
  console.log(`│  Year 5 Valuation:            ${$(proj.year5Valuation)}`);
  console.log(`│  Year 5 Equity Position:      ${$(proj.year5Equity)}`);

  console.log("├" + line() + "┤");
  console.log("│  CONVERSION TIMELINE: " + conv.timelineMonths + " months to stabilization              │");
  console.log("└" + line() + "┘");
  console.log();
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  console.log("=== TIPOZMAPS — Institutional Deal Underwriting Engine ===\n");

  const data = JSON.parse(fs.readFileSync(INPUT_PATH, "utf-8"));
  console.log(`Loaded ${data.length} properties.\n`);

  // Select #1 target: highest distress, then largest building
  data.sort((a, b) => b.distressScore - a.distressScore || b.buildingSqFt - a.buildingSqFt);
  const target = data[0];

  console.log(`Selected target: ${target.address} (${target.buildingSqFt.toLocaleString()} sq ft, distress ${target.distressScore}/6)\n`);

  // Run underwriting
  const deal = underwriteDeal(target);

  // Print tear sheet
  printTearSheet(deal);

  // Save JSON
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(deal, null, 2), "utf-8");
  console.log(`Deal analysis saved to ${OUTPUT_PATH}\n`);
}

main();
