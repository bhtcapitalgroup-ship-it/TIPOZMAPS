#!/usr/bin/env node
/**
 * deal_sniper.js — Single-Property Deal Sniper
 *
 * Look up any property by address, pull its zone data and real tax
 * delinquency status via ScraperAPI, score it, and evaluate conversion
 * feasibility — all in one shot.
 *
 * Usage: node deal_sniper.js "19501 BISCAYNE BLVD"
 */

const fs = require("fs");
const path = require("path");
const { loadZones, matchProperty } = require("./property_matcher");
const { classifyDorCode } = require("./miami_public_data");
const { checkTaxDelinquency, closeBrowser } = require("./tax_collector_scraper");
const { scoreProperty } = require("./distress_analyzer");
const { evaluateConversion } = require("./conversion_evaluator");

const PROSPECTS_PATH = path.join(__dirname, "output", "raw_massive_prospects.json");
const OUTPUT_DIR = path.join(__dirname, "output");

// ---------------------------------------------------------------------------
// Find property by address in the prospects dataset
// ---------------------------------------------------------------------------

function findByAddress(address, prospects) {
  const needle = address.toUpperCase().replace(/[^A-Z0-9]/g, "");

  // Exact match first
  let match = prospects.find((p) => {
    const hay = (p.address || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    return hay === needle;
  });

  // Fuzzy: check if needle is contained in address
  if (!match) {
    match = prospects.find((p) => {
      const hay = (p.address || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
      return hay.includes(needle) || needle.includes(hay);
    });
  }

  return match;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const searchAddress = process.argv[2];

  if (!searchAddress) {
    console.error("Usage: node deal_sniper.js \"<ADDRESS>\"");
    console.error('Example: node deal_sniper.js "19501 BISCAYNE BLVD"');
    process.exit(1);
  }

  console.log("================================================================");
  console.log("  TIPOZMAPS — Deal Sniper");
  console.log("================================================================\n");
  console.log(`Searching for: "${searchAddress}"\n`);

  // Load prospects
  const prospects = JSON.parse(fs.readFileSync(PROSPECTS_PATH, "utf-8"));
  const property = findByAddress(searchAddress, prospects);

  if (!property) {
    console.error(`[ERROR] Property "${searchAddress}" not found in ${prospects.length} prospects.`);
    console.error("Make sure the address matches a record in raw_massive_prospects.json");
    process.exit(1);
  }

  console.log(`[FOUND] ${property.address} (Folio: ${property.folio})\n`);

  // Step 1: Zone match
  console.log("[1/4] Zone Matching...");
  const zones = loadZones();
  const zoneMatched = matchProperty(property, zones);
  const zoneFlags = [];
  if (zoneMatched.insideCRA) zoneFlags.push(`CRA: ${zoneMatched.zones.cra.name.trim()}`);
  if (zoneMatched.insideOZ) zoneFlags.push(`OZ: Tract ${zoneMatched.zones.opportunityZone.tract}`);
  console.log(`   Zones: ${zoneFlags.length > 0 ? zoneFlags.join(" + ") : "None"}\n`);

  // Step 2: Real tax data via ScraperAPI
  console.log("[2/4] Tax Delinquency Check (ScraperAPI)...");
  let taxResult;
  try {
    taxResult = await checkTaxDelinquency(zoneMatched);
  } catch (err) {
    console.error(`   [ERROR] ${err.message}`);
    taxResult = { taxDelinquent: false, taxDue: 0, source: "error", error: err.message };
  } finally {
    await closeBrowser();
  }
  console.log();

  // Step 3: Distress scoring
  console.log("[3/4] Distress Scoring...");
  const ownerMailingState = (zoneMatched.ownerMailingState || "").trim().toUpperCase();
  const outOfStateOwner = ownerMailingState !== "" && ownerMailingState !== "FL";
  const dorCode = zoneMatched.dorCode || "";

  const enriched = {
    ...zoneMatched,
    taxStatus: taxResult,
    publicRecords: {
      taxDelinquent: taxResult.taxDelinquent,
      taxDue: taxResult.taxDue,
      codeViolations: 0,
      outOfStateOwner,
    },
    physicalAttributes: {
      propertyUse: classifyDorCode(dorCode),
      propertyUseRaw: `${dorCode} - ${zoneMatched.dorDescription || ""}`,
      buildingSqFt: zoneMatched.buildingSqFt || 0,
    },
  };

  const scored = scoreProperty(enriched);
  console.log(`   Score: ${scored.distressScore}/6  [${scored.sellerTier}]`);
  if (scored.distressSignals.length) console.log(`   Signals: ${scored.distressSignals.join(", ")}`);
  console.log();

  // Step 4: Conversion feasibility
  console.log("[4/4] Conversion Feasibility...");
  const evaluated = evaluateConversion(scored);
  const ca = evaluated.conversionAnalysis;
  console.log(`   ${ca.feasible ? "FEASIBLE" : "NOT FEASIBLE"}: ${ca.reasons.join("; ")}`);
  if (ca.feasible) console.log(`   Potential: ~${ca.potentialUnits} units (Tier ${ca.conversionTier})`);
  console.log();

  // Print full report
  console.log("================================================================");
  console.log("  DEAL SNIPER REPORT");
  console.log("================================================================\n");
  console.log(`  Address:         ${evaluated.address}`);
  console.log(`  Folio:           ${evaluated.folio}`);
  console.log(`  Owner:           ${evaluated.owner} (${evaluated.ownerMailingState})`);
  console.log(`  Building:        ${(evaluated.buildingSqFt || 0).toLocaleString()} sq ft`);
  console.log(`  Type:            ${evaluated.dorDescription}`);
  console.log(`  Year Built:      ${evaluated.yearBuilt || "N/A"}`);
  console.log(`  Zones:           ${zoneFlags.join(" + ") || "None"}`);
  console.log();
  console.log(`  TAX STATUS:      ${taxResult.taxDelinquent ? `DELINQUENT — $${taxResult.taxDue.toLocaleString()} due` : "Current ($0 due)"}`);
  console.log(`  Tax Source:      ${taxResult.source}`);
  console.log(`  Out-of-State:    ${outOfStateOwner ? "YES" : "No"}`);
  console.log(`  DISTRESS SCORE:  ${scored.distressScore}/6  [${scored.sellerTier}]`);
  console.log();
  console.log(`  CONVERSION:      ${ca.feasible ? "FEASIBLE" : "NOT FEASIBLE"}`);
  if (ca.feasible) {
    console.log(`  Use:             ${ca.propertyUse} (Tier ${ca.conversionTier}, ${Math.round(ca.efficiency * 100)}% eff.)`);
    console.log(`  Potential Units: ~${ca.potentialUnits}`);
  }
  console.log(`  Google Maps:     https://www.google.com/maps/search/?api=1&query=${evaluated.lat},${evaluated.lng}`);
  console.log("\n================================================================\n");

  // Save report
  const reportPath = path.join(OUTPUT_DIR, `sniper_${evaluated.folio}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(evaluated, null, 2), "utf-8");
  console.log(`Report saved to ${reportPath}`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
