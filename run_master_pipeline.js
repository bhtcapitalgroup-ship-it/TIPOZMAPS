#!/usr/bin/env node
/**
 * run_master_pipeline.js — Master Pipeline Controller (Optimized)
 *
 * Optimized filter order to minimize expensive operations:
 *
 *   Step A: Load raw prospects (4,656 properties)
 *   Step B: Conversion feasibility filter — drop anything too small or
 *           ineligible type (cheap, in-memory)
 *   Step C: Zone matcher — keep ONLY properties inside a CRA/TIF or
 *           Opportunity Zone (cheap, in-memory Turf.js)
 *   Step D: Tax Collector scraper — Playwright stealth on the small
 *           surviving set (expensive, rate-limited)
 *   Step E: Distress scoring — final score with tax + out-of-state
 *
 * This order ensures we never hit the Tax Collector site with more
 * than ~100-200 properties, preventing IP bans and rate limiting.
 */

const fs = require("fs");
const path = require("path");

// Phase imports
const { loadZones, matchProperties } = require("./property_matcher");
const { classifyDorCode } = require("./miami_public_data");
const { scoreProperty, MOTIVATED_THRESHOLD } = require("./distress_analyzer");
const { evaluateConversion, MIN_SQFT, TARGET_UNITS, AVG_UNIT_SQFT } = require("./conversion_evaluator");
const { checkTaxDelinquencyBatch } = require("./tax_collector_scraper");

const OUTPUT_DIR = path.join(__dirname, "output");
const RAW_PROSPECTS_PATH = path.join(OUTPUT_DIR, "raw_massive_prospects.json");
const FINAL_OUTPUT_PATH = path.join(OUTPUT_DIR, "massive_unicorns.json");

// ---------------------------------------------------------------------------
// Step A: Load raw prospects
// ---------------------------------------------------------------------------

async function stepA_LoadProspects() {
  if (fs.existsSync(RAW_PROSPECTS_PATH)) {
    const prospects = JSON.parse(fs.readFileSync(RAW_PROSPECTS_PATH, "utf-8"));
    console.log(`   Loaded ${prospects.length} properties from cache.`);
    return prospects;
  }

  console.log("   No cached data. Fetching from county GIS...");
  const { fetchOfficeProspects, transformFeature } = require("./office_prospect_feeder");
  const features = await fetchOfficeProspects();
  const prospects = features.map(transformFeature);

  fs.writeFileSync(RAW_PROSPECTS_PATH, JSON.stringify(prospects, null, 2), "utf-8");
  console.log(`   Fetched and saved ${prospects.length} prospects.`);
  return prospects;
}

// ---------------------------------------------------------------------------
// Step B: Conversion feasibility filter (cheap — in-memory)
// ---------------------------------------------------------------------------

function stepB_ConversionFilter(properties) {
  // Attach physicalAttributes so evaluateConversion can read them
  const prepped = properties.map((p) => {
    const dorCode = p.dorCode || "";
    const propertyUse = classifyDorCode(dorCode);
    return {
      ...p,
      physicalAttributes: {
        propertyUse,
        propertyUseRaw: `${dorCode} - ${p.dorDescription || ""}`,
        buildingSqFt: p.buildingSqFt || 0,
      },
    };
  });

  const evaluated = prepped.map(evaluateConversion);
  const feasible = evaluated.filter((p) => p.conversionAnalysis.feasible);

  // Log breakdown
  const ineligibleType = evaluated.filter((p) => {
    const ca = p.conversionAnalysis;
    return !ca.feasible && ca.reasons.some((r) => r.includes("not eligible"));
  }).length;
  const tooSmall = evaluated.filter((p) => {
    const ca = p.conversionAnalysis;
    return !ca.feasible && ca.reasons.some((r) => r.includes("sq ft <"));
  }).length;

  console.log(`   ${feasible.length} survived (eligible type + >= ${MIN_SQFT.toLocaleString()} sq ft)`);
  console.log(`   Dropped: ${ineligibleType} ineligible type, ${tooSmall} too small`);

  return feasible;
}

// ---------------------------------------------------------------------------
// Step C: Zone matcher — ONLY keep properties inside incentive zones
// ---------------------------------------------------------------------------

