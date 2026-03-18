#!/usr/bin/env node
/**
 * office_prospect_feeder.js — Bulk Feeder: Large Commercial & Multi-Family
 *
 * Queries the Miami-Dade County GIS (MD_LandInformation MapServer,
 * Layer 26 — Parcels) for ALL large buildings >= 50,000 sq ft that
 * could be converted to residential or are already multi-family.
 *
 * Includes: Multi-Family (03), Retail/Shopping (11-29), Hotels (39),
 * Industrial/Warehouses (41-49), Institutional (71-73), Office (17).
 * Excludes: Single-Family (01, 02) and Vacant Land (00).
 *
 * Paginates through the ArcGIS REST API using resultOffset.
 */

const axios = require("axios");
const fs = require("fs");
const path = require("path");

const PARCEL_ENDPOINT =
  "https://gisweb.miamidade.gov/arcgis/rest/services/MD_LandInformation/MapServer/26/query";

const OUTPUT_PATH = path.join(__dirname, "output", "raw_massive_prospects.json");

const MIN_SQFT = 50000;
const PAGE_SIZE = 1000;

// Exclude single-family residential (01xx, 02xx) and vacant land (00xx).
// The 2-char prefix NOT IN catches all sub-codes (e.g., 0101, 0102, etc.)
const WHERE_CLAUSE =
  `BUILDING_ACTUAL_AREA >= ${MIN_SQFT}` +
  ` AND SUBSTRING(DOR_CODE_CUR, 1, 2) NOT IN ('00','01','02')`;

const TARGET_FIELDS = [
  "FOLIO",
  "DOR_CODE_CUR",
  "DOR_DESC",
  "BUILDING_ACTUAL_AREA",
  "BUILDING_HEATED_AREA",
  "TRUE_MAILING_STATE",
  "TRUE_OWNER1",
  "TRUE_SITE_ADDR",
  "YEAR_BUILT",
].join(",");

// ---------------------------------------------------------------------------
// Centroid computation from polygon rings
// ---------------------------------------------------------------------------

function computeCentroid(geometry) {
  if (!geometry || !geometry.rings || geometry.rings.length === 0) {
    return null;
  }

  const ring = geometry.rings[0];
  let sumLng = 0;
  let sumLat = 0;

  for (const [lng, lat] of ring) {
    sumLng += lng;
    sumLat += lat;
  }

  return {
    lng: parseFloat((sumLng / ring.length).toFixed(6)),
    lat: parseFloat((sumLat / ring.length).toFixed(6)),
  };
}

// ---------------------------------------------------------------------------
// Paginated query
// ---------------------------------------------------------------------------

async function fetchAllProspects() {
  console.log("Querying Miami-Dade County GIS for large commercial & multi-family buildings...");
  console.log(`  WHERE: ${WHERE_CLAUSE}`);
  console.log(`  Page size: ${PAGE_SIZE} (will paginate until exhausted)\n`);

  const allFeatures = [];
  let offset = 0;
  let page = 1;

  while (true) {
    const params = {
      where: WHERE_CLAUSE,
      outFields: TARGET_FIELDS,
      returnGeometry: true,
      outSR: 4326,
      resultRecordCount: PAGE_SIZE,
      resultOffset: offset,
      f: "json",
    };

    console.log(`  Page ${page}: fetching records ${offset}–${offset + PAGE_SIZE - 1}...`);

    const res = await axios.get(PARCEL_ENDPOINT, { params, timeout: 60000 });

    if (!res.data || !res.data.features) {
      throw new Error(`Unexpected API response on page ${page} — no features array`);
    }

    const features = res.data.features;
    console.log(`  Page ${page}: received ${features.length} records.`);

    if (features.length === 0) {
      break;
    }

    allFeatures.push(...features);
    offset += features.length;
    page++;

    if (features.length < PAGE_SIZE) {
      break;
    }

    // Brief pause between pages to be respectful to the server
    await new Promise((r) => setTimeout(r, 1000));
  }

  console.log(`\n  Pagination complete: ${allFeatures.length} total records across ${page - 1} page(s).\n`);
  return allFeatures;
}

