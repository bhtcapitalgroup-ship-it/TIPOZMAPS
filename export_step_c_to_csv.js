#!/usr/bin/env node
/**
 * export_step_c_to_csv.js — CSV Exporter for Step C Prospects
 *
 * Re-runs the cheap in-memory filters (Conversion + Zone Match) on
 * the raw massive prospects, categorizes by zone overlap, and exports
 * a clean CSV ready for Google Sheets import.
 */

const fs = require("fs");
const path = require("path");
const { loadZones, matchProperties } = require("./property_matcher");
const { classifyDorCode } = require("./miami_public_data");
const { evaluateConversion } = require("./conversion_evaluator");

const INPUT_PATH = path.join(__dirname, "output", "raw_massive_prospects.json");
const OUTPUT_PATH = path.join(__dirname, "output", "step_c_prospects.csv");

// ---------------------------------------------------------------------------
// Zone category helper
// ---------------------------------------------------------------------------

function getZoneCategory(property) {
  if (property.insideCRA && property.insideOZ) return "CRA + OZ";
  if (property.insideCRA) return "CRA Only";
  if (property.insideOZ) return "OZ Only";
  return "None";
}

// ---------------------------------------------------------------------------
// CSV generation
// ---------------------------------------------------------------------------

function escapeCSV(value) {
  const str = String(value == null ? "" : value);
  if (str.includes(",") || str.includes('"') || str.includes("\n")) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

function toCSVRow(fields) {
  return fields.map(escapeCSV).join(",");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  console.log("=== TIPOZMAPS — CSV Exporter: Step C Elite Prospects ===\n");

  // Load raw prospects
  const raw = JSON.parse(fs.readFileSync(INPUT_PATH, "utf-8"));
  console.log(`Loaded ${raw.length} raw prospects.\n`);

  // Step B: Conversion filter
  const prepped = raw.map((p) => {
    const dorCode = p.dorCode || "";
    return {
      ...p,
      physicalAttributes: {
        propertyUse: classifyDorCode(dorCode),
        propertyUseRaw: `${dorCode} - ${p.dorDescription || ""}`,
        buildingSqFt: p.buildingSqFt || 0,
      },
    };
  });
  const evaluated = prepped.map(evaluateConversion);
  const feasible = evaluated.filter((p) => p.conversionAnalysis.feasible);
  console.log(`Step B — Conversion filter: ${feasible.length} survived.`);

  // Step C: Zone match
  const zones = loadZones();
  const matched = matchProperties(feasible, zones);
  const inZone = matched.filter((p) => p.insideCRA || p.insideOZ);
  console.log(`Step C — Zone match: ${inZone.length} inside incentive zones.\n`);

  // Categorize and sort: CRA + OZ first, then CRA Only, then OZ Only
  const categoryOrder = { "CRA + OZ": 0, "CRA Only": 1, "OZ Only": 2 };
  const categorized = inZone.map((p) => ({
    ...p,
    zoneCategory: getZoneCategory(p),
  }));
  categorized.sort((a, b) => categoryOrder[a.zoneCategory] - categoryOrder[b.zoneCategory]);

  // Count by category
  const counts = {};
  for (const p of categorized) {
    counts[p.zoneCategory] = (counts[p.zoneCategory] || 0) + 1;
  }
  console.log("Zone breakdown:");
  for (const [cat, count] of Object.entries(counts)) {
    console.log(`  ${cat}: ${count}`);
  }

  // Generate CSV
  const header = ["ZoneCategory", "Address", "BuildingSqFt", "PropertyType", "OwnerName", "OwnerState"];
  const rows = [toCSVRow(header)];

  for (const p of categorized) {
    rows.push(toCSVRow([
      p.zoneCategory,
      p.address || "N/A",
      p.buildingSqFt || 0,
      p.dorDescription || "N/A",
      p.owner || "N/A",
      p.ownerMailingState || "N/A",
    ]));
  }

  const csv = rows.join("\n") + "\n";
  fs.writeFileSync(OUTPUT_PATH, csv, "utf-8");

  console.log(`\n=== Exported ${categorized.length} prospects to ${OUTPUT_PATH} ===`);
  console.log(`File size: ${(Buffer.byteLength(csv) / 1024).toFixed(1)} KB`);
}

main();
