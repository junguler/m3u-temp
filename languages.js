const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// Configuration
const LIBRIVOX_BASE_URL = 'https://librivox.org';
const RESULTS_PER_PAGE = 25;
const OUTPUT_DIR = './language_slugs';
const DELAY_MS = 500;
const PAGE_LOAD_TIMEOUT = 60000;
const SAVE_EVERY_N_PAGES = 5;

// Language data extracted from your HTML (excluding languages with 0 completed books)
const languages = [
  { name: "English", primaryKey: "1", completed: 41458 },
  { name: "French", primaryKey: "2", completed: 1038 },
  { name: "German", primaryKey: "3", completed: 3123 },
  { name: "Italian", primaryKey: "4", completed: 287 },
  { name: "Spanish", primaryKey: "5", completed: 954 },
  { name: "Acehnese", primaryKey: "80", completed: 1 },
  { name: "Afrikaans", primaryKey: "6", completed: 5 },
  { name: "Ancient Greek", primaryKey: "8", completed: 54 },
  { name: "Arabic", primaryKey: "9", completed: 29 },
  { name: "Assamese", primaryKey: "102", completed: 1 },
  { name: "Balinese", primaryKey: "81", completed: 1 },
  { name: "Belarusian", primaryKey: "67", completed: 1 },
  { name: "Bengali", primaryKey: "10", completed: 5 },
  { name: "Bisaya-Cebuano", primaryKey: "11", completed: 4 },
  { name: "Braj", primaryKey: "105", completed: 1 },
  { name: "Buginese", primaryKey: "82", completed: 1 },
  { name: "Bulgarian", primaryKey: "12", completed: 11 },
  { name: "Cantonese Chinese", primaryKey: "78", completed: 6 },
  { name: "Catalan", primaryKey: "13", completed: 35 },
  { name: "Chinese", primaryKey: "14", completed: 446 },
  { name: "Church Slavonic", primaryKey: "15", completed: 8 },
  { name: "Croatian", primaryKey: "68", completed: 5 },
  { name: "Czech", primaryKey: "16", completed: 7 },
  { name: "Danish", primaryKey: "17", completed: 22 },
  { name: "Dholuo-Luo", primaryKey: "18", completed: 1 },
  { name: "Dutch", primaryKey: "19", completed: 300 },
  { name: "Esperanto", primaryKey: "20", completed: 30 },
  { name: "Faroese", primaryKey: "70", completed: 1 },
  { name: "Finnish", primaryKey: "22", completed: 29 },
  { name: "Galician", primaryKey: "94", completed: 16 },
  { name: "Garo", primaryKey: "103", completed: 1 },
  { name: "Greek", primaryKey: "26", completed: 52 },
  { name: "Hebrew", primaryKey: "27", completed: 45 },
  { name: "Hindi", primaryKey: "72", completed: 23 },
  { name: "Hungarian", primaryKey: "28", completed: 27 },
  { name: "Indonesian", primaryKey: "31", completed: 7 },
  { name: "Irish", primaryKey: "33", completed: 4 },
  { name: "Japanese", primaryKey: "35", completed: 127 },
  { name: "Javanese", primaryKey: "36", completed: 25 },
  { name: "Kapampangan", primaryKey: "84", completed: 1 },
  { name: "Korean", primaryKey: "38", completed: 5 },
  { name: "Kurdish", primaryKey: "95", completed: 1 },
  { name: "Latin", primaryKey: "39", completed: 98 },
  { name: "Latvian", primaryKey: "40", completed: 5 },
  { name: "Lithuanian", primaryKey: "41", completed: 2 },
  { name: "Low German", primaryKey: "87", completed: 1 },
  { name: "Luxembourgish", primaryKey: "73", completed: 26 },
  { name: "Macedonian", primaryKey: "100", completed: 2 },
  { name: "Malay", primaryKey: "69", completed: 2 },
  { name: "Maltese", primaryKey: "42", completed: 1 },
  { name: "Maori", primaryKey: "91", completed: 2 },
  { name: "Marathi", primaryKey: "99", completed: 2 },
  { name: "Middle English", primaryKey: "44", completed: 8 },
  { name: "Minangkabau", primaryKey: "83", completed: 1 },
  { name: "Multilingual", primaryKey: "45", completed: 191 },
  { name: "Norwegian", primaryKey: "49", completed: 11 },
  { name: "Nynorsk", primaryKey: "74", completed: 1 },
  { name: "Occitan", primaryKey: "75", completed: 1 },
  { name: "Old English", primaryKey: "50", completed: 6 },
  { name: "Old Javanese", primaryKey: "79", completed: 5 },
  { name: "Old Norse", primaryKey: "85", completed: 1 },
  { name: "Old Sundanese", primaryKey: "86", completed: 1 },
  { name: "Old Tupi", primaryKey: "97", completed: 1 },
  { name: "Oriya", primaryKey: "76", completed: 1 },
  { name: "Palatine German", primaryKey: "101", completed: 1 },
  { name: "Persian-Farsi", primaryKey: "21", completed: 6 },
  { name: "Polish", primaryKey: "51", completed: 138 },
  { name: "Portuguese", primaryKey: "52", completed: 303 },
  { name: "Rajasthani", primaryKey: "104", completed: 1 },
  { name: "Romanian", primaryKey: "53", completed: 76 },
  { name: "Russian", primaryKey: "54", completed: 159 },
  { name: "Sanskrit", primaryKey: "55", completed: 1 },
  { name: "Scottish Gaelic", primaryKey: "96", completed: 1 },
  { name: "Serbian", primaryKey: "56", completed: 2 },
  { name: "Slovak", primaryKey: "57", completed: 2 },
  { name: "Slovenian", primaryKey: "90", completed: 5 },
  { name: "Sundanese", primaryKey: "77", completed: 1 },
  { name: "Swedish", primaryKey: "58", completed: 34 },
  { name: "Tagalog", primaryKey: "59", completed: 20 },
  { name: "Tamil", primaryKey: "60", completed: 7 },
  { name: "Telugu", primaryKey: "92", completed: 1 },
  { name: "Turkish", primaryKey: "61", completed: 5 },
  { name: "Ukrainian", primaryKey: "62", completed: 40 },
  { name: "Urdu", primaryKey: "63", completed: 2 },
  { name: "Volapuk", primaryKey: "89", completed: 1 },
  { name: "Welsh", primaryKey: "64", completed: 2 },
  { name: "Western Frisian", primaryKey: "71", completed: 1 },
  { name: "Yiddish", primaryKey: "65", completed: 21 }
];

