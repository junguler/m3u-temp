// m3u-checker.js
const fs = require('fs/promises');
const path = require('path');

// No need for fileURLToPath in CommonJS if not needing __filename/__dirname from ESM
// If you need __filename or __dirname (which are globally available in CommonJS modules),
// you can directly use them. In this script, we're explicitly setting them for consistency
// with how they'd be derived in ESM, but it's not strictly necessary.

// __filename and __dirname are global in CommonJS.
// We explicitly define them here to mirror the ESM approach, but it's redundant
// as they are already available in CJS modules.
// const __filename = process.argv[1]; // Or simply use the global __filename
// const __dirname = path.dirname(__filename); // Or simply use the global __dirname

// For the purpose of this script, we don't strictly *need* __filename/__dirname
// because we're not resolving paths relative to the script itself for things
// like `fs.readFile(__filename, ...)` in a dynamic way.
// The `path.join` calls handle relative paths correctly based on `process.cwd()`.

const concurrencyLimit = 10;
const linkTimeout = 3000; // 3 seconds timeout for each link

/**
 * Parses M3U content and extracts stream links with their associated titles.
 * @param {string} m3uContent - The raw M3U playlist content.
 * @returns {Array<{title: string, url: string, originalIndex: number, originalTitleLineIndex: number}>} An array of stream objects.
 */
function parseM3UContent(m3uContent) {
  const originalLines = m3uContent.split('\n');
  const linksToProcess = [];

  let currentTitle = '';
  let currentTitleLineIndex = -1;

  for (let i = 0; i < originalLines.length; i++) {
    const line = originalLines[i].trim();

    if (line.startsWith('#EXTINF')) {
      currentTitle = line;
      currentTitleLineIndex = i;
    } else if (line.startsWith('http')) {
      linksToProcess.push({
        title: currentTitle,
        url: line,
        originalIndex: i,
        originalTitleLineIndex: currentTitleLineIndex,
      });
      currentTitle = '';
      currentTitleLineIndex = -1;
    }
  }
  return linksToProcess;
}

/**
 * Checks a single stream link for its availability.
 * @param {{title: string, url: string, originalIndex: number, originalTitleLineIndex: number}} item - The stream item.
 * @param {string} fileName - The name of the file being processed (for logging).
 * @returns {Promise<{url: string, status: number|string}>} The URL and its status.
 */
async function checkSingleLink(item, fileName) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), linkTimeout);

  try {
    // Using the native global fetch in Node.js v18+
    const response = await fetch(item.url, { method: 'HEAD', signal: controller.signal });
    clearTimeout(timeoutId);
    console.log(`  [${fileName}] - Status ${response.status}: ${item.url}`);
    return { url: item.url, status: response.status };
  } catch (error) {
    clearTimeout(timeoutId);
    if (error.name === 'AbortError') {
      console.log(`  [${fileName}] - Timed out: ${item.url}`);
      return { url: item.url, status: 'timedout' };
    }
    console.log(`  [${fileName}] - Invalid/Error (${error.message}): ${item.url}`);
    return { url: item.url, status: 'invalid' };
  }
}

/**
 * Processes a list of stream links with a concurrency limit.
 * @param {Array<{title: string, url: string, originalIndex: number, originalTitleLineIndex: number}>} linksToProcess - Array of stream objects.
 * @param {string} fileName - The name of the file being processed.
 * @returns {Promise<Map<number, {titleLine: string, urlLine: string}>>} A map of valid links.
 */
async function processLinks(linksToProcess, fileName) {
  const tempValidLinks = new Map();
  const activePromises = new Set();
  let linksProcessedCount = 0;

  for (let i = 0; i < linksToProcess.length; i++) {
    const item = linksToProcess[i];
    const promise = checkSingleLink(item, fileName).then((result) => {
      if (result && (result.status === 200 || (result.status >= 300 && result.status < 400))) {
        tempValidLinks.set(item.originalIndex, {
          titleLine: item.title,
          urlLine: item.url,
        });
      }
      linksProcessedCount++;
      // console.log(`  [${fileName}] - Processed ${linksProcessedCount}/${linksToProcess.length}`);
      activePromises.delete(promise);
      return result;
    });

    activePromises.add(promise);

    if (activePromises.size >= concurrencyLimit) {
      await Promise.race(Array.from(activePromises));
    }
  }

  await Promise.allSettled(Array.from(activePromises));
  return tempValidLinks;
}

