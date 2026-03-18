#!/usr/bin/env node
/**
 * fetch_geo_zones.js — Phase 1: Geographic Layer
 *
 * Fetches public GeoJSON boundary data for:
 *   1. Miami-Dade County CRAs (Community Redevelopment Areas / TIF zones)
 *   2. Opportunity Zones (from the US Census / HUD via ArcGIS)
 *
 * Results are saved into the ./geo_data/ folder.
 */

const axios = require("axios");
const fs = require("fs");
const path = require("path");

const GEO_DATA_DIR = path.join(__dirname, "geo_data");

// Miami-Dade Open Data — CRA / TIF Districts (GeoJSON endpoint)
const SOURCES = [
  {
    name: "miami_dade_cra_tif_zones",
    url: "https://services.arcgis.com/8Pc9XBTAsYuxx9Ny/arcgis/rest/services/CommunityRedevelopmentArea_gdb/FeatureServer/0/query?where=1%3D1&outFields=*&outSR=4326&f=geojson",
    fallbackUrl:
      "https://gis-mdc.opendata.arcgis.com/api/v3/datasets/community-redevelopment-area/downloads/data?format=geojson&spatialRefId=4326",
    description: "Miami-Dade County Community Redevelopment Areas (TIF zones)",
  },
  {
    name: "opportunity_zones",
    url: "https://services.arcgis.com/8Pc9XBTAsYuxx9Ny/arcgis/rest/services/QualifiedOpportunityZones_gdb/FeatureServer/0/query?where=1%3D1&outFields=*&outSR=4326&f=geojson",
    fallbackUrl:
      "https://services.arcgis.com/VTyQ9soqVukalItT/arcgis/rest/services/Opportunity_Zones/FeatureServer/13/query?where=STATE%3D%2712%27+AND+COUNTY%3D%27086%27&outFields=*&outSR=4326&f=geojson",
    description: "Opportunity Zones — Miami-Dade County (Census Tracts)",
  },
];

async function fetchSource(source) {
  console.log(`\n=> Fetching: ${source.description}`);
  console.log(`   URL: ${source.url}`);

  try {
    const res = await axios.get(source.url, { timeout: 30000 });
    return res.data;
  } catch (err) {
    console.warn(`   Primary URL failed (${err.message}). Trying fallback...`);
    try {
      const res = await axios.get(source.fallbackUrl, { timeout: 30000 });
      return res.data;
    } catch (err2) {
      console.error(`   Fallback also failed (${err2.message}).`);
      return null;
    }
  }
}

async function main() {
  console.log("=== TIPOZMAPS — GeoJSON Zone Fetcher ===");
  console.log(`Output directory: ${GEO_DATA_DIR}\n`);

  if (!fs.existsSync(GEO_DATA_DIR)) {
    fs.mkdirSync(GEO_DATA_DIR, { recursive: true });
    console.log("Created geo_data/ directory.");
  }

  let successCount = 0;

  for (const source of SOURCES) {
    const data = await fetchSource(source);

    if (data) {
      const outFile = path.join(GEO_DATA_DIR, `${source.name}.geojson`);
      fs.writeFileSync(outFile, JSON.stringify(data, null, 2), "utf-8");

      const features = data.features ? data.features.length : "unknown";
      console.log(`   Saved ${outFile} (${features} features)`);
      successCount++;
    } else {
      // Write a placeholder so downstream steps know this source was attempted
      const placeholder = {
        type: "FeatureCollection",
        features: [],
        _meta: {
          source: source.name,
          description: source.description,
          status: "fetch_failed",
          attempted_at: new Date().toISOString(),
          primary_url: source.url,
          fallback_url: source.fallbackUrl,
        },
      };
      const outFile = path.join(GEO_DATA_DIR, `${source.name}.geojson`);
      fs.writeFileSync(outFile, JSON.stringify(placeholder, null, 2), "utf-8");
      console.log(`   Wrote empty placeholder to ${outFile}`);
    }
  }

  console.log(`\n=== Done. ${successCount}/${SOURCES.length} sources fetched successfully. ===`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