// Create output directory if it doesn't exist
if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

// Sanitize filename for saving
function sanitizeFilename(name) {
  return name
    .replace(/[<>:"/\\|?*]/g, '-')
    .replace(/\s+/g, '_')
    .replace(/-+/g, '-')
    .replace(/_-_/g, '-')
    .substring(0, 200);
}

// Sleep function for rate limiting
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Get current timestamp for logging
function getTimestamp() {
  return new Date().toLocaleTimeString();
}

// Save slugs to file
function saveSlugsToFile(filepath, slugs) {
  const slugArray = Array.from(slugs).sort();
  fs.writeFileSync(filepath, slugArray.join('\n'), 'utf8');
  return slugArray.length;
}

// Extract slugs from page content - EXCLUDES AUTHOR LINKS
function extractSlugsFromPage(page) {
  return page.evaluate(() => {
    const slugs = new Set();

    // Patterns to exclude - including 'author'
    const excludePatterns = [
      'search', 'api', 'pages', 'about', 'volunteer',
      'forum', 'catalog', 'rss', 'login', 'register',
      'privacy', 'terms', 'contact', 'help', 'faq',
      'reader', 'author', 'group', 'genre', 'language',
      'title', 'new-titles', 'completed', 'in-progress'
    ];

    // Words that should NOT appear anywhere in the slug
    const excludeContains = [
      'author'
    ];

    // Function to check if slug should be excluded
    function shouldExclude(slug) {
      const lowerSlug = slug.toLowerCase();

      // Check exact matches and prefix matches
      for (const pattern of excludePatterns) {
        if (lowerSlug === pattern || lowerSlug.startsWith(pattern + '-')) {
          return true;
        }
      }

      // Check if slug contains any excluded words
      for (const word of excludeContains) {
        if (lowerSlug.includes(word)) {
          return true;
        }
      }

      return false;
    }

    document.querySelectorAll('a[href]').forEach(link => {
      const href = link.getAttribute('href');
      if (!href) return;

      // Skip if href contains 'author'
      if (href.toLowerCase().includes('author')) {
        return;
      }

      let slug = null;

      const fullUrlMatch = href.match(/librivox\.org\/([a-z0-9-]+)\/?$/i);
      if (fullUrlMatch) {
        slug = fullUrlMatch[1];
      }

      const relativeMatch = href.match(/^\/([a-z0-9-]+)\/?$/i);
      if (relativeMatch) {
        slug = relativeMatch[1];
      }

      if (slug && !shouldExclude(slug) && slug.length > 2 && !slug.startsWith('?')) {
        slugs.add(slug);
      }
    });

    document.querySelectorAll('.catalog-result a, .result-data a, .book-result a, h3 a').forEach(link => {
      const href = link.getAttribute('href');
      if (!href) return;

      // Skip if href contains 'author'
      if (href.toLowerCase().includes('author')) {
        return;
      }

      const parts = href.split('/').filter(Boolean);
      const lastPart = parts[parts.length - 1];

      if (lastPart &&
        !lastPart.includes('?') &&
        !lastPart.includes('=') &&
        lastPart.length > 2 &&
        /^[a-z0-9-]+$/i.test(lastPart) &&
        !shouldExclude(lastPart)) {
        slugs.add(lastPart);
      }
    });

    return Array.from(slugs);
  });
}

// Scrape a single page of a language
async function scrapeLanguagePage(page, primaryKey, pageNum, retries = 3) {
  // Note: search_category=language instead of genre
  const url = `${LIBRIVOX_BASE_URL}/search?primary_key=${primaryKey}&search_category=language&search_page=${pageNum}&search_form=get_results`;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await page.goto(url, {
        waitUntil: 'networkidle',
        timeout: PAGE_LOAD_TIMEOUT
      });

      await page.waitForSelector('.catalog-result, .book-result, .search-results, .results-list', {
        timeout: 10000
      }).catch(() => {
        return page.waitForTimeout(3000);
      });

      await page.waitForTimeout(1500);

      const slugs = await extractSlugsFromPage(page);
      return slugs;

    } catch (error) {
      console.error(`\n      ⚠ Attempt ${attempt}/${retries} failed: ${error.message}`);
      if (attempt === retries) {
        return [];
      }
      await sleep(2000 * attempt);
    }
  }
  return [];
}

