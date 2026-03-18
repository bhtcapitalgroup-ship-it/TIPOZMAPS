#!/usr/bin/env node
/**
 * conversion_evaluator.js — Phase 4: Office-to-Residential Conversion Filter
 *
 * Evaluates whether distressed target acquisitions are physically
 * feasible for conversion into a 200-unit mixed-use community.
 *
 * Feasibility threshold:
 *   200 units × 500 sq ft + common areas = 120,000 sq ft minimum
 *   Property use must be "Office" (DOR prefix 17xx)
 *
 * Can be run standalone or imported by the master pipeline.
 */

const fs = require("fs");
const path = require("path");

const INPUT_PATH = path.join(__dirname, "output", "target_acquisitions.json");
const OUTPUT_PATH = path.join(__dirname, "output", "conversion_unicorns.json");

const MIN_SQFT = 120000;
const TARGET_UNITS = 200;
const AVG_UNIT_SQFT = 500;
const REQUIRED_USE = "Office";

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
  if (!isOffice) reasons.push(`Use is "${propertyUse}" (${property.physicalAttributes.propertyUseRaw || "N/A"}), not Office`);
  if (!meetsSize) reasons.push(`${buildingSqFt.toLocaleString()} sq ft < ${MIN_SQFT.toLocaleString()} sq ft minimum`);

  return {
    ...property,
    conversionAnalysis: {
      feasible,
      propertyUse,
      propertyUseRaw: property.physicalAttributes.propertyUseRaw || null,
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
// Standalone CLI
// ---------------------------------------------------------------------------

function main() {
  console.log("=== TIPOZMAPS — Phase 4: Office-to-Resi Conversion Filter ===\n");
  console.log(`Feasibility threshold: ${MIN_SQFT.toLocaleString()} sq ft (${TARGET_UNITS} units × ${AVG_UNIT_SQFT} sq ft + common areas)\n`);

  const targets = JSON.parse(fs.readFileSync(INPUT_PATH, "utf-8"));
  console.log(`Loaded ${targets.length} highly motivated seller properties.\n`);

  const evaluated = targets.map(evaluateConversion);

  console.log("--- CONVERSION FEASIBILITY ---\n");
  for (const p of evaluated) {
    const ca = p.conversionAnalysis;
    const icon = ca.feasible ? "UNICORN" : "FAIL";

    console.log(`[${p.id}] ${p.address}`);
    console.log(`     Distress Score: ${p.distressScore}/6  |  Zones: ${p.insideCRA ? "CRA" : ""}${p.insideCRA && p.insideOZ ? " + " : ""}${p.insideOZ ? "OZ" : ""}`);
    console.log(`     Use: ${ca.propertyUse} (${ca.propertyUseRaw || "N/A"})  |  Size: ${ca.buildingSqFt.toLocaleString()} sq ft`);
    console.log(`     [${icon}] ${ca.reasons.join("; ")}`);
    if (ca.feasible) {
      console.log(`     => Potential: ~${ca.potentialUnits} units (target: ${TARGET_UNITS})`);
    }
    console.log();
  }

  const unicorns = evaluated.filter((p) => p.conversionAnalysis.feasible);
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(unicorns, null, 2), "utf-8");

  console.log("--- SUMMARY ---\n");
  console.log(`Evaluated:    ${evaluated.length} properties`);
  console.log(`Unicorns:     ${unicorns.length}`);
  console.log(`Filtered out: ${evaluated.length - unicorns.length}`);
  console.log(`\nSaved to ${OUTPUT_PATH}`);
}

if (require.main === module) {
  main();
}

module.exports = { evaluateConversion, MIN_SQFT, TARGET_UNITS, AVG_UNIT_SQFT, REQUIRED_USE };
