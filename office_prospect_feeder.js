#!/usr/bin/env node
/**
 * office_prospect_feeder.js — Bulk Feeder: Large Office Complexes
 *
 * Queries the Miami-Dade County GIS (MD_LandInformation MapServer,
 * Layer 26 — Parcels) for ALL office properties >= 50,000 sq ft.
 *
 * Paginates through the ArcGIS REST API using resultOffset since the
 * server caps responses at ~1000 records per request.
 *
 * Saves results with centroid coordinates to output/raw_office_prospects.json
 * so they can be piped through the full analysis pipeline.
 */

const axios = require("axios");
const fs = require("fs");
const path = require("path");

const PARCEL_ENDPOINT =
  "https://gisweb.miamidade.gov/arcgis/rest/services/MD_LandInformation/MapServer/26/query";

const OUTPUT_PATH = path.join(__dirname, "output", "raw_office_prospects.json");

const MIN_SQFT = 50000;
const PAGE_SIZE = 1000;

const WHERE_CLAUSE = `DOR_CODE_CUR LIKE '17%' AND BUILDING_ACTUAL_AREA >= ${MIN_SQFT}`;

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

async function fetchAllOfficeProspects() {
  console.log("Querying Miami-Dade County GIS for office complexes >= 50,000 sq ft...");
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

    // If we got fewer than PAGE_SIZE, we've reached the end
    if (features.length < PAGE_SIZE) {
      break;
    }

    // Brief pause between pages to be respectful to the server
    await new Promise((r) => setTimeout(r, 1000));
  }

  console.log(`\n  Pagination complete: ${allFeatures.length} total records across ${page - 1} page(s).\n`);
  return allFeatures;
}

// Legacy single-page fetch (kept for backward compat with master pipeline import)
async function fetchOfficeProspects() {
  return fetchAllOfficeProspects();
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
  console.log("=== TIPOZMAPS — Bulk Feeder: Office Complexes >= 50,000 sq ft ===\n");

  const features = await fetchAllOfficeProspects();
  const prospects = features.map(transformFeature);

  // Print summary (compact for large datasets)
  console.log("--- PROSPECTS (top 10 by building size) ---\n");
  const sorted = [...prospects].sort((a, b) => b.buildingSqFt - a.buildingSqFt);
  for (const p of sorted.slice(0, 10)) {
    const outOfState = p.ownerMailingState && p.ownerMailingState !== "FL" ? ` [OUT-OF-STATE: ${p.ownerMailingState}]` : "";
    console.log(`[${p.id}] ${p.address}  |  ${p.buildingSqFt.toLocaleString()} sq ft  |  ${p.owner}${outOfState}`);
  }
  if (prospects.length > 10) {
    console.log(`  ... and ${prospects.length - 10} more.\n`);
  }

  // Stats
  const outOfStateCount = prospects.filter((p) => p.ownerMailingState && p.ownerMailingState !== "FL" && p.ownerMailingState !== "").length;
  const avgSqFt = Math.round(prospects.reduce((s, p) => s + p.buildingSqFt, 0) / prospects.length);
  const over100k = prospects.filter((p) => p.buildingSqFt >= 100000).length;
  const over120k = prospects.filter((p) => p.buildingSqFt >= 120000).length;

  console.log("--- STATISTICS ---\n");
  console.log(`  Total properties fetched:  ${prospects.length}`);
  console.log(`  Average building size:     ${avgSqFt.toLocaleString()} sq ft`);
  console.log(`  >= 100,000 sq ft:          ${over100k}`);
  console.log(`  >= 120,000 sq ft:          ${over120k} (Phase 4 conversion threshold)`);
  console.log(`  Out-of-state owners:       ${outOfStateCount}`);

  // Save to output
  if (!fs.existsSync(path.dirname(OUTPUT_PATH))) {
    fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  }
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(prospects, null, 2), "utf-8");

  console.log(`\n=== SAVED ${prospects.length} office prospects to ${OUTPUT_PATH} ===\n`);
  console.log("NEXT STEP: Run the master pipeline to process all prospects:");
  console.log("  node run_master_pipeline.js");
}

if (require.main === module) {
  main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}

module.exports = { fetchOfficeProspects, fetchAllOfficeProspects, transformFeature, computeCentroid };
