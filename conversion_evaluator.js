#!/usr/bin/env node
/**
 * conversion_evaluator.js — Phase 4: Conversion Feasibility Filter
 *
 * Evaluates whether distressed properties are physically feasible
 * for conversion into a 200-unit mixed-use residential community.
 *
 * Feasibility threshold:
 *   200 units × 500 sq ft + common areas = 120,000 sq ft minimum
 *
 * Eligible property types for conversion:
 *   - Office (DOR 17xx) — best candidate, open floor plans
 *   - Hotel/Motel (DOR 39xx) — already has unit layouts + plumbing
 *   - Industrial/Warehouse (DOR 20-30, 40-49) — large open shells
 *   - Retail/Shopping (DOR 11-16, 18-19) — large footprints
 *   - Institutional (DOR 71-73) — hospitals, schools
 *   - Multi-Family (DOR 03-09) — already residential, expansion potential
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

// Property types eligible for residential conversion, with efficiency ratios
// (how much of the gross area converts to usable residential space)
const CONVERTIBLE_TYPES = {
  "Office":                 { eligible: true, efficiency: 0.80, tier: "A" },
  "Hotel/Motel":            { eligible: true, efficiency: 0.85, tier: "A" },
  "Industrial":             { eligible: true, efficiency: 0.70, tier: "B" },
  "Industrial/Warehouse":   { eligible: true, efficiency: 0.70, tier: "B" },
  "Industrial/Light Mfg":   { eligible: true, efficiency: 0.65, tier: "B" },
  "Industrial/Heavy Mfg":   { eligible: true, efficiency: 0.60, tier: "C" },
  "Industrial/Wholesale":   { eligible: true, efficiency: 0.70, tier: "B" },
  "Industrial/Lumber":      { eligible: true, efficiency: 0.65, tier: "C" },
  "Industrial/Vacant":      { eligible: true, efficiency: 0.70, tier: "B" },
  "Retail/Stores":          { eligible: true, efficiency: 0.75, tier: "B" },
  "Retail/Mixed":           { eligible: true, efficiency: 0.75, tier: "B" },
  "Retail/Department Store":{ eligible: true, efficiency: 0.75, tier: "B" },
  "Retail/Supermarket":     { eligible: true, efficiency: 0.70, tier: "B" },
  "Retail/Community Shopping":{ eligible: true, efficiency: 0.75, tier: "B" },
  "Retail/Eating/Drinking": { eligible: true, efficiency: 0.70, tier: "C" },
  "Retail/Financial":       { eligible: true, efficiency: 0.80, tier: "A" },
  "Hospital":               { eligible: true, efficiency: 0.75, tier: "B" },
  "School":                 { eligible: true, efficiency: 0.70, tier: "B" },
  "Church":                 { eligible: true, efficiency: 0.65, tier: "C" },
  "Residential":            { eligible: true, efficiency: 0.90, tier: "A" },
  "Commercial":             { eligible: true, efficiency: 0.75, tier: "B" },
};

// ---------------------------------------------------------------------------
// Conversion feasibility check
// ---------------------------------------------------------------------------

function evaluateConversion(property) {
  const { propertyUse, buildingSqFt } = property.physicalAttributes;

  const typeInfo = CONVERTIBLE_TYPES[propertyUse] || { eligible: false, efficiency: 0, tier: "X" };
  const isEligibleType = typeInfo.eligible;
  const meetsSize = buildingSqFt >= MIN_SQFT;
  const feasible = isEligibleType && meetsSize;

  const efficiency = typeInfo.efficiency;
  const potentialUnits = feasible
    ? Math.floor(buildingSqFt * efficiency / AVG_UNIT_SQFT)
    : 0;

  const reasons = [];
  if (!isEligibleType) reasons.push(`"${propertyUse}" is not eligible for conversion`);
  if (!meetsSize) reasons.push(`${buildingSqFt.toLocaleString()} sq ft < ${MIN_SQFT.toLocaleString()} sq ft minimum`);

  return {
    ...property,
    conversionAnalysis: {
      feasible,
      propertyUse,
      propertyUseRaw: property.physicalAttributes.propertyUseRaw || null,
      conversionTier: typeInfo.tier,
      efficiency,
      buildingSqFt,
      minRequired: MIN_SQFT,
      potentialUnits,
      targetUnits: TARGET_UNITS,
      reasons: feasible
        ? [`${buildingSqFt.toLocaleString()} sq ft ${propertyUse} (Tier ${typeInfo.tier}, ${Math.round(efficiency * 100)}% eff.) — fits ~${potentialUnits} units`]
        : reasons,
    },
  };
}

// ---------------------------------------------------------------------------
// Standalone CLI
// ---------------------------------------------------------------------------

function main() {
  console.log("=== TIPOZMAPS — Phase 4: Conversion Feasibility Filter ===\n");
  console.log(`Feasibility threshold: ${MIN_SQFT.toLocaleString()} sq ft (${TARGET_UNITS} units × ${AVG_UNIT_SQFT} sq ft + common areas)`);
  console.log(`Eligible types: ${Object.keys(CONVERTIBLE_TYPES).join(", ")}\n`);

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
      console.log(`     => Tier ${ca.conversionTier} | Eff: ${Math.round(ca.efficiency * 100)}% | ~${ca.potentialUnits} units (target: ${TARGET_UNITS})`);
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

module.exports = { evaluateConversion, CONVERTIBLE_TYPES, MIN_SQFT, TARGET_UNITS, AVG_UNIT_SQFT };
