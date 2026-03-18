#!/usr/bin/env node
/**
 * office_prospect_feeder.js — Bulk Feeder: Large Office Complexes
 *
 * Queries the Miami-Dade County GIS (MD_LandInformation MapServer,
 * Layer 26 — Parcels) for properties that meet our conversion criteria:
 *   - DOR code 17xx (Office buildings)
 *   - Building actual area >= 120,000 sq ft
 *
 * Saves results with centroid coordinates to output/raw_office_prospects.json
 * so they can be piped through the Phase 2 zone matcher.
 */

const axios = require("axios");
const fs = require("fs");
const path = require("path");

const PARCEL_ENDPOINT =
  "https://gisweb.miamidade.gov/arcgis/rest/services/MD_LandInformation/MapServer/26/query";

const OUTPUT_PATH = path.join(__dirname, "output", "raw_office_prospects.json");

const MIN_SQFT = 120000;
const MAX_RESULTS = 50;

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

/**
 * Compute the centroid of a polygon by averaging all vertices in the
 * outer ring. Good enough for parcel-level accuracy.
 */
function computeCentroid(geometry) {
  if (!geometry || !geometry.rings || geometry.rings.length === 0) {
    return null;
  }

  const ring = geometry.rings[0]; // outer ring
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
// Query the county GIS
// ---------------------------------------------------------------------------

async function fetchOfficeProspects() {
  console.log("Querying Miami-Dade County GIS for large office complexes...");
  console.log(`  Filter: DOR_CODE_CUR LIKE '17%' AND BUILDING_ACTUAL_AREA >= ${MIN_SQFT.toLocaleString()}`);
  console.log(`  Max results: ${MAX_RESULTS}\n`);

  const params = {
    where: `DOR_CODE_CUR LIKE '17%' AND BUILDING_ACTUAL_AREA >= ${MIN_SQFT}`,
    outFields: TARGET_FIELDS,
    returnGeometry: true,
    outSR: 4326,
    resultRecordCount: MAX_RESULTS,
    f: "json",
  };

  const res = await axios.get(PARCEL_ENDPOINT, { params, timeout: 30000 });

  if (!res.data || !res.data.features) {
    throw new Error("Unexpected API response — no features array");
  }

  return res.data.features;
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
  console.log("=== TIPOZMAPS — Bulk Feeder: Large Office Complexes ===\n");

  const features = await fetchOfficeProspects();
  console.log(`API returned ${features.length} parcels.\n`);

  const prospects = features.map(transformFeature);

  // Print summary table
  console.log("--- PROSPECTS ---\n");
  for (const p of prospects) {
    const outOfState = p.ownerMailingState && p.ownerMailingState !== "FL" ? ` [OUT-OF-STATE: ${p.ownerMailingState}]` : "";
    console.log(`[${p.id}] ${p.address}`);
    console.log(`     Folio: ${p.folio}  |  Owner: ${p.owner}${outOfState}`);
    console.log(`     DOR: ${p.dorCode} (${p.dorDescription})`);
    console.log(`     Building: ${p.buildingSqFt.toLocaleString()} sq ft  |  Heated: ${p.buildingHeatedSqFt.toLocaleString()} sq ft  |  Built: ${p.yearBuilt || "N/A"}`);
    console.log(`     Coords: ${p.lat}, ${p.lng}`);
    console.log();
  }

  // Save to output
  if (!fs.existsSync(path.dirname(OUTPUT_PATH))) {
    fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  }
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(prospects, null, 2), "utf-8");

  console.log(`--- SAVED ${prospects.length} prospects to ${OUTPUT_PATH} ---\n`);
  console.log("NEXT STEP: Run these prospects through the zone matcher (Phase 2):");
  console.log("  node property_matcher.js --input output/raw_office_prospects.json");
  console.log("\nThis will tag each prospect with CRA/TIF and Opportunity Zone overlays,");
  console.log("then feed into distress_analyzer.js (Phase 3) and conversion_evaluator.js (Phase 4).");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
