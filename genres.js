const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// Configuration
const LIBRIVOX_BASE_URL = 'https://librivox.org';
const RESULTS_PER_PAGE = 25;
const OUTPUT_DIR = './genre_slugs';
const DELAY_MS = 500;
const PAGE_LOAD_TIMEOUT = 60000;
const SAVE_EVERY_N_PAGES = 5;

// Genre data extracted from your HTML
const genres = [
  { name: "Children's Fiction", primaryKey: "1", completed: 585 },
  { name: "Children's Fiction - Action & Adventure", primaryKey: "37", completed: 516 },
  { name: "Children's Fiction - Animals & Nature", primaryKey: "38", completed: 402 },
  { name: "Children's Fiction - Myths, Legends & Fairy Tales", primaryKey: "39", completed: 506 },
  { name: "Children's Fiction - Family", primaryKey: "40", completed: 214 },
  { name: "Children's Fiction - General", primaryKey: "41", completed: 161 },
  { name: "Children's Fiction - Historical", primaryKey: "42", completed: 83 },
  { name: "Children's Fiction - Poetry", primaryKey: "43", completed: 93 },
  { name: "Children's Fiction - Religion", primaryKey: "44", completed: 100 },
  { name: "Children's Fiction - School", primaryKey: "45", completed: 61 },
  { name: "Children's Fiction - Short works", primaryKey: "46", completed: 161 },
  { name: "Children's Non-fiction", primaryKey: "2", completed: 64 },
  { name: "Children's Non-fiction - Arts", primaryKey: "47", completed: 5 },
  { name: "Children's Non-fiction - General", primaryKey: "48", completed: 68 },
  { name: "Children's Non-fiction - Reference", primaryKey: "49", completed: 17 },
  { name: "Children's Non-fiction - Religion", primaryKey: "50", completed: 62 },
  { name: "Children's Non-fiction - Science", primaryKey: "51", completed: 49 },
  { name: "Children's Non-fiction - History", primaryKey: "144", completed: 59 },
  { name: "Children's Non-fiction - Biography", primaryKey: "145", completed: 50 },
  { name: "Action & Adventure Fiction", primaryKey: "3", completed: 937 },
  { name: "Classics (Greek & Latin Antiquity)", primaryKey: "4", completed: 326 },
  { name: "Crime & Mystery Fiction", primaryKey: "5", completed: 429 },
  { name: "Crime & Mystery Fiction - Detective Fiction", primaryKey: "22", completed: 554 },
  { name: "Culture & Heritage Fiction", primaryKey: "6", completed: 309 },
  { name: "Dramatic Readings", primaryKey: "7", completed: 228 },
  { name: "Epistolary Fiction", primaryKey: "8", completed: 84 },
  { name: "Erotica", primaryKey: "9", completed: 37 },
  { name: "Travel Fiction", primaryKey: "10", completed: 85 },
  { name: "Family Life", primaryKey: "12", completed: 243 },
  { name: "Fantastic Fiction", primaryKey: "13", completed: 255 },
  { name: "Fantastic Fiction - Myths, Legends & Fairy Tales", primaryKey: "11", completed: 478 },
  { name: "Fantastic Fiction - Horror & Supernatural Fiction", primaryKey: "16", completed: 507 },
  { name: "Fantastic Fiction - Gothic Fiction", primaryKey: "17", completed: 83 },
  { name: "Fantastic Fiction - Science Fiction", primaryKey: "30", completed: 844 },
  { name: "Fantastic Fiction - Fantasy Fiction", primaryKey: "55", completed: 211 },
  { name: "Fictional Biographies & Memoirs", primaryKey: "14", completed: 153 },
  { name: "General Fiction", primaryKey: "15", completed: 1136 },
  { name: "General Fiction - Published before 1800", primaryKey: "52", completed: 39 },
  { name: "General Fiction - Published 1800-1900", primaryKey: "53", completed: 467 },
  { name: "General Fiction - Published 1900 onward", primaryKey: "54", completed: 457 },
  { name: "Historical Fiction", primaryKey: "18", completed: 821 },
  { name: "Humorous Fiction", primaryKey: "19", completed: 619 },
  { name: "Literary Fiction", primaryKey: "20", completed: 650 },
  { name: "Nature & Animal Fiction", primaryKey: "21", completed: 108 },
  { name: "Nautical & Marine Fiction", primaryKey: "23", completed: 139 },
  { name: "Plays", primaryKey: "24", completed: 264 },
  { name: "Plays - Comedy", primaryKey: "57", completed: 213 },
  { name: "Plays - Comedy - Satire", primaryKey: "60", completed: 49 },
  { name: "Plays - Drama", primaryKey: "58", completed: 118 },
  { name: "Plays - Drama - Tragedy", primaryKey: "61", completed: 168 },
  { name: "Plays - Romance", primaryKey: "59", completed: 39 },
  { name: "Poetry", primaryKey: "25", completed: 1562 },
  { name: "Poetry - Anthologies", primaryKey: "62", completed: 185 },
  { name: "Poetry - Single author", primaryKey: "63", completed: 526 },
  { name: "Poetry - Ballads", primaryKey: "64", completed: 32 },
  { name: "Poetry - Elegies & Odes", primaryKey: "65", completed: 19 },
  { name: "Poetry - Epics", primaryKey: "66", completed: 104 },
  { name: "Poetry - Free Verse", primaryKey: "67", completed: 20 },
  { name: "Poetry - Lyric", primaryKey: "68", completed: 118 },
  { name: "Poetry - Narratives", primaryKey: "69", completed: 67 },
  { name: "Poetry - Sonnets", primaryKey: "70", completed: 57 },
  { name: "Poetry - Multi-version (Weekly and Fortnightly poetry)", primaryKey: "71", completed: 1426 },
  { name: "Religious Fiction", primaryKey: "26", completed: 49 },
  { name: "Religious Fiction - Christian Fiction", primaryKey: "72", completed: 205 },
  { name: "Romance", primaryKey: "27", completed: 830 },
  { name: "Sagas", primaryKey: "28", completed: 46 },
  { name: "Satire", primaryKey: "29", completed: 243 },
  { name: "Short Stories", primaryKey: "31", completed: 885 },
  { name: "Short Stories - Anthologies", primaryKey: "75", completed: 207 },
  { name: "Short Stories - Single Author Collections", primaryKey: "76", completed: 344 },
  { name: "Sports Fiction", primaryKey: "32", completed: 18 },
  { name: "Suspense, Espionage, Political & Thrillers", primaryKey: "33", completed: 135 },
  { name: "War & Military Fiction", primaryKey: "34", completed: 165 },
  { name: "Westerns", primaryKey: "35", completed: 133 },
  { name: "Non-fiction", primaryKey: "36", completed: 938 },
  { name: "Non-fiction - War & Military", primaryKey: "73", completed: 389 },
  { name: "Non-fiction - Animals", primaryKey: "77", completed: 124 },
  { name: "Non-fiction - Art, Design & Architecture", primaryKey: "78", completed: 99 },
  { name: "Non-fiction - Bibles", primaryKey: "79", completed: 184 },
  { name: "Non-fiction - Bibles - American Standard Version", primaryKey: "56", completed: 63 },
  { name: "Non-fiction - Bibles - World English Bible", primaryKey: "74", completed: 16 },
  { name: "Non-fiction - Bibles - King James Version", primaryKey: "139", completed: 77 },
  { name: "Non-fiction - Bibles - Weymouth New Testament", primaryKey: "140", completed: 10 },
  { name: "Non-fiction - Bibles - Douay-Rheims Version", primaryKey: "141", completed: 14 },
  { name: "Non-fiction - Bibles - Young's Literal Translation", primaryKey: "142", completed: 53 },
  { name: "Non-fiction - Biography & Autobiography", primaryKey: "80", completed: 832 },
  { name: "Non-fiction - Biography & Autobiography - Memoirs", primaryKey: "111", completed: 403 },
  { name: "Non-fiction - Business & Economics", primaryKey: "81", completed: 75 },
  { name: "Non-fiction - Crafts & Hobbies", primaryKey: "82", completed: 27 },
  { name: "Non-fiction - Education", primaryKey: "83", completed: 85 },
  { name: "Non-fiction - Education - Language learning", primaryKey: "112", completed: 38 },
  { name: "Non-fiction - Essays & Short Works", primaryKey: "84", completed: 608 },
  { name: "Non-fiction - Family & Relationships", primaryKey: "85", completed: 49 },
  { name: "Non-fiction - Health & Fitness", primaryKey: "86", completed: 37 },
  { name: "Non-fiction - History", primaryKey: "87", completed: 454 },
  { name: "Non-fiction - History - Antiquity", primaryKey: "113", completed: 146 },
  { name: "Non-fiction - History - Middle Ages", primaryKey: "114", completed: 109 },
  { name: "Non-fiction - History - Early Modern", primaryKey: "115", completed: 193 },
  { name: "Non-fiction - History - Modern (19th C)", primaryKey: "116", completed: 305 },
  { name: "Non-fiction - History - Modern (20th C)", primaryKey: "117", completed: 138 },
  { name: "Non-fiction - House & Home", primaryKey: "88", completed: 32 },
  { name: "Non-fiction - House & Home - Cooking", primaryKey: "118", completed: 106 },
  { name: "Non-fiction - House & Home - Gardening", primaryKey: "119", completed: 23 },
  { name: "Non-fiction - Humor", primaryKey: "89", completed: 115 },
  { name: "Non-fiction - Law", primaryKey: "90", completed: 72 },
  { name: "Non-fiction - Literary Collections", primaryKey: "91", completed: 102 },
  { name: "Non-fiction - Literary Collections - Essays", primaryKey: "120", completed: 28 },
  { name: "Non-fiction - Literary Collections - Short non-fiction", primaryKey: "121", completed: 31 },
  { name: "Non-fiction - Literary Collections - Letters", primaryKey: "122", completed: 59 },
  { name: "Non-fiction - Literary Criticism", primaryKey: "92", completed: 103 },
  { name: "Non-fiction - Mathematics", primaryKey: "93", completed: 18 },
  { name: "Non-fiction - Medical", primaryKey: "94", completed: 81 },
  { name: "Non-fiction - Music", primaryKey: "95", completed: 88 },
  { name: "Non-fiction - Nature", primaryKey: "96", completed: 281 },
  { name: "Non-fiction - Performing Arts", primaryKey: "97", completed: 46 },
  { name: "Non-fiction - Philosophy", primaryKey: "98", completed: 264 },
  { name: "Non-fiction - Philosophy - Ancient", primaryKey: "123", completed: 133 },
  { name: "Non-fiction - Philosophy - Medieval", primaryKey: "124", completed: 17 },
  { name: "Non-fiction - Philosophy - Early Modern", primaryKey: "125", completed: 61 },
  { name: "Non-fiction - Philosophy - Modern", primaryKey: "126", completed: 93 },
  { name: "Non-fiction - Philosophy - Contemporary", primaryKey: "127", completed: 28 },
  { name: "Non-fiction - Philosophy - Atheism & Agnosticism", primaryKey: "143", completed: 32 },
  { name: "Non-fiction - Political Science", primaryKey: "99", completed: 318 },
  { name: "Non-fiction - Psychology", primaryKey: "100", completed: 137 },
  { name: "Non-fiction - Reference", primaryKey: "101", completed: 38 },
  { name: "Non-fiction - Religion", primaryKey: "102", completed: 181 },
  { name: "Non-fiction - Religion - Christianity - Commentary", primaryKey: "128", completed: 195 },
  { name: "Non-fiction - Religion - Christianity - Biographies", primaryKey: "129", completed: 127 },
  { name: "Non-fiction - Religion - Christianity - Other", primaryKey: "130", completed: 604 },
  { name: "Non-fiction - Religion - Other religions", primaryKey: "131", completed: 112 },
  { name: "Non-fiction - Science", primaryKey: "103", completed: 135 },
  { name: "Non-fiction - Science - Astronomy, Physics & Mechanics", primaryKey: "132", completed: 62 },
  { name: "Non-fiction - Science - Chemistry", primaryKey: "133", completed: 22 },
  { name: "Non-fiction - Science - Earth Sciences", primaryKey: "134", completed: 45 },
  { name: "Non-fiction - Science - Life Sciences", primaryKey: "135", completed: 109 },
  { name: "Non-fiction - Self-Help", primaryKey: "104", completed: 143 },
  { name: "Non-fiction - Social Science (Culture & Anthropology)", primaryKey: "105", completed: 310 },
  { name: "Non-fiction - Sports & Recreation", primaryKey: "106", completed: 38 },
  { name: "Non-fiction - Sports & Recreation - Games", primaryKey: "136", completed: 6 },
  { name: "Non-fiction - Technology & Engineering", primaryKey: "107", completed: 55 },
  { name: "Non-fiction - Technology & Engineering - Transportation", primaryKey: "137", completed: 28 },
  { name: "Non-fiction - Travel & Geography", primaryKey: "108", completed: 415 },
  { name: "Non-fiction - Travel & Geography - Exploration", primaryKey: "138", completed: 130 },
  { name: "Non-fiction - True Crime", primaryKey: "109", completed: 89 },
  { name: "Non-fiction - Writing & Linguistics", primaryKey: "110", completed: 43 },
  { name: "Asian Antiquity", primaryKey: "146", completed: 30 }
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
      'author'  // Exclude any URL containing 'author'
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

// Scrape a single page of a genre
async function scrapeGenrePage(page, primaryKey, pageNum, retries = 3) {
  const url = `${LIBRIVOX_BASE_URL}/search?primary_key=${primaryKey}&search_category=genre&search_page=${pageNum}&search_form=get_results`;

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

// Scrape all pages for a genre with periodic saving
async function scrapeGenre(browser, genre, index, total) {
  const totalPages = Math.ceil(genre.completed / RESULTS_PER_PAGE);
  const filename = sanitizeFilename(genre.name) + '.txt';
  const filepath = path.join(OUTPUT_DIR, filename);

  console.log(`\n${'='.repeat(60)}`);
  console.log(`[${index + 1}/${total}] ${genre.name}`);
  console.log(`  Expected: ${genre.completed} books | Pages: ${totalPages} | Key: ${genre.primaryKey}`);
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

      const slugs = await scrapeGenrePage(page, genre.primaryKey, pageNum);
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
    genre: genre.name,
    primaryKey: genre.primaryKey,
    expected: genre.completed,
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
      return { completedGenres: [], results: [] };
    }
  }
  return { completedGenres: [], results: [] };
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
  console.log('LibriVox Genre Scraper (Playwright)');
  console.log('='.repeat(60));
  console.log(`Total genres to scrape: ${genres.length}`);
  console.log(`Output directory: ${OUTPUT_DIR}`);
  console.log(`Delay between requests: ${DELAY_MS}ms`);
  console.log(`Saving progress every: ${SAVE_EVERY_N_PAGES} pages`);
  console.log(`Excluding: Links containing 'author'`);
  console.log('='.repeat(60));

  // Load previous progress
  const progress = loadProgress();
  console.log(`Previously completed: ${progress.completedGenres.length} genres`);

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
    for (let i = 0; i < genres.length; i++) {
      const genre = genres[i];

      // Skip if already completed
      if (progress.completedGenres.includes(genre.primaryKey)) {
        console.log(`\n[${i + 1}/${genres.length}] ${genre.name} - SKIPPED (already completed)`);

        // Count existing slugs from file
        const filename = sanitizeFilename(genre.name) + '.txt';
        const filepath = path.join(OUTPUT_DIR, filename);
        if (fs.existsSync(filepath)) {
          const existingSlugs = fs.readFileSync(filepath, 'utf8').split('\n').filter(s => s.trim()).length;
          totalSlugsCollected += existingSlugs;
        }
        continue;
      }

      try {
        const result = await scrapeGenre(browser, genre, i, genres.length);
        progress.results.push(result);
        totalSlugsCollected += result.found;

        // Save progress after each successful genre
        progress.completedGenres.push(genre.primaryKey);
        saveProgress(progress);

        // Update live stats
        const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(2);
        saveLiveStats({
          lastUpdate: new Date().toISOString(),
          elapsedMinutes: elapsed,
          genresCompleted: progress.completedGenres.length,
          totalGenres: genres.length,
          totalSlugsCollected: totalSlugsCollected,
          currentGenre: genre.name,
          excludingAuthorLinks: true,
          status: 'running'
        });

        // Add delay between genres
        if (i < genres.length - 1) {
          console.log(`\n  ⏳ Waiting ${DELAY_MS * 1.5 / 1000}s before next genre...`);
          await sleep(DELAY_MS * 1.5);
        }
      } catch (error) {
        console.error(`\n  ❌ Error processing ${genre.name}: ${error.message}`);
        progress.results.push({
          genre: genre.name,
          primaryKey: genre.primaryKey,
          expected: genre.completed,
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
    totalGenres: genres.length,
    completedGenres: progress.completedGenres.length,
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
    genresCompleted: progress.completedGenres.length,
    totalGenres: genres.length,
    totalSlugsCollected: totalSlugsCollected,
    excludingAuthorLinks: true,
    status: 'completed'
  });

  console.log(`Completed in ${duration} minutes`);
  console.log(`Genres processed: ${progress.completedGenres.length}/${genres.length}`);
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