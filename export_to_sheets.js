#!/usr/bin/env node
/**
 * export_to_sheets.js — Master Leads CSV for Google Sheets
 *
 * Reads the final massive_unicorns.json and exports a clean CSV
 * with all key fields plus Google Maps links for each property.
 */

const fs = require("fs");
const path = require("path");

const INPUT_PATH = path.join(__dirname, "output", "massive_unicorns.json");
const OUTPUT_PATH = path.join(__dirname, "output", "Miami_Master_Leads.csv");

// ---------------------------------------------------------------------------
// Helpers
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

/**
 * Extract city from the address + lat/lng context.
 * Miami-Dade addresses don't include city, so we infer from
 * known neighborhood/zone data when available.
 */
function inferCity(property) {
  if (property.insideCRA && property.zones.cra) {
    const cra = property.zones.cra.name.trim();
    if (/homestead/i.test(cra)) return "Homestead";
    if (/florida city/i.test(cra)) return "Florida City";
    if (/north miami beach/i.test(cra)) return "North Miami Beach";
    if (/north miami/i.test(cra)) return "North Miami";
    if (/miami gardens/i.test(cra)) return "Miami Gardens";
    if (/miami beach/i.test(cra)) return "Miami Beach";
    if (/opa.locka/i.test(cra)) return "Opa-Locka";
    if (/midtown|omni|overtown|nw 7th|nw 79th/i.test(cra)) return "Miami";
  }
  // Default for Miami-Dade unincorporated or unknown
  const lat = property.lat || 0;
  if (lat > 25.92) return "Miami Gardens";
  if (lat > 25.85) return "Hialeah";
  if (lat > 25.75) return "Miami";
  if (lat > 25.60) return "Cutler Bay";
  if (lat > 25.50) return "Homestead";
  return "Miami-Dade County";
}

function getZoneLabel(property) {
  const parts = [];
  if (property.insideCRA) parts.push("CRA: " + property.zones.cra.name.trim());
  if (property.insideOZ) parts.push("OZ: " + property.zones.opportunityZone.tract);
  return parts.join(" + ") || "None";
}

function buildGoogleMapsLink(property) {
  if (property.lat && property.lng) {
    return `https://www.google.com/maps/search/?api=1&query=${property.lat},${property.lng}`;
  }
  const addr = (property.address || "") + ", Miami-Dade County, FL";
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(addr)}`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  console.log("=== TIPOZMAPS — Master Leads CSV Exporter ===\n");

  const data = JSON.parse(fs.readFileSync(INPUT_PATH, "utf-8"));
  console.log(`Loaded ${data.length} properties from massive_unicorns.json\n`);

  // Sort by distress score desc, then building size desc
  data.sort((a, b) => b.distressScore - a.distressScore || b.buildingSqFt - a.buildingSqFt);

  // CSV header
  const headers = [
    "Address",
    "City",
    "Property Type",
    "Building Sq Ft",
    "Estimated Units",
    "Owner Name",
    "Owner State",
    "Tax Status",
    "Zones",
    "Distress Score",
    "Google Maps Link",
  ];

  const rows = [toCSVRow(headers)];

  for (const p of data) {
    const taxStatus = p.taxStatus && p.taxStatus.taxDelinquent
      ? `Delinquent ($${(p.taxStatus.taxDue || 0).toLocaleString()})`
      : "Current";

    const estimatedUnits = Math.floor((p.buildingSqFt || 0) / 500);

    rows.push(toCSVRow([
      p.address || "N/A",
      inferCity(p),
      p.dorDescription ? p.dorDescription.split(" : ")[0] : "N/A",
      p.buildingSqFt || 0,
      estimatedUnits,
      p.owner || "N/A",
      p.ownerMailingState || "N/A",
      taxStatus,
      getZoneLabel(p),
      `${p.distressScore}/6`,
      buildGoogleMapsLink(p),
    ]));
  }

  const csv = rows.join("\n") + "\n";
  fs.writeFileSync(OUTPUT_PATH, csv, "utf-8");

  // Summary
  const score4 = data.filter((p) => p.distressScore >= 4).length;
  const score3 = data.filter((p) => p.distressScore === 3).length;
  const outOfState = data.filter((p) => p.ownerMailingState && p.ownerMailingState !== "FL" && p.ownerMailingState !== "").length;

  console.log(`--- EXPORT SUMMARY ---\n`);
  console.log(`  Total rows:         ${data.length}`);
  console.log(`  Distress 4/6:       ${score4}`);
  console.log(`  Distress 3/6:       ${score3}`);
  console.log(`  Out-of-state owners: ${outOfState}`);
  console.log(`  File size:          ${(Buffer.byteLength(csv) / 1024).toFixed(1)} KB`);
  console.log(`\n=== Saved to ${OUTPUT_PATH} ===`);
}

main();
