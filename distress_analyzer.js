#!/usr/bin/env node
/**
 * distress_analyzer.js — Phase 3: Distress Scoring Engine
 *
 * Reads zone-matched properties from Phase 2, enriches them with
 * simulated public-record data, scores each for seller motivation,
 * and exports high-scoring leads as target acquisitions.
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

const INPUT_PATH = path.join(__dirname, "output", "matched_properties.json");
const OUTPUT_PATH = path.join(__dirname, "output", "target_acquisitions.json");

const MOTIVATED_THRESHOLD = 3;

// ---------------------------------------------------------------------------
// Simulated public-record enrichment
// ---------------------------------------------------------------------------

/**
 * Mocks a county records lookup. In production this would call a
 * property-data API (ATTOM, PropStream, etc.).
 *
 * Uses a seeded PRNG per property ID so results are reproducible
 * across runs while still looking "random".
 */
function seedRandom(seed) {
  // Simple mulberry32 PRNG — deterministic per property
  let t = (seed * 2654435761 + 0x6d2b79f5) | 0;
  return function () {
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function enrichWithPublicRecords(property) {
  const rand = seedRandom(property.id);

  const taxDelinquent = rand() > 0.45;
  const codeViolations = Math.round(rand() * 15000);
  const outOfStateOwner = rand() > 0.5;

  return {
    ...property,
    publicRecords: {
      taxDelinquent,
      codeViolations,
      outOfStateOwner,
    },
  };
}

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

function main() {
  console.log("=== TIPOZMAPS — Phase 3: Distress Scoring Engine ===\n");

  // 1. Read matched properties
  const matched = JSON.parse(fs.readFileSync(INPUT_PATH, "utf-8"));
  console.log(`Loaded ${matched.length} zone-matched properties from Phase 2.\n`);

  // 2. Enrich with simulated public records
  const enriched = matched.map(enrichWithPublicRecords);

  // 3. Score each property
  const scored = enriched.map(scoreProperty);

  // 4. Print scorecard
  console.log("--- SCORECARD ---\n");
  for (const p of scored) {
    const zoneFlags = [];
    if (p.insideCRA) zoneFlags.push(`CRA: ${p.zones.cra.name.trim()}`);
    if (p.insideOZ) zoneFlags.push(`OZ: ${p.zones.opportunityZone.tract}`);

    console.log(`[${p.id}] ${p.address}`);
    console.log(`     Zones:    ${zoneFlags.join(" | ") || "—"}`);
    console.log(`     Tax Del.: ${p.publicRecords.taxDelinquent ? "YES" : "no"}  |  ` +
      `Violations: $${p.publicRecords.codeViolations.toLocaleString()}  |  ` +
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

main();
