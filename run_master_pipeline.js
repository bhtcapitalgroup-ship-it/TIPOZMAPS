#!/usr/bin/env node
/**
 * run_master_pipeline.js — Master Pipeline Controller
 *
 * Orchestrates all 4 phases end-to-end in a single run:
 *
 *   Phase 1: Fetch office prospects from Miami-Dade County GIS
 *            (or read existing raw_office_prospects.json)
 *   Phase 2: Point-in-polygon zone matching (CRA/TIF + Opportunity Zones)
 *   Phase 3: Distress scoring (out-of-state owner, tax delinquency, violations)
 *   Phase 4: Office-to-residential conversion feasibility filter
 *
 * All data flows in-memory — no redundant API calls between phases.
 * The bulk feeder already provides DOR code, building sqft, and owner
 * mailing state, so we skip the per-property county API enrichment.
 */

const fs = require("fs");
const path = require("path");

// Phase imports
const { loadZones, matchProperties } = require("./property_matcher");
const { classifyDorCode } = require("./miami_public_data");
const { scoreProperty, MOTIVATED_THRESHOLD } = require("./distress_analyzer");
const { evaluateConversion, MIN_SQFT, TARGET_UNITS, AVG_UNIT_SQFT } = require("./conversion_evaluator");

const OUTPUT_DIR = path.join(__dirname, "output");
const RAW_PROSPECTS_PATH = path.join(OUTPUT_DIR, "raw_office_prospects.json");
const ULTIMATE_OUTPUT_PATH = path.join(OUTPUT_DIR, "ultimate_unicorns.json");

// ---------------------------------------------------------------------------
// Phase 1: Acquire raw office prospects
// ---------------------------------------------------------------------------

async function runPhase1() {
  // Check for existing fetched data first to avoid unnecessary API calls
  if (fs.existsSync(RAW_PROSPECTS_PATH)) {
    const prospects = JSON.parse(fs.readFileSync(RAW_PROSPECTS_PATH, "utf-8"));
    console.log(`   Loaded ${prospects.length} cached prospects from ${RAW_PROSPECTS_PATH}`);
    return prospects;
  }

  // No cache — run the feeder live
  console.log("   No cached data found. Fetching from county GIS...");
  const { fetchOfficeProspects, transformFeature } = require("./office_prospect_feeder");
  const features = await fetchOfficeProspects();
  const prospects = features.map(transformFeature);

  fs.writeFileSync(RAW_PROSPECTS_PATH, JSON.stringify(prospects, null, 2), "utf-8");
  console.log(`   Fetched and saved ${prospects.length} prospects.`);
  return prospects;
}

// ---------------------------------------------------------------------------
// Phase 2: Zone matching
// ---------------------------------------------------------------------------

function runPhase2(prospects) {
  const zones = loadZones();
  console.log(`   Loaded ${zones.cra.features.length} CRA zones, ${zones.oz.features.length} Opportunity Zones.`);

  const matched = matchProperties(prospects, zones);
  const inZone = matched.filter((p) => p.insideCRA || p.insideOZ);

  console.log(`   ${inZone.length}/${matched.length} properties fall inside at least one zone.`);

  // Return ALL properties (even those outside zones) so Phase 3 can score them.
  // Out-of-state owners outside incentive zones are still interesting leads.
  return matched;
}

// ---------------------------------------------------------------------------
// Phase 3: Distress scoring
// ---------------------------------------------------------------------------

function runPhase3(properties) {
  // The bulk feeder already provides ownerMailingState, so we can derive
  // publicRecords without hitting the county API again.
  const enriched = properties.map((p) => {
    // If publicRecords already exists (e.g., from standalone run), keep it
    if (p.publicRecords) return p;

    const ownerMailingState = (p.ownerMailingState || "").trim().toUpperCase();
    const outOfStateOwner = ownerMailingState !== "" && ownerMailingState !== "FL";

    const dorCode = p.dorCode || "";
    const propertyUse = classifyDorCode(dorCode);

    return {
      ...p,
      publicRecords: {
        // TODO: Wire a separate Tax Collector scraper for tax delinquency data.
        taxDelinquent: false,
        codeViolations: 0,
        outOfStateOwner,
      },
      physicalAttributes: {
        propertyUse,
        propertyUseRaw: `${dorCode} - ${p.dorDescription || ""}`,
        buildingSqFt: p.buildingSqFt || 0,
      },
    };
  });

  const scored = enriched.map(scoreProperty);
  const motivated = scored.filter((p) => p.sellerTier === "Highly Motivated Seller");

  console.log(`   ${motivated.length}/${scored.length} scored as Highly Motivated (threshold: ${MOTIVATED_THRESHOLD}+).`);
  return { all: scored, motivated };
}

// ---------------------------------------------------------------------------
// Phase 4: Conversion feasibility
// ---------------------------------------------------------------------------

function runPhase4(properties) {
  const evaluated = properties.map(evaluateConversion);
  const unicorns = evaluated.filter((p) => p.conversionAnalysis.feasible);

  console.log(`   ${unicorns.length}/${evaluated.length} pass conversion feasibility (Office + >= ${MIN_SQFT.toLocaleString()} sq ft).`);
  return { all: evaluated, unicorns };
}

// ---------------------------------------------------------------------------
// Summary table
// ---------------------------------------------------------------------------