// Scrape all pages for a language with periodic saving
async function scrapeLanguage(browser, language, index, total) {
  const totalPages = Math.ceil(language.completed / RESULTS_PER_PAGE);
  const filename = sanitizeFilename(language.name) + '.txt';
  const filepath = path.join(OUTPUT_DIR, filename);

  console.log(`\n${'='.repeat(60)}`);
  console.log(`[${index + 1}/${total}] ${language.name}`);
  console.log(`  Expected: ${language.completed} books | Pages: ${totalPages} | Key: ${language.primaryKey}`);
  console.log(`  Output: ${filename}`);
  console.log(`  Started at: ${getTimestamp()}`);
  console.log(`  Note: Excluding all 'author' links`);
  console.log('='.repeat(60));

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 }
  });

  const page = await context.newPage();
  const allSlugs = new Set();
  let lastSaveCount = 0;

  try {
    for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
      process.stdout.write(`  [${getTimestamp()}] Page ${pageNum}/${totalPages}...`);

      const slugs = await scrapeLanguagePage(page, language.primaryKey, pageNum);
      slugs.forEach(slug => allSlugs.add(slug));

      const newSlugsThisPage = slugs.length;
      console.log(` +${newSlugsThisPage} slugs (Total: ${allSlugs.size})`);

      // Save every N pages
      if (pageNum % SAVE_EVERY_N_PAGES === 0) {
        const savedCount = saveSlugsToFile(filepath, allSlugs);
        const newSinceLastSave = savedCount - lastSaveCount;
        console.log(`  💾 [${getTimestamp()}] SAVED: ${savedCount} slugs to file (+${newSinceLastSave} new since last save)`);
        lastSaveCount = savedCount;
      }

      // Rate limiting between pages
      if (pageNum < totalPages) {
        await sleep(DELAY_MS);
      }
    }

    // Final save
    const finalCount = saveSlugsToFile(filepath, allSlugs);
    console.log(`\n  ✅ [${getTimestamp()}] FINAL SAVE: ${finalCount} unique slugs to ${filename}`);

  } catch (error) {
    // Emergency save on error
    if (allSlugs.size > 0) {
      const emergencyCount = saveSlugsToFile(filepath, allSlugs);
      console.log(`\n  🚨 [${getTimestamp()}] EMERGENCY SAVE: ${emergencyCount} slugs saved before error`);
    }
    throw error;
  } finally {
    await context.close();
  }

  return {
    language: language.name,
    primaryKey: language.primaryKey,
    expected: language.completed,
    found: allSlugs.size,
    file: filename
  };
}

// Load progress from previous run
function loadProgress() {
  const progressFile = path.join(OUTPUT_DIR, '_progress.json');
  if (fs.existsSync(progressFile)) {
    try {
      return JSON.parse(fs.readFileSync(progressFile, 'utf8'));
    } catch (e) {
      return { completedLanguages: [], results: [] };
    }
  }
  return { completedLanguages: [], results: [] };
}

// Save progress
function saveProgress(progress) {
  const progressFile = path.join(OUTPUT_DIR, '_progress.json');
  fs.writeFileSync(progressFile, JSON.stringify(progress, null, 2), 'utf8');
}

// Save live stats
function saveLiveStats(stats) {
  const statsFile = path.join(OUTPUT_DIR, '_live_stats.json');
  fs.writeFileSync(statsFile, JSON.stringify(stats, null, 2), 'utf8');
}

