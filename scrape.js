const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const BASE_URL = "https://www.radiobells.com";
const STATIONS_FILE = "stations.txt";
const DELAY_MS = 3000; // delay between requests to avoid detection

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

(async () => {
  // Read stations list
  const raw = fs.readFileSync(STATIONS_FILE, "utf-8");
  const stations = raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  console.log(`Found ${stations.length} stations to scrape`);

  // Launch browser with stealth-ish settings
  const browser = await chromium.launch({
    headless: true,
    args: [
      "--disable-blink-features=AutomationControlled",
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
    ],
  });

  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
    viewport: { width: 1920, height: 1080 },
    locale: "en-US",
    javaScriptEnabled: true,
  });

  // Remove the webdriver flag so the site can't detect automation
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", {
      get: () => undefined,
    });
  });

  const page = await context.newPage();

  // Track output files so we can optionally prepend #EXTM3U later
  const touchedFiles = new Set();

  for (const station of stations) {
    const url = `${BASE_URL}/${station}`;
    // Derive output filename: first path segment → A-<segment>.txt
    const group = station.split("/")[0];
    const outFile = `A-${group}.txt`;

    console.log(`Scraping: ${station}`);

    try {
      // Navigate and wait for full load
      await page.goto(url, {
        waitUntil: "networkidle",
        timeout: 30000,
      });

      // Wait a moment for any lazy JS to execute
      await sleep(1000);

      // --- Extract the first <h1> text ---
      let h1Text = "";
      try {
        const h1 = await page.locator("h1").first();
        h1Text = (await h1.innerText({ timeout: 5000 })).trim();
      } catch {
        console.warn(`  ⚠ No <h1> found for ${station}`);
      }

      // --- Extract var radio_link from page scripts ---
      let radioLink = "";
      try {
        // Try reading the global variable directly
        radioLink = await page.evaluate(() => {
          if (typeof radio_link !== "undefined") return radio_link;
          return "";
        });
      } catch {
        // Fallback: parse it from raw HTML
      }

      // Fallback: grep the page source for var radio_link = '...'
      if (!radioLink) {
        const html = await page.content();
        const match = html.match(/var\s+radio_link\s*=\s*'([^']+)'/);
        if (match) {
          radioLink = match[1];
        }
      }

      if (!h1Text && !radioLink) {
        console.warn(`  ⚠ Nothing extracted for ${station}, skipping`);
        await sleep(DELAY_MS);
        continue;
      }

      // --- Append to output file (same format as the bash script) ---
      let entry = "";
      if (h1Text) {
        entry += `#EXTINF:-1,${h1Text}\n`;
      }
      if (radioLink) {
        entry += `${radioLink}\n`;
      }

      fs.appendFileSync(outFile, entry, "utf-8");
      touchedFiles.add(outFile);

      console.log(`  ✔ h1: "${h1Text}"`);
      console.log(`  ✔ stream: ${radioLink || "(none)"}`);
      console.log(`  → written to ${outFile}`);
    } catch (err) {
      console.error(`  ✖ Error scraping ${station}: ${err.message}`);
    }

    // Polite delay between requests
    await sleep(DELAY_MS);
  }

  await browser.close();

  // Optionally prepend #EXTM3U header to each output file
  for (const file of touchedFiles) {
    const existing = fs.readFileSync(file, "utf-8");
    if (!existing.startsWith("#EXTM3U")) {
      fs.writeFileSync(file, `#EXTM3U\n${existing}`, "utf-8");
    }
  }

  console.log("\nDone. Output files:");
  for (const file of touchedFiles) {
    console.log(`  ${file}`);
  }
})();