/**
 * Generates the content for the checked M3U playlist.
 * @param {string} originalM3uContent - The original M3U content.
 * @param {Map<number, {titleLine: string, urlLine: string}>} tempValidLinks - Map of valid links by their original line index.
 * @returns {string} The content of the cleaned M3U playlist.
 */
function generateOutputM3U(originalM3uContent, tempValidLinks) {
  const originalLines = originalM3uContent.split('\n');
  const validLinksContent = [];
  const finalOutputLines = new Set();

  validLinksContent.push('#EXTM3U');
  finalOutputLines.add('#EXTM3U');

  for (let i = 0; i < originalLines.length; i++) {
    const line = originalLines[i].trim();

    if (line.startsWith('#EXTM3U')) {
      continue;
    }

    if (line.startsWith('#EXTINF')) {
      const nextLineIndex = i + 1;
      if (nextLineIndex < originalLines.length) {
        const nextLine = originalLines[nextLineIndex].trim();
        if (nextLine.startsWith('http') && tempValidLinks.has(nextLineIndex)) {
          const { titleLine, urlLine } = tempValidLinks.get(nextLineIndex);
          if (!finalOutputLines.has(titleLine)) {
            validLinksContent.push(titleLine);
            finalOutputLines.add(titleLine);
          }
          if (!finalOutputLines.has(urlLine)) {
            validLinksContent.push(urlLine);
            finalOutputLines.add(urlLine);
          }
          i = nextLineIndex;
        }
      }
    } else if (line.startsWith('http')) {
      if (tempValidLinks.has(i)) {
        const { urlLine } = tempValidLinks.get(i);
        if (!finalOutputLines.has(urlLine)) {
          validLinksContent.push(urlLine);
          finalOutputLines.add(urlLine);
        }
      }
    } else {
      if (line.trim() !== '' && !finalOutputLines.has(line)) {
        validLinksContent.push(line);
        finalOutputLines.add(line);
      }
    }
  }
  return validLinksContent.join('\n');
}

/**
 * Main function to read, process, and write M3U files.
 * @param {string} inputDir - The directory containing M3U files.
 * @param {string} outputDir - The directory to save checked M3U files.
 */
async function main(inputDir, outputDir) {
  try {
    // Ensure output directory exists
    await fs.mkdir(outputDir, { recursive: true });

    const files = await fs.readdir(inputDir);
    const m3uFiles = files.filter(
      (file) => file.endsWith('.m3u') || file.endsWith('.m3u8')
    );

    if (m3uFiles.length === 0) {
      console.log(`No .m3u or .m3u8 files found in ${inputDir}`);
      return;
    }

    console.log(`Found ${m3uFiles.length} M3U files to check in "${inputDir}".`);

    for (const fileName of m3uFiles) {
      console.log(`\n--- Checking "${fileName}" ---`);
      const fullPath = path.join(inputDir, fileName);
      const originalM3uContent = await fs.readFile(fullPath, 'utf8');

      const linksToProcess = parseM3UContent(originalM3uContent);
      console.log(`  Found ${linksToProcess.length} stream links.`);

      if (linksToProcess.length === 0) {
        console.log(`  No stream links found in "${fileName}". Copying as-is.`);
        await fs.writeFile(
          path.join(outputDir, fileName),
          originalM3uContent,
          'utf8'
        );
        continue;
      }

      const tempValidLinks = await processLinks(linksToProcess, fileName);

      const validStreamCount = tempValidLinks.size;
      console.log(
        `  Check complete for "${fileName}". Found ${validStreamCount} valid streams out of ${linksToProcess.length}.`
      );

      const outputFileName = fileName.replace(
        /(\.m3u8?)$/,
        '_checked$1'
      );
      const outputPath = path.join(outputDir, outputFileName);
      const outputM3uContent = generateOutputM3U(
        originalM3uContent,
        tempValidLinks
      );

      await fs.writeFile(outputPath, outputM3uContent, 'utf8');
      console.log(`  Saved checked playlist to "${outputPath}"`);
    }
    console.log('\n--- All M3U files processed ---');
  } catch (error) {
    console.error('An error occurred:', error);
    process.exit(1);
  }
}

// Get input and output directories from command-line arguments
const args = process.argv.slice(2);
const inputDirectory = args[0] || 'm3u-files';
const outputDirectory = args[1] || 'm3u-checked';

console.log(`Starting M3U Link Checker...`);
console.log(`Input Directory: ${inputDirectory}`);
console.log(`Output Directory: ${outputDirectory}`);

main(inputDirectory, outputDirectory);