function stepC_ZoneFilter(properties) {
  const zones = loadZones();
  console.log(`   Testing against ${zones.cra.features.length} CRA zones + ${zones.oz.features.length} Opportunity Zones...`);

  const matched = matchProperties(properties, zones);
  const inZone = matched.filter((p) => p.insideCRA || p.insideOZ);

  const craOnly = inZone.filter((p) => p.insideCRA && !p.insideOZ).length;
  const ozOnly = inZone.filter((p) => !p.insideCRA && p.insideOZ).length;
  const both = inZone.filter((p) => p.insideCRA && p.insideOZ).length;

  console.log(`   ${inZone.length} inside at least one incentive zone`);
  console.log(`   Breakdown: ${craOnly} CRA only, ${ozOnly} OZ only, ${both} both CRA+OZ`);
  console.log(`   Dropped: ${matched.length - inZone.length} outside all zones`);

  return inZone;
}

// ---------------------------------------------------------------------------
// Step D: Tax Collector scraper (expensive — Playwright)
// ---------------------------------------------------------------------------

async function stepD_TaxScraper(properties) {
  console.log(`   Launching Playwright stealth on ${properties.length} elite prospects...`);
  const enriched = await checkTaxDelinquencyBatch(properties);

  const delinquent = enriched.filter((p) => p.taxStatus && p.taxStatus.taxDelinquent);
  const scraped = enriched.filter((p) => p.taxStatus && p.taxStatus.source === "scraped");
  const fallback = enriched.filter((p) => p.taxStatus && p.taxStatus.source === "simulated-fallback");

  console.log(`   ${delinquent.length}/${enriched.length} flagged as tax delinquent`);
  if (scraped.length > 0) console.log(`   ${scraped.length} from live scrape`);
  if (fallback.length > 0) console.log(`   ${fallback.length} from simulated fallback`);

  return enriched;
}

// ---------------------------------------------------------------------------
// Step E: Distress scoring
// ---------------------------------------------------------------------------

function stepE_DistressScore(properties) {
  const enriched = properties.map((p) => {
    const ownerMailingState = (p.ownerMailingState || "").trim().toUpperCase();
    const outOfStateOwner = ownerMailingState !== "" && ownerMailingState !== "FL";

    const existingRecords = p.publicRecords || {};

    return {
      ...p,
      publicRecords: {
        taxDelinquent: existingRecords.taxDelinquent || false,
        taxDue: existingRecords.taxDue || 0,
        codeViolations: existingRecords.codeViolations || 0,
        outOfStateOwner,
      },
    };
  });

  const scored = enriched.map(scoreProperty);
  const motivated = scored.filter((p) => p.sellerTier === "Highly Motivated Seller");

  console.log(`   ${motivated.length}/${scored.length} scored as Highly Motivated (threshold: ${MOTIVATED_THRESHOLD}+)`);

  return { all: scored, motivated };
}

// ---------------------------------------------------------------------------
// Summary table
// ---------------------------------------------------------------------------