// Main function
async function main() {
  console.log('='.repeat(60));
  console.log('LibriVox LANGUAGE Scraper (Playwright)');
  console.log('='.repeat(60));
  console.log(`Total languages to scrape: ${languages.length}`);
  console.log(`Output directory: ${OUTPUT_DIR}`);
  console.log(`Delay between requests: ${DELAY_MS}ms`);
  console.log(`Saving progress every: ${SAVE_EVERY_N_PAGES} pages`);
  console.log(`Excluding: Links containing 'author'`);
  console.log('='.repeat(60));

  // Calculate total expected books
  const totalExpectedBooks = languages.reduce((sum, lang) => sum + lang.completed, 0);
  console.log(`Total expected books across all languages: ${totalExpectedBooks.toLocaleString()}`);
  console.log('='.repeat(60));

  // Load previous progress
  const progress = loadProgress();
  console.log(`Previously completed: ${progress.completedLanguages.length} languages`);

  // Launch browser
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--disable-gpu'
    ]
  });

  const startTime = Date.now();
  let totalSlugsCollected = 0;

  try {
    for (let i = 0; i < languages.length; i++) {
      const language = languages[i];

      // Skip if already completed
      if (progress.completedLanguages.includes(language.primaryKey)) {
        console.log(`\n[${i + 1}/${languages.length}] ${language.name} - SKIPPED (already completed)`);

        // Count existing slugs from file
        const filename = sanitizeFilename(language.name) + '.txt';
        const filepath = path.join(OUTPUT_DIR, filename);
        if (fs.existsSync(filepath)) {
          const existingSlugs = fs.readFileSync(filepath, 'utf8').split('\n').filter(s => s.trim()).length;
          totalSlugsCollected += existingSlugs;
        }
        continue;
      }

      try {
        const result = await scrapeLanguage(browser, language, i, languages.length);
        progress.results.push(result);
        totalSlugsCollected += result.found;

        // Save progress after each successful language
        progress.completedLanguages.push(language.primaryKey);
        saveProgress(progress);

        // Update live stats
        const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(2);
        saveLiveStats({
          lastUpdate: new Date().toISOString(),
          elapsedMinutes: elapsed,
          languagesCompleted: progress.completedLanguages.length,
          totalLanguages: languages.length,
          totalSlugsCollected: totalSlugsCollected,
          currentLanguage: language.name,
          excludingAuthorLinks: true,
          status: 'running'
        });

        // Add delay between languages
        if (i < languages.length - 1) {
          console.log(`\n  ⏳ Waiting ${DELAY_MS * 1.5 / 1000}s before next language...`);
          await sleep(DELAY_MS * 1.5);
        }
      } catch (error) {
        console.error(`\n  ❌ Error processing ${language.name}: ${error.message}`);
        progress.results.push({
          language: language.name,
          primaryKey: language.primaryKey,
          expected: language.completed,
          found: 0,
          file: null,
          error: error.message
        });
        saveProgress(progress);
      }
    }
  } finally {
    await browser.close();
  }

  const endTime = Date.now();
  const duration = ((endTime - startTime) / 1000 / 60).toFixed(2);

  // Save final summary
  console.log('\n' + '='.repeat(60));
  console.log('FINAL SUMMARY');
  console.log('='.repeat(60));

  const summary = {
    timestamp: new Date().toISOString(),
    duration: `${duration} minutes`,
    totalLanguages: languages.length,
    completedLanguages: progress.completedLanguages.length,
    totalSlugsCollected: totalSlugsCollected,
    excludedPatterns: ['author'],
    results: progress.results
  };

  fs.writeFileSync(
    path.join(OUTPUT_DIR, '_summary.json'),
    JSON.stringify(summary, null, 2),
    'utf8'
  );

  // Update live stats to complete
  saveLiveStats({
    lastUpdate: new Date().toISOString(),
    elapsedMinutes: duration,
    languagesCompleted: progress.completedLanguages.length,
    totalLanguages: languages.length,
    totalSlugsCollected: totalSlugsCollected,
    excludingAuthorLinks: true,
    status: 'completed'
  });

  console.log(`Completed in ${duration} minutes`);
  console.log(`Languages processed: ${progress.completedLanguages.length}/${languages.length}`);
  console.log(`Total slugs collected: ${totalSlugsCollected}`);
  console.log(`Author links: EXCLUDED`);
  console.log(`\nFiles saved to: ${OUTPUT_DIR}/`);
}

// Run the scraper
main().catch(error => {
  console.error('Fatal error:', error);

  // Save error state to live stats
  saveLiveStats({
    lastUpdate: new Date().toISOString(),
    status: 'error',
    error: error.message
  });

  process.exit(1);
});