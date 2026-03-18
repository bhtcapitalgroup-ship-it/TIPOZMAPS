#!/usr/bin/env node
/**
 * conversion_evaluator.js — Phase 4: Office-to-Residential Conversion Filter
 *
 * Evaluates whether distressed target acquisitions are physically
 * feasible for conversion into a 200-unit mixed-use community.
 *
 * Feasibility threshold:
 *   200 units × 500 sq ft + common areas = 120,000 sq ft minimum
 *   Property use must be "Office" (best candidate for resi conversion)
 *
 * Mocks physical attributes until a county appraiser API is wired in.
 */

const fs = require("fs");
const path = require("path");

const INPUT_PATH = path.join(__dirname, "output", "target_acquisitions.json");
const OUTPUT_PATH = path.join(__dirname, "output", "conversion_unicorns.json");

const MIN_SQFT = 120000;
const TARGET_UNITS = 200;
const AVG_UNIT_SQFT = 500;
const REQUIRED_USE = "Office";

const PROPERTY_USES = ["Office", "Retail", "Industrial"];

// ---------------------------------------------------------------------------
// Mock physical attribute enrichment
// ---------------------------------------------------------------------------

/**
 * Simulates a county appraiser lookup. Uses a fixed lookup table keyed
 * by property ID so results are deterministic and demonstrate all three
 * filter outcomes: pass, fail-on-use, and fail-on-size.
 *
 * In production this would call the Miami-Dade Property Appraiser API.
 */
const MOCK_PHYSICAL_DATA = {
  1: { propertyUse: "Office",     buildingSqFt: 135000 }, // Office + big enough => UNICORN
  2: { propertyUse: "Retail",     buildingSqFt: 142000 }, // Big enough but wrong use => FAIL
  4: { propertyUse: "Office",     buildingSqFt: 78000 },  // Office but too small => FAIL
};

function enrichPhysicalAttributes(property) {
  const mock = MOCK_PHYSICAL_DATA[property.id] || {
    propertyUse: PROPERTY_USES[property.id % PROPERTY_USES.length],
    buildingSqFt: Math.round(10000 + (((property.id * 374761393) >>> 0) / 4294967296) * 140000),
  };

  return {
    ...property,
    physicalAttributes: mock,
  };
}

// ---------------------------------------------------------------------------
// Conversion feasibility check
// ---------------------------------------------------------------------------

function evaluateConversion(property) {
  const { propertyUse, buildingSqFt } = property.physicalAttributes;

  const isOffice = propertyUse === REQUIRED_USE;
  const meetsSize = buildingSqFt >= MIN_SQFT;
  const feasible = isOffice && meetsSize;

  const potentialUnits = meetsSize
    ? Math.floor(buildingSqFt * 0.8 / AVG_UNIT_SQFT) // 80% efficiency ratio
    : 0;

  const reasons = [];
  if (!isOffice) reasons.push(`Use is "${propertyUse}", not Office`);
  if (!meetsSize) reasons.push(`${buildingSqFt.toLocaleString()} sq ft < ${MIN_SQFT.toLocaleString()} sq ft minimum`);

  return {
    ...property,
    conversionAnalysis: {
      feasible,
      propertyUse,
      buildingSqFt,
      minRequired: MIN_SQFT,
      potentialUnits,
      targetUnits: TARGET_UNITS,
      reasons: feasible
        ? [`${buildingSqFt.toLocaleString()} sq ft Office — fits ~${potentialUnits} units at 80% efficiency`]
        : reasons,
    },
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  console.log("=== TIPOZMAPS — Phase 4: Office-to-Resi Conversion Filter ===\n");
  console.log(`Feasibility threshold: ${MIN_SQFT.toLocaleString()} sq ft (${TARGET_UNITS} units × ${AVG_UNIT_SQFT} sq ft + common areas)\n`);

  // 1. Load targets
  const targets = JSON.parse(fs.readFileSync(INPUT_PATH, "utf-8"));
  console.log(`Loaded ${targets.length} highly motivated seller properties.\n`);

  // 2. Enrich with physical attributes
  const enriched = targets.map(enrichPhysicalAttributes);

  // 3. Evaluate each
  const evaluated = enriched.map(evaluateConversion);

  // 4. Print evaluation
  console.log("--- CONVERSION FEASIBILITY ---\n");
  for (const p of evaluated) {
    const ca = p.conversionAnalysis;
    const icon = ca.feasible ? "UNICORN" : "FAIL";

    console.log(`[${p.id}] ${p.address}`);
    console.log(`     Distress Score: ${p.distressScore}/6  |  Zones: ${p.insideCRA ? "CRA" : ""}${p.insideCRA && p.insideOZ ? " + " : ""}${p.insideOZ ? "OZ" : ""}`);
    console.log(`     Use: ${ca.propertyUse}  |  Size: ${ca.buildingSqFt.toLocaleString()} sq ft`);
    console.log(`     [${icon}] ${ca.reasons.join("; ")}`);
    if (ca.feasible) {
      console.log(`     => Potential: ~${ca.potentialUnits} units (target: ${TARGET_UNITS})`);
    }
    console.log();
  }

  // 5. Filter unicorns and save
  const unicorns = evaluated.filter((p) => p.conversionAnalysis.feasible);

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(unicorns, null, 2), "utf-8");

  console.log("--- SUMMARY ---\n");
  console.log(`Evaluated:    ${evaluated.length} properties`);
  console.log(`Unicorns:     ${unicorns.length}`);
  console.log(`Filtered out: ${evaluated.length - unicorns.length}`);
  console.log(`\nSaved to ${OUTPUT_PATH}`);
}

main();
