/**
 * tax_collector_scraper.js — Tax Delinquency Scraper (ScraperAPI Edition)
 *
 * Routes requests through ScraperAPI's proxy to bypass Cloudflare/antibot
 * on the Miami-Dade Tax Collector portal. Uses Playwright with stealth
 * plugin + ScraperAPI proxy for full JS rendering.
 *
 * Portal: https://miamidade.county-taxes.com/public
 * Direct parcel URL: /public/real_estate/parcels/{FOLIO}
 *
 * NO MOCK DATA. If scraping fails, throws an error.
 */

const { chromium } = require("playwright-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const axios = require("axios");
const { sleep } = require("./miami_public_data");

// Apply stealth plugin
chromium.use(StealthPlugin());

// ScraperAPI credentials
const SCRAPER_API_KEY = "f3e593aa356a4f52aaf6d883aeb4c3a6";
const SCRAPER_API_PROXY = {
  server: "http://proxy-server.scraperapi.com:8001",
  username: "scraperapi",
  password: SCRAPER_API_KEY,
};

const BASE_URL = "https://miamidade.county-taxes.com/public";
const PARCEL_URL = (folio) => `${BASE_URL}/real_estate/parcels/${folio}`;

// ScraperAPI REST endpoint (fallback if proxy method fails)
const SCRAPER_API_REST = (targetUrl) =>
  `http://api.scraperapi.com/?api_key=${SCRAPER_API_KEY}&url=${encodeURIComponent(targetUrl)}&render=true&country_code=us`;

// Rate limit between requests (ms)
const REQUEST_DELAY = 4000;

// ---------------------------------------------------------------------------
// Browser lifecycle — Playwright via ScraperAPI proxy
// ---------------------------------------------------------------------------

let _browser = null;
let _context = null;

async function launchBrowser() {
  if (_browser) return _context;

  _browser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-blink-features=AutomationControlled",
    ],
  });

  _context = await _browser.newContext({
    proxy: SCRAPER_API_PROXY,
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 720 },
    locale: "en-US",
    ignoreHTTPSErrors: true,
  });

  return _context;
}

async function closeBrowser() {
  if (_browser) {
    await _browser.close();
    _browser = null;
    _context = null;
  }
}

// ---------------------------------------------------------------------------
// Tax data extraction from HTML text
// ---------------------------------------------------------------------------

function extractTaxFromText(text) {
  // Look for monetary amounts near keywords indicating tax due
  const patterns = [
    /total\s*due[:\s]*\$?([\d,]+\.?\d*)/i,
    /amount\s*due[:\s]*\$?([\d,]+\.?\d*)/i,
    /balance\s*due[:\s]*\$?([\d,]+\.?\d*)/i,
    /total\s*unpaid[:\s]*\$?([\d,]+\.?\d*)/i,
    /outstanding[:\s]*\$?([\d,]+\.?\d*)/i,
    /delinquent[:\s]*\$?([\d,]+\.?\d*)/i,
    /taxes\s*owed[:\s]*\$?([\d,]+\.?\d*)/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      const amount = parseFloat(match[1].replace(/,/g, ""));
      if (!isNaN(amount)) {
        return { taxDue: amount, matched: match[0] };
      }
    }
  }

  // Check if page indicates paid / no balance
  if (/no\s*(taxes?\s*)?due|paid\s*in\s*full|no\s*balance|0\.00\s*due/i.test(text)) {
    return { taxDue: 0, matched: "paid/no-balance indicator" };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Method 1: Playwright + ScraperAPI proxy
// ---------------------------------------------------------------------------

async function scrapeViaPlaywrightProxy(folio) {
  const context = await launchBrowser();
  const page = await context.newPage();

  const url = PARCEL_URL(folio);
  console.log(`   [Playwright+Proxy] Navigating to ${url}`);

  const response = await page.goto(url, {
    waitUntil: "domcontentloaded",
    timeout: 45000,
  });

  if (!response || response.status() >= 400) {
    await page.close();
    throw new Error(`HTTP ${response ? response.status() : "no response"} via proxy`);
  }

  // Wait for JS rendering
  await page.waitForTimeout(3000);

  const taxData = await page.evaluate(() => {
    const text = document.body.innerText || "";

    const patterns = [
      /total\s*due[:\s]*\$?([\d,]+\.?\d*)/i,
      /amount\s*due[:\s]*\$?([\d,]+\.?\d*)/i,
      /balance\s*due[:\s]*\$?([\d,]+\.?\d*)/i,
      /total\s*unpaid[:\s]*\$?([\d,]+\.?\d*)/i,
      /outstanding[:\s]*\$?([\d,]+\.?\d*)/i,
      /delinquent[:\s]*\$?([\d,]+\.?\d*)/i,
    ];

    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match) {
        const amount = parseFloat(match[1].replace(/,/g, ""));
        if (!isNaN(amount)) return { taxDue: amount, matched: match[0] };
      }
    }

    // Table cells
    const cells = document.querySelectorAll("td, span, div");
    for (const cell of cells) {
      const ct = cell.textContent.trim();
      if (/^\$[\d,]+\.\d{2}$/.test(ct)) {
        const parent = cell.closest("tr, .row, .line-item, dl");
        if (parent && /due|balance|owe|delinq|total/i.test(parent.textContent)) {
          const amount = parseFloat(ct.replace(/[$,]/g, ""));
          if (!isNaN(amount)) return { taxDue: amount, matched: `cell: ${ct}` };
        }
      }
    }

    if (/no\s*(taxes?\s*)?due|paid\s*in\s*full|no\s*balance|0\.00\s*due/i.test(text)) {
      return { taxDue: 0, matched: "paid/no-balance" };
    }

    // Return full page text for debugging if no match
    return { taxDue: null, matched: null, pageText: text.substring(0, 2000) };
  });

  await page.close();
  return taxData;
}

