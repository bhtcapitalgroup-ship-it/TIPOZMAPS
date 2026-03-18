/**
 * miami_public_data.js — Miami-Dade County Public Data Client
 *
 * Queries the free Miami-Dade County GIS ArcGIS REST API to enrich
 * property coordinates with real parcel data: building area, land use
 * (DOR code), and owner mailing state.
 *
 * Endpoint: MD_LandInformation MapServer, Layer 26 (Parcels @ PaParcel)
 * No API key required.
 */

const axios = require("axios");

const PARCEL_ENDPOINT =
  "https://gisweb.miamidade.gov/arcgis/rest/services/MD_LandInformation/MapServer/26/query";

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

// DOR code ranges that map to "Office" use
// 1700-1799 = Office buildings (one-story, multi-story, professional)
const OFFICE_DOR_RANGE = [17];
// Full DOR-to-category mapping for common commercial types
const DOR_CATEGORY_MAP = {
  11: "Retail/Stores",
  12: "Retail/Mixed",
  13: "Retail/Department Store",
  14: "Retail/Supermarket",
  16: "Retail/Community Shopping",
  17: "Office",
  18: "Retail/Eating/Drinking",
  19: "Retail/Financial",
  20: "Industrial",
  21: "Industrial/Light Mfg",
  22: "Industrial/Heavy Mfg",
  23: "Industrial/Lumber",
  27: "Industrial/Warehouse",
  28: "Industrial/Warehouse",
  29: "Industrial/Wholesale",
  30: "Industrial/Warehouse",
  33: "Nightclub/Bar",
  35: "Entertainment",
  38: "Parking",
  39: "Hotel/Motel",
  40: "Industrial/Vacant",
  41: "Industrial/Light Mfg",
  48: "Industrial/Warehouse",
  71: "Church",
  72: "School",
  73: "Hospital",
  86: "Government",
};

/**
 * Classify a DOR code string into a human-readable property use category.
 */
function classifyDorCode(dorCode) {
  if (!dorCode) return "Unknown";
  const prefix = parseInt(dorCode.substring(0, 2), 10);
  if (DOR_CATEGORY_MAP[prefix]) return DOR_CATEGORY_MAP[prefix];
  if (prefix >= 1 && prefix <= 9) return "Residential";
  if (prefix >= 10 && prefix <= 39) return "Commercial";
  if (prefix >= 40 && prefix <= 49) return "Industrial";
  if (prefix >= 50 && prefix <= 69) return "Agricultural";
  if (prefix >= 70 && prefix <= 79) return "Institutional";
  if (prefix >= 80 && prefix <= 89) return "Government";
  if (prefix >= 90) return "Miscellaneous";
  return "Unknown";
}

/**
 * Sleep helper for rate limiting.
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Query the Miami-Dade parcel layer by a lat/lng point.
 * Returns raw ArcGIS attributes or null on failure.
 */
async function queryParcelByPoint(lat, lng) {
  const params = {
    geometry: `${lng},${lat}`,
    geometryType: "esriGeometryPoint",
    inSR: 4326,
    spatialRel: "esriSpatialRelIntersects",
    outFields: TARGET_FIELDS,
    returnGeometry: false,
    f: "json",
  };

  const res = await axios.get(PARCEL_ENDPOINT, { params, timeout: 15000 });

  if (!res.data || !res.data.features || res.data.features.length === 0) {
    return null;
  }

  return res.data.features[0].attributes;
}

/**
 * Enrich a single property with real county parcel data.
 *
 * @param {Object} property - Must have { lat, lng }
 * @returns {Object} Property with `countyData` and `publicRecords` attached
 */
async function enrichWithCountyData(property) {
  let attrs = null;
  try {
    attrs = await queryParcelByPoint(property.lat, property.lng);
  } catch (err) {
    console.warn(`   [WARN] API query failed for property ${property.id}: ${err.message}`);
  }

  if (!attrs) {
    console.warn(`   [WARN] No parcel data found for property ${property.id} (${property.lat}, ${property.lng})`);
    return {
      ...property,
      countyData: null,
      publicRecords: {
        // TODO: Wire a separate Tax Collector scraper for tax delinquency data.
        // The Property Appraiser parcel endpoint does not include tax status.
        taxDelinquent: false,
        codeViolations: 0,
        outOfStateOwner: false,
      },
      physicalAttributes: {
        propertyUse: "Unknown",
        propertyUseRaw: null,
        buildingSqFt: 0,
      },
    };
  }

  const dorCode = attrs.DOR_CODE_CUR || "";
  const propertyUse = classifyDorCode(dorCode);
  const buildingSqFt = attrs.BUILDING_ACTUAL_AREA || attrs.BUILDING_HEATED_AREA || 0;
  const ownerMailingState = (attrs.TRUE_MAILING_STATE || "").trim().toUpperCase();
  const outOfStateOwner = ownerMailingState !== "" && ownerMailingState !== "FL";

  return {
    ...property,
    countyData: {
      folio: attrs.FOLIO,
      dorCode,
      dorDescription: attrs.DOR_DESC || "",
      buildingActualArea: attrs.BUILDING_ACTUAL_AREA,
      buildingHeatedArea: attrs.BUILDING_HEATED_AREA,
      ownerName: attrs.TRUE_OWNER1,
      siteAddress: attrs.TRUE_SITE_ADDR,
      ownerMailingState,
      yearBuilt: attrs.YEAR_BUILT,
    },
    publicRecords: {
      // TODO: Wire a separate Tax Collector scraper for tax delinquency data.
      // The Property Appraiser parcel endpoint does not include tax status.
      taxDelinquent: false,
      codeViolations: 0,
      outOfStateOwner,
    },
    physicalAttributes: {
      propertyUse,
      propertyUseRaw: `${dorCode} - ${attrs.DOR_DESC || ""}`,
      buildingSqFt,
    },
  };
}

/**
 * Enrich an array of properties with a 2-second delay between requests.
 */
async function enrichAll(properties) {
  const results = [];
  for (let i = 0; i < properties.length; i++) {
    const p = properties[i];
    console.log(`   [${i + 1}/${properties.length}] Querying parcel for property ${p.id} (${p.lat}, ${p.lng})...`);
    const enriched = await enrichWithCountyData(p);
    results.push(enriched);

    // Rate limit: 2 second delay between requests
    if (i < properties.length - 1) {
      console.log(`   ... waiting 2s (rate limit) ...`);
      await sleep(2000);
    }
  }
  return results;
}

module.exports = { enrichWithCountyData, enrichAll, classifyDorCode, sleep };
