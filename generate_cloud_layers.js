#!/usr/bin/env node
/**
 * generate_cloud_layers.js — KML Layer Generator for Google My Maps
 *
 * Produces 3 KML files ready for import:
 *   Layer 1: CRA/TIF Zone boundaries (Blue polygons)
 *   Layer 2: Opportunity Zone boundaries (Green polygons)
 *   Layer 3: Target lead pins with distress data in description
 */

const fs = require("fs");
const path = require("path");

const GEO_DIR = path.join(__dirname, "geo_data");
const OUTPUT_DIR = path.join(__dirname, "output");

// KML color format: aaBBGGRR (alpha, blue, green, red)
const BLUE_FILL = "7f1a9641";      // semi-transparent blue
const BLUE_OUTLINE = "ff1a9641";    // solid blue
const GREEN_FILL = "7f14b414";      // semi-transparent green
const GREEN_OUTLINE = "ff14b414";   // solid green

// Pin colors by distress score
const PIN_RED = "http://maps.google.com/mapfiles/kml/paddle/red-stars.png";
const PIN_YELLOW = "http://maps.google.com/mapfiles/kml/paddle/ylw-stars.png";

// ---------------------------------------------------------------------------
// KML helpers
// ---------------------------------------------------------------------------

function xmlEscape(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function kmlHeader(docName) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
<Document>
  <name>${xmlEscape(docName)}</name>`;
}

function kmlFooter() {
  return `</Document>
</kml>`;
}

function polygonStyle(id, fillColor, outlineColor) {
  return `
  <Style id="${id}">
    <LineStyle>
      <color>${outlineColor}</color>
      <width>2</width>
    </LineStyle>
    <PolyStyle>
      <color>${fillColor}</color>
    </PolyStyle>
  </Style>`;
}

function pinStyle(id, iconUrl) {
  return `
  <Style id="${id}">
    <IconStyle>
      <Icon><href>${iconUrl}</href></Icon>
      <scale>1.1</scale>
    </IconStyle>
  </Style>`;
}

// ---------------------------------------------------------------------------
// GeoJSON polygon ring -> KML coordinate string
// ---------------------------------------------------------------------------

function ringToKMLCoords(ring) {
  return ring.map(([lng, lat]) => `${lng},${lat},0`).join(" ");
}

function geojsonPolygonToKML(geometry) {
  if (geometry.type === "Polygon") {
    const outer = ringToKMLCoords(geometry.coordinates[0]);
    let kml = `<Polygon><outerBoundaryIs><LinearRing><coordinates>${outer}</coordinates></LinearRing></outerBoundaryIs>`;
    for (let i = 1; i < geometry.coordinates.length; i++) {
      const inner = ringToKMLCoords(geometry.coordinates[i]);
      kml += `<innerBoundaryIs><LinearRing><coordinates>${inner}</coordinates></LinearRing></innerBoundaryIs>`;
    }
    kml += `</Polygon>`;
    return kml;
  }
  if (geometry.type === "MultiPolygon") {
    const parts = geometry.coordinates.map((poly) => {
      const outer = ringToKMLCoords(poly[0]);
      let kml = `<Polygon><outerBoundaryIs><LinearRing><coordinates>${outer}</coordinates></LinearRing></outerBoundaryIs>`;
      for (let i = 1; i < poly.length; i++) {
        const inner = ringToKMLCoords(poly[i]);
        kml += `<innerBoundaryIs><LinearRing><coordinates>${inner}</coordinates></LinearRing></innerBoundaryIs>`;
      }
      kml += `</Polygon>`;
      return kml;
    });
    return `<MultiGeometry>${parts.join("")}</MultiGeometry>`;
  }
  return "";
}

// ---------------------------------------------------------------------------
// Layer 1: CRA Zones (Blue)
// ---------------------------------------------------------------------------

function generateCRALayer() {
  const geojson = JSON.parse(
    fs.readFileSync(path.join(GEO_DIR, "miami_dade_cra_tif_zones.geojson"), "utf-8")
  );

  let kml = kmlHeader("Layer 1 — CRA / TIF Zones");
  kml += polygonStyle("blueZone", BLUE_FILL, BLUE_OUTLINE);

  for (const feature of geojson.features) {
    const name = feature.properties.LOCATION || "CRA Zone";
    const acres = feature.properties.ACRE || "N/A";
    kml += `
  <Placemark>
    <name>${xmlEscape(name)}</name>
    <description>Community Redevelopment Area (TIF District)\nAcres: ${acres}</description>
    <styleUrl>#blueZone</styleUrl>
    ${geojsonPolygonToKML(feature.geometry)}
  </Placemark>`;
  }

  kml += "\n" + kmlFooter();
  return kml;
}

// ---------------------------------------------------------------------------
// Layer 2: Opportunity Zones (Green)
// ---------------------------------------------------------------------------

function generateOZLayer() {
  const geojson = JSON.parse(
    fs.readFileSync(path.join(GEO_DIR, "opportunity_zones.geojson"), "utf-8")
  );

  let kml = kmlHeader("Layer 2 — Opportunity Zones");
  kml += polygonStyle("greenZone", GREEN_FILL, GREEN_OUTLINE);

  for (const feature of geojson.features) {
    const tract = feature.properties.NAME10 || "N/A";
    const geoid = feature.properties.GEOID10 || "N/A";
    kml += `
  <Placemark>
    <name>OZ Tract ${xmlEscape(tract)}</name>
    <description>Qualified Opportunity Zone\nGEOID: ${xmlEscape(geoid)}\nTract: ${xmlEscape(tract)}</description>
    <styleUrl>#greenZone</styleUrl>
    ${geojsonPolygonToKML(feature.geometry)}
  </Placemark>`;
  }

  kml += "\n" + kmlFooter();
  return kml;
}

// ---------------------------------------------------------------------------
// Layer 3: Target Lead Pins
// ---------------------------------------------------------------------------

function generateTargetLayer() {
  const data = JSON.parse(
    fs.readFileSync(path.join(OUTPUT_DIR, "massive_unicorns.json"), "utf-8")
  );

  // Sort highest distress first
  data.sort((a, b) => b.distressScore - a.distressScore || b.buildingSqFt - a.buildingSqFt);

  let kml = kmlHeader("Layer 3 — Target Acquisition Leads");
  kml += pinStyle("pinHigh", PIN_RED);
  kml += pinStyle("pinMed", PIN_YELLOW);

  for (const p of data) {
    if (!p.lat || !p.lng) continue;

    const addr = p.address || "N/A";
    const sqft = (p.buildingSqFt || 0).toLocaleString();
    const propType = p.dorDescription ? p.dorDescription.split(" : ")[0] : "N/A";
    const ownerState = p.ownerMailingState || "N/A";
    const score = p.distressScore || 0;
    const taxStr = p.taxStatus && p.taxStatus.taxDelinquent
      ? `Delinquent ($${(p.taxStatus.taxDue || 0).toLocaleString()})`
      : "Current";

    const zoneFlags = [];
    if (p.insideCRA) zoneFlags.push("CRA: " + p.zones.cra.name.trim());
    if (p.insideOZ) zoneFlags.push("OZ: " + p.zones.opportunityZone.tract);

    const desc = [
      `Building: ${sqft} sq ft`,
      `Type: ${propType}`,
      `Owner: ${p.owner || "N/A"} (${ownerState})`,
      `Tax: ${taxStr}`,
      `Zones: ${zoneFlags.join(" + ")}`,
      `Distress Score: ${score}/6`,
    ].join("\n");

    const styleRef = score >= 4 ? "#pinHigh" : "#pinMed";

    kml += `
  <Placemark>
    <name>${xmlEscape(addr)}</name>
    <description>${xmlEscape(desc)}</description>
    <styleUrl>${styleRef}</styleUrl>
    <Point>
      <coordinates>${p.lng},${p.lat},0</coordinates>
    </Point>
  </Placemark>`;
  }

  kml += "\n" + kmlFooter();
  return kml;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  console.log("=== TIPOZMAPS — KML Layer Generator for Google My Maps ===\n");

  // Layer 1: CRA
  const cra = generateCRALayer();
  const craPath = path.join(OUTPUT_DIR, "layer_1_CRA_Zones.kml");
  fs.writeFileSync(craPath, cra, "utf-8");
  console.log(`Layer 1: CRA Zones (Blue)       -> ${craPath} (${(Buffer.byteLength(cra) / 1024).toFixed(0)} KB)`);

  // Layer 2: OZ
  const oz = generateOZLayer();
  const ozPath = path.join(OUTPUT_DIR, "layer_2_Opportunity_Zones.kml");
  fs.writeFileSync(ozPath, oz, "utf-8");
  console.log(`Layer 2: Opportunity Zones (Green) -> ${ozPath} (${(Buffer.byteLength(oz) / 1024).toFixed(0)} KB)`);

  // Layer 3: Targets
  const targets = generateTargetLayer();
  const targetsPath = path.join(OUTPUT_DIR, "layer_3_Target_Leads.kml");
  fs.writeFileSync(targetsPath, targets, "utf-8");

  // Count pins
  const data = JSON.parse(fs.readFileSync(path.join(OUTPUT_DIR, "massive_unicorns.json"), "utf-8"));
  const high = data.filter((p) => p.distressScore >= 4).length;
  const med = data.filter((p) => p.distressScore < 4).length;
  console.log(`Layer 3: Target Leads (${high} red + ${med} yellow pins) -> ${targetsPath} (${(Buffer.byteLength(targets) / 1024).toFixed(0)} KB)`);

  console.log("\n=== All 3 KML layers generated. ===");
  console.log("\nTo import into Google My Maps:");
  console.log("  1. Go to mymaps.google.com");
  console.log("  2. Create a new map");
  console.log("  3. Click 'Import' on each layer and upload the KML files");
  console.log("  4. Layer 1 (Blue) = CRA zones, Layer 2 (Green) = OZ zones, Layer 3 = Target pins");
}

main();
