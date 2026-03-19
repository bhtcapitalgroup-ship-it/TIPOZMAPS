#!/usr/bin/env node
/**
 * deal_sniper.js — Single-Property Deal Sniper
 *
 * Look up any property by address, pull its zone data, score it,
 * evaluate conversion feasibility, and generate direct verification
 * links to the county Tax Collector and Property Appraiser portals.
 *
 * Usage: node deal_sniper.js "19501 BISCAYNE BLVD"
 */

const fs = require("fs");
const path = require("path");
const { loadZones, matchProperty } = require("./property_matcher");
const { classifyDorCode } = require("./miami_public_data");
const { scoreProperty } = require("./distress_analyzer");
const { evaluateConversion } = require("./conversion_evaluator");

const PROSPECTS_PATH = path.join(__dirname, "output", "raw_massive_prospects.json");
const OUTPUT_DIR = path.join(__dirname, "output");

// Direct portal URLs using Folio number
const TAX_COLLECTOR_URL = (folio) =>
  `https://miamidade.county-taxes.com/public/real_estate/parcels/${folio}`;
const PROPERTY_APPRAISER_URL = (folio) =>
  `https://www.miamidade.gov/Apps/PA/propertysearch/#/?folio=${folio}`;

// ---------------------------------------------------------------------------
// Find property by address in the prospects dataset
// ---------------------------------------------------------------------------