function printSummaryTable(allScored, unicorns) {
  console.log("\n============================================================");
  console.log("              MASSIVE PIPELINE — FINAL RESULTS");
  console.log("============================================================\n");

  if (allScored.length === 0) {
    console.log("No properties survived all filters.\n");
    return;
  }

  for (const p of allScored) {
    const zoneFlags = [];
    if (p.insideCRA) zoneFlags.push(`CRA: ${p.zones.cra.name.trim()}`);
    if (p.insideOZ) zoneFlags.push(`OZ: ${p.zones.opportunityZone.tract}`);
    const zoneStr = zoneFlags.join(" + ");

    const ca = p.conversionAnalysis;
    const taxStr = p.taxStatus
      ? (p.taxStatus.taxDelinquent
        ? `DELINQUENT $${p.taxStatus.taxDue.toLocaleString()} (${p.taxStatus.source})`
        : `Current (${p.taxStatus.source})`)
      : "N/A";

    console.log(`[${p.id}] ${p.address || "N/A"}`);
    console.log(`     Owner:      ${p.owner || "N/A"}  |  State: ${p.ownerMailingState || "N/A"}`);
    console.log(`     Building:   ${(p.buildingSqFt || 0).toLocaleString()} sq ft  |  ${ca.propertyUse} (Tier ${ca.conversionTier})  |  ~${ca.potentialUnits} units`);
    console.log(`     Zones:      ${zoneStr}`);
    console.log(`     Tax:        ${taxStr}`);
    console.log(`     Distress:   ${p.distressScore}/6  [${p.sellerTier}]  ${p.distressSignals.length ? "=> " + p.distressSignals.join(", ") : ""}`);
    console.log();
  }

  console.log("============================================================");
  if (unicorns.length > 0) {
    console.log(`  MASSIVE UNICORNS: ${unicorns.length} properties survived all filters`);
    console.log("============================================================\n");
    for (const u of unicorns) {
      const ca = u.conversionAnalysis;
      const taxLabel = u.taxStatus && u.taxStatus.taxDelinquent
        ? `TAX DELINQUENT $${u.taxStatus.taxDue.toLocaleString()}`
        : "Tax current";
      console.log(`  >> ${u.address} (Folio: ${u.folio || "N/A"})`);
      console.log(`     ${(u.buildingSqFt || 0).toLocaleString()} sq ft ${ca.propertyUse} (Tier ${ca.conversionTier})  |  ~${ca.potentialUnits} potential units`);
      console.log(`     Owner: ${u.owner || "N/A"} (${u.ownerMailingState || "N/A"})  |  Distress: ${u.distressScore}/6  |  ${taxLabel}`);
      const zf = [];
      if (u.insideCRA) zf.push(`CRA: ${u.zones.cra.name.trim()}`);
      if (u.insideOZ) zf.push(`OZ: ${u.zones.opportunityZone.tract}`);
      console.log(`     Incentive Zones: ${zf.join(" + ")}`);
      console.log();
    }
  } else {
    console.log("  NO UNICORNS survived all filters.");
    console.log("============================================================\n");
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const startTime = Date.now();

  console.log("================================================================");
  console.log("  TIPOZMAPS — Optimized Master Pipeline");
  console.log("  Filter order: Load -> Conversion -> Zones -> Tax -> Score");
  console.log("================================================================\n");

  // Step A: Load
  console.log("[STEP A] Load Raw Prospects");
  const raw = await stepA_LoadProspects();
  console.log(`\n   >>> ${raw.length} properties entering pipeline\n`);

  // Step B: Conversion filter (cheap)
  console.log("[STEP B] Conversion Feasibility Filter (in-memory)");
  const convertible = stepB_ConversionFilter(raw);
  console.log(`\n   >>> Survived Conversion Filter: ${convertible.length} of ${raw.length} (${(convertible.length / raw.length * 100).toFixed(1)}%)\n`);

  // Step C: Zone match (cheap)
  console.log("[STEP C] Incentive Zone Filter — CRA/TIF + Opportunity Zones (in-memory)");
  const inZone = stepC_ZoneFilter(convertible);
  console.log(`\n   >>> Survived Zone Match: ${inZone.length} of ${convertible.length} (${(inZone.length / convertible.length * 100).toFixed(1)}%)\n`);

  // Step D: Tax scraper (expensive — only runs on surviving set)
  console.log("[STEP D] Tax Collector Scraper (Playwright Stealth)");
  console.log(`   Only ${inZone.length} properties to scrape (saved ${raw.length - inZone.length} unnecessary requests)`);
  const taxChecked = await stepD_TaxScraper(inZone);
  console.log();

  // Step E: Distress scoring
  console.log("[STEP E] Distress Scoring Engine");
  const { all: allScored, motivated } = stepE_DistressScore(taxChecked);
  console.log();

  // Save final output
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }
  fs.writeFileSync(FINAL_OUTPUT_PATH, JSON.stringify(allScored, null, 2), "utf-8");

  // Print full results
  printSummaryTable(allScored, motivated);

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log("--- PIPELINE FUNNEL ---\n");
  console.log(`  Step A — Raw prospects loaded:    ${raw.length}`);
  console.log(`  Step B — Survived conversion:     ${convertible.length}`);
  console.log(`  Step C — Survived zone match:     ${inZone.length}`);
  console.log(`  Step D — Tax checked:             ${taxChecked.length} (${taxChecked.filter((p) => p.taxStatus && p.taxStatus.taxDelinquent).length} delinquent)`);
  console.log(`  Step E — Highly Motivated:        ${motivated.length}`);
  console.log(`  Elapsed:                          ${elapsed}s`);
  console.log(`  Scraper efficiency:               ${inZone.length} requests vs ${raw.length} without optimization (${((1 - inZone.length / raw.length) * 100).toFixed(1)}% reduction)`);
  console.log(`\n  Final output: ${FINAL_OUTPUT_PATH}`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
