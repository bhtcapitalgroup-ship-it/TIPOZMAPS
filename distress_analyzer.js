#!/usr/bin/env node
/**
 * distress_analyzer.js — Phase 3: Distress Scoring Engine
 *
 * Reads zone-matched properties from Phase 2, enriches them with
 * real Miami-Dade County parcel data via the public ArcGIS API,
 * scores each for seller motivation, and exports high-scoring leads.
 *
 * Scoring rubric:
 *   Tax Delinquent        = +3 pts
 *   Code Violations >$5k  = +2 pts
 *   Out-of-State Owner    = +1 pt
 *
 * Properties scoring >= 3 are flagged "Highly Motivated Seller".
 */

const fs = require("fs");
const path = require("path");
const { enrichAll } = require("./miami_public_data");

const INPUT_PATH = path.join(__dirname, "output", "matched_properties.json");
const OUTPUT_PATH = path.join(__dirname, "output", "target_acquisitions.json");

const MOTIVATED_THRESHOLD = 3;

// ---------------------------------------------------------------------------
// Distress scoring
// ---------------------------------------------------------------------------

function scoreProperty(property) {
  const { taxDelinquent, codeViolations, outOfStateOwner } =
    property.publicRecords;

  let score = 0;
  const signals = [];

  if (taxDelinquent) {
    score += 3;
    signals.push("Tax Delinquent (+3)");
  }
  if (codeViolations > 5000) {
    score += 2;
    signals.push(`Code Violations: $${codeViolations.toLocaleString()} (+2)`);
  }
  if (outOfStateOwner) {
    score += 1;
    signals.push("Out-of-State Owner (+1)");
  }

  const tier =
    score >= MOTIVATED_THRESHOLD ? "Highly Motivated Seller" : "Standard";

  return {
    ...property,
    distressScore: score,
    distressSignals: signals,
    sellerTier: tier,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("=== TIPOZMAPS — Phase 3: Distress Scoring Engine ===\n");

  // 1. Read matched properties
  const matched = JSON.parse(fs.readFileSync(INPUT_PATH, "utf-8"));
  console.log(`Loaded ${matched.length} zone-matched properties from Phase 2.\n`);

  // 2. Enrich with real county data
  console.log("Querying Miami-Dade County ArcGIS parcel API...\n");
  const enriched = await enrichAll(matched);

  // 3. Score each property
  const scored = enriched.map(scoreProperty);

  // 4. Print scorecard
  console.log("\n--- SCORECARD ---\n");
  for (const p of scored) {
    const zoneFlags = [];
    if (p.insideCRA) zoneFlags.push(`CRA: ${p.zones.cra.name.trim()}`);
    if (p.insideOZ) zoneFlags.push(`OZ: ${p.zones.opportunityZone.tract}`);

    const cd = p.countyData;
    console.log(`[${p.id}] ${p.address}`);
    if (cd) {
      console.log(`     Folio: ${cd.folio}  |  Owner: ${cd.ownerName}`);
      console.log(`     DOR: ${cd.dorCode} (${cd.dorDescription})  |  ${(cd.buildingActualArea || 0).toLocaleString()} sq ft  |  Built: ${cd.yearBuilt || "N/A"}`);
      console.log(`     Mailing State: ${cd.ownerMailingState || "N/A"}`);
    }
    console.log(`     Zones:    ${zoneFlags.join(" | ") || "—"}`);
    console.log(`     Tax Del.: ${p.publicRecords.taxDelinquent ? "YES" : "no (needs Tax Collector scraper)"}  |  ` +
      `Out-of-State: ${p.publicRecords.outOfStateOwner ? "YES" : "no"}`);
    console.log(`     Score:    ${p.distressScore}/6  =>  ${p.sellerTier}`);
    if (p.distressSignals.length) {
      console.log(`     Signals:  ${p.distressSignals.join(", ")}`);
    }
    console.log();
  }

  // 5. Filter and save target acquisitions
  const targets = scored.filter((p) => p.sellerTier === "Highly Motivated Seller");

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(targets, null, 2), "utf-8");

  console.log("--- SUMMARY ---\n");
  console.log(`Total scored:       ${scored.length}`);
  console.log(`Highly Motivated:   ${targets.length}`);
  console.log(`Standard:           ${scored.length - targets.length}`);
  console.log(`\nTarget acquisitions saved to ${OUTPUT_PATH}`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