function findByAddress(address, prospects) {
  const needle = address.toUpperCase().replace(/[^A-Z0-9]/g, "");

  // Exact match first
  let match = prospects.find((p) => {
    const hay = (p.address || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    return hay === needle;
  });

  // Fuzzy: check if needle is contained in address
  if (!match) {
    match = prospects.find((p) => {
      const hay = (p.address || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
      return hay.includes(needle) || needle.includes(hay);
    });
  }

  return match;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const searchAddress = process.argv[2];

  if (!searchAddress) {
    console.error("Usage: node deal_sniper.js \"<ADDRESS>\"");
    console.error('Example: node deal_sniper.js "19501 BISCAYNE BLVD"');
    process.exit(1);
  }

  console.log("================================================================");
  console.log("  TIPOZMAPS — Deal Sniper");
  console.log("================================================================\n");
  console.log(`Searching for: "${searchAddress}"\n`);

  // Load prospects
  const prospects = JSON.parse(fs.readFileSync(PROSPECTS_PATH, "utf-8"));
  const property = findByAddress(searchAddress, prospects);

  if (!property) {
    console.error(`[ERROR] Property "${searchAddress}" not found in ${prospects.length} prospects.`);
    console.error("Make sure the address matches a record in raw_massive_prospects.json");
    process.exit(1);
  }

  const folio = property.folio;
  console.log(`[FOUND] ${property.address} (Folio: ${folio})\n`);

  // Step 1: Zone match
  console.log("[1/3] Zone Matching...");
  const zones = loadZones();
  const zoneMatched = matchProperty(property, zones);
  const zoneFlags = [];
  if (zoneMatched.insideCRA) zoneFlags.push(`CRA: ${zoneMatched.zones.cra.name.trim()}`);
  if (zoneMatched.insideOZ) zoneFlags.push(`OZ: Tract ${zoneMatched.zones.opportunityZone.tract}`);
  console.log(`   Zones: ${zoneFlags.length > 0 ? zoneFlags.join(" + ") : "None"}\n`);

  // Step 2: Distress scoring (out-of-state only; tax checked manually via link)
  console.log("[2/3] Distress Scoring...");
  const ownerMailingState = (zoneMatched.ownerMailingState || "").trim().toUpperCase();
  const outOfStateOwner = ownerMailingState !== "" && ownerMailingState !== "FL";
  const dorCode = zoneMatched.dorCode || "";

  const enriched = {
    ...zoneMatched,
    publicRecords: {
      taxDelinquent: false, // verify manually via link below
      taxDue: 0,
      codeViolations: 0,
      outOfStateOwner,
    },
    physicalAttributes: {
      propertyUse: classifyDorCode(dorCode),
      propertyUseRaw: `${dorCode} - ${zoneMatched.dorDescription || ""}`,
      buildingSqFt: zoneMatched.buildingSqFt || 0,
    },
  };

  const scored = scoreProperty(enriched);
  console.log(`   Score: ${scored.distressScore}/6  [${scored.sellerTier}]`);
  if (scored.distressSignals.length) console.log(`   Signals: ${scored.distressSignals.join(", ")}`);
  console.log(`   (Tax delinquency not included — verify via link below)\n`);

  // Step 3: Conversion feasibility
  console.log("[3/3] Conversion Feasibility...");
  const evaluated = evaluateConversion(scored);
  const ca = evaluated.conversionAnalysis;
  console.log(`   ${ca.feasible ? "FEASIBLE" : "NOT FEASIBLE"}: ${ca.reasons.join("; ")}`);
  if (ca.feasible) console.log(`   Potential: ~${ca.potentialUnits} units (Tier ${ca.conversionTier})`);
  console.log();

  // Generate verification links
  const taxCollectorLink = TAX_COLLECTOR_URL(folio);
  const propertyAppraiserLink = PROPERTY_APPRAISER_URL(folio);
  const googleMapsLink = `https://www.google.com/maps/search/?api=1&query=${evaluated.lat},${evaluated.lng}`;

  // Print Executive Tear Sheet
  console.log("┌──────────────────────────────────────────────────────────────┐");
  console.log("│              EXECUTIVE DEAL TEAR SHEET                       │");
  console.log("│              BHT Capital Group — Deal Sniper                 │");
  console.log("├──────────────────────────────────────────────────────────────┤");
  console.log("│  PROPERTY                                                    │");
  console.log("├──────────────────────────────────────────────────────────────┤");
  console.log(`│  Address:         ${evaluated.address}`);
  console.log(`│  Folio:           ${folio}`);
  console.log(`│  Owner:           ${evaluated.owner} (${evaluated.ownerMailingState})`);
  console.log(`│  Building:        ${(evaluated.buildingSqFt || 0).toLocaleString()} sq ft`);
  console.log(`│  Type:            ${evaluated.dorDescription}`);
  console.log(`│  Year Built:      ${evaluated.yearBuilt || "N/A"}`);
  console.log("├──────────────────────────────────────────────────────────────┤");
  console.log("│  ZONE OVERLAY                                                │");
  console.log("├──────────────────────────────────────────────────────────────┤");
  if (zoneMatched.insideCRA) {
    console.log(`│  CRA/TIF Zone:    ${zoneMatched.zones.cra.name.trim()} (${zoneMatched.zones.cra.acres} acres)`);
  }
  if (zoneMatched.insideOZ) {
    console.log(`│  Opportunity Zone: Tract ${zoneMatched.zones.opportunityZone.tract} (GEOID: ${zoneMatched.zones.opportunityZone.geoid})`);
  }
  if (!zoneMatched.insideCRA && !zoneMatched.insideOZ) {
    console.log("│  No incentive zones detected");
  }
  console.log("├──────────────────────────────────────────────────────────────┤");
  console.log("│  DISTRESS INDICATORS                                         │");
  console.log("├──────────────────────────────────────────────────────────────┤");
  console.log(`│  Out-of-State Owner:  ${outOfStateOwner ? "YES (" + ownerMailingState + ")" : "No (FL)"}`);
  console.log(`│  Tax Delinquent:      Verify via link below`);
  console.log(`│  DISTRESS SCORE:      ${scored.distressScore}/6  [${scored.sellerTier}]`);
  console.log(`│  (Add +3 if tax delinquent per manual check)`);
  console.log("├──────────────────────────────────────────────────────────────┤");
  console.log("│  CONVERSION FEASIBILITY                                      │");
  console.log("├──────────────────────────────────────────────────────────────┤");
  console.log(`│  Status:           ${ca.feasible ? "FEASIBLE" : "NOT FEASIBLE"}`);
  if (ca.feasible) {
    console.log(`│  Use:              ${ca.propertyUse} (Tier ${ca.conversionTier}, ${Math.round(ca.efficiency * 100)}% efficiency)`);
    console.log(`│  Potential Units:  ~${ca.potentialUnits} (target: ${ca.targetUnits})`);
    console.log(`│  Min Sq Ft:        ${ca.minRequired.toLocaleString()} sq ft`);
  } else {
    console.log(`│  Reason:           ${ca.reasons.join("; ")}`);
  }
  console.log("├──────────────────────────────────────────────────────────────┤");
  console.log("│  MANUAL VERIFICATION LINKS                                   │");
  console.log("├──────────────────────────────────────────────────────────────┤");
  console.log(`│  Tax Collector:    ${taxCollectorLink}`);
  console.log(`│  Prop. Appraiser:  ${propertyAppraiserLink}`);
  console.log(`│  Google Maps:      ${googleMapsLink}`);
  console.log("└──────────────────────────────────────────────────────────────┘");
  console.log();

  // Save report with links
  const report = {
    ...evaluated,
    verificationLinks: {
      taxCollector: taxCollectorLink,
      propertyAppraiser: propertyAppraiserLink,
      googleMaps: googleMapsLink,
    },
    generatedAt: new Date().toISOString(),
  };

  const reportPath = path.join(OUTPUT_DIR, `sniper_${folio}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf-8");
  console.log(`Report saved to ${reportPath}`);
}

main();