function printSummaryTable(allScored, unicorns) {
  console.log("\n============================================================");
  console.log("                    PIPELINE RESULTS");
  console.log("============================================================\n");

  if (allScored.length === 0) {
    console.log("No properties to display.\n");
    return;
  }

  // Print all properties with their full journey
  for (const p of allScored) {
    const zoneFlags = [];
    if (p.insideCRA) zoneFlags.push(`CRA: ${p.zones.cra.name.trim()}`);
    if (p.insideOZ) zoneFlags.push(`OZ: ${p.zones.opportunityZone.tract}`);
    const zoneStr = zoneFlags.length > 0 ? zoneFlags.join(" + ") : "None";

    const ca = p.conversionAnalysis;
    const convStatus = ca
      ? (ca.feasible ? "UNICORN" : "FAIL")
      : "N/A";

    console.log(`[${p.id}] ${p.address || "N/A"}`);
    console.log(`     Owner:     ${p.owner || "N/A"}  |  State: ${p.ownerMailingState || "N/A"}`);
    console.log(`     Building:  ${(p.buildingSqFt || 0).toLocaleString()} sq ft  |  DOR: ${p.dorCode || "N/A"} (${p.dorDescription || "N/A"})`);
    console.log(`     Zones:     ${zoneStr}`);
    console.log(`     Distress:  ${p.distressScore}/6  [${p.sellerTier}]  ${p.distressSignals.length ? "=> " + p.distressSignals.join(", ") : ""}`);
    if (ca) {
      console.log(`     Conversion: [${convStatus}] ${ca.reasons.join("; ")}`);
      if (ca.feasible) {
        console.log(`     Potential:  ~${ca.potentialUnits} units (target: ${TARGET_UNITS})`);
      }
    }
    console.log();
  }

  // Final unicorn highlight
  console.log("============================================================");
  if (unicorns.length > 0) {
    console.log(`  ULTIMATE UNICORNS: ${unicorns.length} properties survived all 4 phases`);
    console.log("============================================================\n");
    for (const u of unicorns) {
      const ca = u.conversionAnalysis;
      console.log(`  >> ${u.address} (Folio: ${u.folio || "N/A"})`);
      console.log(`     ${(u.buildingSqFt || 0).toLocaleString()} sq ft Office  |  ~${ca.potentialUnits} potential units`);
      console.log(`     Owner: ${u.owner || "N/A"} (${u.ownerMailingState || "N/A"})  |  Distress: ${u.distressScore}/6`);
      const zf = [];
      if (u.insideCRA) zf.push(`CRA: ${u.zones.cra.name.trim()}`);
      if (u.insideOZ) zf.push(`OZ: ${u.zones.opportunityZone.tract}`);
      if (zf.length) console.log(`     Incentive Zones: ${zf.join(" + ")}`);
      console.log();
    }
  } else {
    console.log("  NO ULTIMATE UNICORNS — no properties survived all 4 filters.");
    console.log("============================================================\n");
    console.log("  This is expected with strict criteria. Consider:");
    console.log("  - Lowering the sq ft threshold");
    console.log("  - Expanding DOR codes (e.g., include multi-story office 17xx)");
    console.log("  - Wiring the Tax Collector scraper to unlock +3 distress points");
    console.log("  - Running against a wider geographic area\n");
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const startTime = Date.now();

  console.log("================================================================");
  console.log("  TIPOZMAPS — Master Pipeline: End-to-End Acquisition Finder");
  console.log("================================================================\n");

  // Phase 1: Acquire
  console.log("[PHASE 1] Bulk Feeder — Large Office Complexes");
  const prospects = await runPhase1();
  console.log();

  // Phase 2: Zone match
  console.log("[PHASE 2] Zone Matcher — CRA/TIF + Opportunity Zones");
  const zoneMatched = runPhase2(prospects);
  console.log();

  // Phase 3: Distress score
  console.log("[PHASE 3] Distress Scoring Engine");
  const { all: allScored, motivated } = runPhase3(zoneMatched);
  console.log();

  // Phase 4: Conversion filter — run on ALL scored properties, not just motivated
  // A property might not be "distressed" but still be a conversion unicorn
  // However, per the pipeline spec, we filter motivated sellers first
  console.log("[PHASE 4] Office-to-Resi Conversion Filter");
  const phase4Input = motivated.length > 0 ? motivated : allScored;
  const inputLabel = motivated.length > 0 ? "motivated sellers" : "all scored (no motivated sellers found)";
  console.log(`   Evaluating ${phase4Input.length} ${inputLabel}...`);
  const { all: allEvaluated, unicorns } = runPhase4(phase4Input);
  console.log();

  // Save ultimate unicorns
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }
  fs.writeFileSync(ULTIMATE_OUTPUT_PATH, JSON.stringify(unicorns, null, 2), "utf-8");

  // Print the full summary
  printSummaryTable(allEvaluated, unicorns);

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log("--- PIPELINE STATS ---\n");
  console.log(`  Phase 1 — Raw prospects:     ${prospects.length}`);
  console.log(`  Phase 2 — Zone matched:      ${zoneMatched.filter((p) => p.insideCRA || p.insideOZ).length}/${zoneMatched.length}`);
  console.log(`  Phase 3 — Highly Motivated:  ${motivated.length}/${allScored.length}`);
  console.log(`  Phase 4 — Unicorns:          ${unicorns.length}/${allEvaluated.length}`);
  console.log(`  Elapsed:                     ${elapsed}s`);
  console.log(`\n  Final output: ${ULTIMATE_OUTPUT_PATH}`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