// ---------------------------------------------------------------------------
// Method 2: ScraperAPI REST (render=true) — fallback
// ---------------------------------------------------------------------------

async function scrapeViaRestAPI(folio) {
  const targetUrl = PARCEL_URL(folio);
  const apiUrl = SCRAPER_API_REST(targetUrl);

  console.log(`   [REST API] Fetching rendered page for folio ${folio}...`);

  const res = await axios.get(apiUrl, { timeout: 60000 });
  const html = res.data;

  // Extract text content from HTML
  const textContent = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ");

  return extractTaxFromText(textContent);
}

// ---------------------------------------------------------------------------
// Main check — tries proxy first, then REST API
// ---------------------------------------------------------------------------

async function checkTaxDelinquency(property) {
  const folio = (property.folio || "").replace(/[^0-9]/g, "");

  if (!folio) {
    throw new Error(`No folio number for property ${property.id}`);
  }

  // Method 1: Playwright + ScraperAPI proxy
  let taxData = null;
  try {
    taxData = await scrapeViaPlaywrightProxy(folio);
    if (taxData && taxData.taxDue !== null) {
      console.log(`   [OK] Extracted via Playwright proxy: $${taxData.taxDue.toLocaleString()} (${taxData.matched})`);
      return {
        taxDelinquent: taxData.taxDue > 0,
        taxDue: taxData.taxDue,
        source: "scraped-playwright-proxy",
      };
    }
    // If taxDue is null, log page snippet for debugging
    if (taxData && taxData.pageText) {
      console.log(`   [DEBUG] Page text snippet: ${taxData.pageText.substring(0, 300)}...`);
    }
    console.log(`   [WARN] Playwright proxy loaded page but could not extract tax amount. Trying REST API...`);
  } catch (err) {
    console.log(`   [WARN] Playwright proxy failed: ${err.message}. Trying REST API...`);
  }

  // Method 2: ScraperAPI REST endpoint with render=true
  try {
    taxData = await scrapeViaRestAPI(folio);
    if (taxData && taxData.taxDue !== null) {
      console.log(`   [OK] Extracted via REST API: $${taxData.taxDue.toLocaleString()} (${taxData.matched})`);
      return {
        taxDelinquent: taxData.taxDue > 0,
        taxDue: taxData.taxDue,
        source: "scraped-rest-api",
      };
    }
  } catch (err) {
    console.log(`   [WARN] REST API failed: ${err.message}`);
  }

  // Both methods failed — NO MOCK DATA, throw error
  throw new Error(
    `SCRAPE FAILED for folio ${folio}: Both Playwright proxy and REST API ` +
    `failed to extract tax data. The site may have changed its DOM structure ` +
    `or is blocking even proxied requests.`
  );
}

// ---------------------------------------------------------------------------
// Batch check with rate limiting
// ---------------------------------------------------------------------------

async function checkTaxDelinquencyBatch(properties) {
  const results = [];
  const errors = [];

  for (let i = 0; i < properties.length; i++) {
    const p = properties[i];
    console.log(`   [${i + 1}/${properties.length}] Checking tax status for folio ${p.folio || "N/A"}...`);

    try {
      const taxResult = await checkTaxDelinquency(p);
      results.push({
        ...p,
        taxStatus: taxResult,
        publicRecords: {
          ...(p.publicRecords || {}),
          taxDelinquent: taxResult.taxDelinquent,
          taxDue: taxResult.taxDue,
        },
      });
    } catch (err) {
      console.error(`   [ERROR] ${err.message}`);
      errors.push({ property: p, error: err.message });
      // Still add property but with error status so pipeline can continue
      results.push({
        ...p,
        taxStatus: { taxDelinquent: false, taxDue: 0, source: "error", error: err.message },
        publicRecords: {
          ...(p.publicRecords || {}),
          taxDelinquent: false,
          taxDue: 0,
        },
      });
    }

    // Rate limit between requests
    if (i < properties.length - 1) {
      console.log(`   ... waiting ${REQUEST_DELAY / 1000}s (rate limit) ...`);
      await sleep(REQUEST_DELAY);
    }
  }

  // Clean up browser
  await closeBrowser();

  if (errors.length > 0) {
    console.log(`\n   [SUMMARY] ${errors.length}/${properties.length} properties failed to scrape.`);
  }

  return results;
}

// ---------------------------------------------------------------------------
// Standalone CLI
// ---------------------------------------------------------------------------

async function main() {
  const fs = require("fs");
  const path = require("path");

  console.log("=== TIPOZMAPS — Tax Collector Scraper (ScraperAPI) ===\n");

  const inputPath = path.join(__dirname, "output", "raw_massive_prospects.json");
  const properties = JSON.parse(fs.readFileSync(inputPath, "utf-8")).slice(0, 3);
  console.log(`Testing with ${properties.length} properties.\n`);

  const results = await checkTaxDelinquencyBatch(properties);

  console.log("\n--- RESULTS ---\n");
  for (const r of results) {
    const status = r.taxStatus.taxDelinquent
      ? `DELINQUENT — $${r.taxStatus.taxDue.toLocaleString()} due`
      : `Current ($0 due)`;
    console.log(`[${r.id}] ${r.address}  |  Folio: ${r.folio}`);
    console.log(`     Tax Status: ${status}  (${r.taxStatus.source})`);
    console.log();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}

module.exports = { checkTaxDelinquency, checkTaxDelinquencyBatch, closeBrowser };
