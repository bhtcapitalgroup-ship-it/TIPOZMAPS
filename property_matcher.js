#!/usr/bin/env node
/**
 * property_matcher.js — Phase 2: Property Overlay
 *
 * Point-in-Polygon analysis using Turf.js.
 * Takes property coordinates and determines which CRA/TIF zones
 * and Opportunity Zones (if any) each property falls within.
 *
 * Can be run standalone or imported by the master pipeline.
 */

const fs = require("fs");
const path = require("path");
const turf = require("@turf/turf");

const GEO_DIR = path.join(__dirname, "geo_data");
const OUTPUT_DIR = path.join(__dirname, "output");

// ---------------------------------------------------------------------------
// Load zone layers
// ---------------------------------------------------------------------------

function loadZones() {
  const cra = JSON.parse(
    fs.readFileSync(path.join(GEO_DIR, "miami_dade_cra_tif_zones.geojson"), "utf-8")
  );
  const oz = JSON.parse(
    fs.readFileSync(path.join(GEO_DIR, "opportunity_zones.geojson"), "utf-8")
  );
  return { cra, oz };
}

// ---------------------------------------------------------------------------
// Core engine — point-in-polygon matcher
// ---------------------------------------------------------------------------

/**
 * Matches a single property against all zone layers.
 *
 * @param {Object} property - Must contain { lat, lng, ... }
 * @param {Object} zones    - { cra: FeatureCollection, oz: FeatureCollection }
 * @returns {Object} The property enriched with zone match data
 */
function matchProperty(property, zones) {
  const point = turf.point([property.lng, property.lat]);

  const result = {
    ...property,
    zones: {
      cra: null,
      opportunityZone: null,
    },
    insideCRA: false,
    insideOZ: false,
  };

  // Check CRA / TIF zones
  for (const feature of zones.cra.features) {
    if (turf.booleanPointInPolygon(point, feature)) {
      result.zones.cra = {
        name: feature.properties.LOCATION || "Unknown CRA",
        acres: feature.properties.ACRE || null,
      };
      result.insideCRA = true;
      break;
    }
  }

  // Check Opportunity Zones
  for (const feature of zones.oz.features) {
    if (turf.booleanPointInPolygon(point, feature)) {
      result.zones.opportunityZone = {
        geoid: feature.properties.GEOID10 || null,
        tract: feature.properties.NAME10 || null,
      };
      result.insideOZ = true;
      break;
    }
  }

  return result;
}

/**
 * Batch-match an array of properties.
 */
function matchProperties(properties, zones) {
  return properties.map((p) => matchProperty(p, zones));
}

// ---------------------------------------------------------------------------
// Standalone CLI
// ---------------------------------------------------------------------------

const MOCK_PROPERTIES = [
  { id: 1, address: "150 NW 20th St, Miami, FL 33127", lat: 25.7880, lng: -80.1955, units: 12, zoning: "T6-8 Urban Core" },
  { id: 2, address: "401 NW 1st Pl, Miami, FL 33128", lat: 25.7763, lng: -80.2004, units: 48, zoning: "T6-24a Urban Core" },
  { id: 3, address: "12550 NE 7th Ave, North Miami, FL 33161", lat: 25.8967, lng: -80.1714, units: 8, zoning: "RD-15 Residential" },
  { id: 4, address: "7900 NW 27th Ave, Miami, FL 33147", lat: 25.8470, lng: -80.2316, units: 4, zoning: "T3-R Residential" },
  { id: 5, address: "8888 SW 136th St, Miami, FL 33176", lat: 25.6430, lng: -80.3350, units: 1, zoning: "EU-1 Single Family" },
];

function main() {
  console.log("=== TIPOZMAPS — Phase 2: Property Overlay Engine ===\n");

  // Determine input source: --input flag or mock data
  const inputFlag = process.argv.find((a) => a.startsWith("--input="));
  let properties;
  if (inputFlag) {
    const inputPath = path.resolve(inputFlag.split("=")[1]);
    properties = JSON.parse(fs.readFileSync(inputPath, "utf-8"));
    console.log(`Loaded ${properties.length} properties from ${inputPath}\n`);
  } else {
    properties = MOCK_PROPERTIES;
    console.log(`Using ${properties.length} built-in mock properties.\n`);
  }

  const zones = loadZones();
  console.log(`Loaded ${zones.cra.features.length} CRA zones, ${zones.oz.features.length} Opportunity Zones.\n`);

  const results = matchProperties(properties, zones);

  const matched = [];
  for (const r of results) {
    const flags = [];
    if (r.insideCRA) flags.push(`CRA: ${r.zones.cra.name}`);
    if (r.insideOZ) flags.push(`OZ Tract: ${r.zones.opportunityZone.tract} (${r.zones.opportunityZone.geoid})`);

    const status = flags.length > 0 ? flags.join(" | ") : "NO MATCH";
    console.log(`[${r.id}] ${r.address}`);
    console.log(`     => ${status}`);
    console.log();

    if (flags.length > 0) matched.push(r);
  }

  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  const outPath = path.join(OUTPUT_DIR, "matched_properties.json");
  fs.writeFileSync(outPath, JSON.stringify(matched, null, 2), "utf-8");

  console.log(`=== ${matched.length}/${results.length} properties matched at least one zone. ===`);
  console.log(`Saved to ${outPath}`);
}

// Run standalone if executed directly
if (require.main === module) {
  main();
}

// Export core functions for the master pipeline
module.exports = { loadZones, matchProperty, matchProperties };