// Backward-compat alias
async function fetchOfficeProspects() {
  return fetchAllProspects();
}

// ---------------------------------------------------------------------------
// Transform into pipeline-ready format
// ---------------------------------------------------------------------------

function transformFeature(feature, index) {
  const a = feature.attributes;
  const centroid = computeCentroid(feature.geometry);

  return {
    id: index + 1,
    folio: a.FOLIO,
    address: a.TRUE_SITE_ADDR || "N/A",
    lat: centroid ? centroid.lat : null,
    lng: centroid ? centroid.lng : null,
    owner: a.TRUE_OWNER1 || "N/A",
    dorCode: a.DOR_CODE_CUR,
    dorDescription: a.DOR_DESC || "",
    buildingSqFt: a.BUILDING_ACTUAL_AREA || 0,
    buildingHeatedSqFt: a.BUILDING_HEATED_AREA || 0,
    yearBuilt: a.YEAR_BUILT || null,
    ownerMailingState: (a.TRUE_MAILING_STATE || "").trim().toUpperCase(),
    source: "Miami-Dade County GIS — MD_LandInformation/MapServer/26",
    fetchedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("=== TIPOZMAPS — Bulk Feeder: All Large Commercial & Multi-Family >= 50,000 sq ft ===\n");

  const features = await fetchAllProspects();
  const prospects = features.map(transformFeature);

  // Print top 15 by building size
  console.log("--- TOP 15 PROSPECTS BY SIZE ---\n");
  const sorted = [...prospects].sort((a, b) => b.buildingSqFt - a.buildingSqFt);
  for (const p of sorted.slice(0, 15)) {
    const outOfState = p.ownerMailingState && p.ownerMailingState !== "FL" ? ` [${p.ownerMailingState}]` : "";
    console.log(`[${p.id}] ${p.address}  |  ${p.buildingSqFt.toLocaleString()} sq ft  |  ${p.dorCode} ${p.dorDescription.split(" : ")[0]}  |  ${p.owner}${outOfState}`);
  }
  if (prospects.length > 15) {
    console.log(`  ... and ${prospects.length - 15} more.\n`);
  }

  // Breakdown by property type
  const byType = {};
  for (const p of prospects) {
    const prefix = p.dorCode ? p.dorCode.substring(0, 2) : "??";
    const label = p.dorDescription.split(" : ").pop() || prefix;
    const key = `${prefix} - ${label}`;
    byType[key] = (byType[key] || 0) + 1;
  }

  console.log("--- BREAKDOWN BY PROPERTY TYPE ---\n");
  Object.entries(byType)
    .sort((a, b) => b[1] - a[1])
    .forEach(([type, count]) => console.log(`  ${type}: ${count}`));

  // Stats
  const outOfStateCount = prospects.filter((p) => p.ownerMailingState && p.ownerMailingState !== "FL" && p.ownerMailingState !== "").length;
  const avgSqFt = prospects.length > 0 ? Math.round(prospects.reduce((s, p) => s + p.buildingSqFt, 0) / prospects.length) : 0;
  const over100k = prospects.filter((p) => p.buildingSqFt >= 100000).length;
  const over120k = prospects.filter((p) => p.buildingSqFt >= 120000).length;

  console.log("\n--- STATISTICS ---\n");
  console.log(`  Total properties fetched:  ${prospects.length}`);
  console.log(`  Average building size:     ${avgSqFt.toLocaleString()} sq ft`);
  console.log(`  >= 100,000 sq ft:          ${over100k}`);
  console.log(`  >= 120,000 sq ft:          ${over120k}`);
  console.log(`  Out-of-state owners:       ${outOfStateCount}`);

  // Save to output
  if (!fs.existsSync(path.dirname(OUTPUT_PATH))) {
    fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  }
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(prospects, null, 2), "utf-8");

  console.log(`\n=== TOTAL: ${prospects.length} properties saved to ${OUTPUT_PATH} ===\n`);
  console.log("NEXT STEP: Run the master pipeline to process all prospects:");
  console.log("  node run_master_pipeline.js");
}

if (require.main === module) {
  main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}

module.exports = { fetchOfficeProspects, fetchAllProspects, transformFeature, computeCentroid };
