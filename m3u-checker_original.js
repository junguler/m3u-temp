// m3u-checker.js
// made with Gemini 2.5 Flash via https://t3.chat/ free tier - thanks
// usage example:
// node ./m3u-checker.js -> this expects m3u files in "m3u-files" folder and puts output files in "m3u-checked"
// or
// node ./m3u-checker.js input_folder/ output_folder/
// or
// node ./m3u-checker.js input_folder/ output_folder/ --quiet

const fs = require('fs/promises');
const path = require('path');

const concurrencyLimit = 10;
const linkTimeout = 5000; // 5 seconds timeout for each link
const maxRedirects = 3; // Maximum number of redirections to follow

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
    } else if (line.startsWith('http://') || line.startsWith('https://')) {
      // Explicitly check for http/https
      linksToProcess.push({
        title: currentTitle,
        url: line,
        originalIndex: i,
        originalTitleLineIndex: currentTitleLineIndex,
      });
      currentTitle = '';
      currentTitleLineIndex = -1;
    }
    // Any other lines (like #EXTGRP, comments, etc.) are ignored by this parser,
    // which is the correct behavior for identifying stream links.
  }
  return linksToProcess;
}

/**
 * Checks a single stream link for its availability, following redirects.
 * @param {{title: string, url: string, originalIndex: number, originalTitleLineIndex: number}} item - The stream item.
 * @param {string} fileName - The name of the file being processed (for logging).
 * @param {number} redirectCount - Current redirection count.
 * @param {boolean} quiet - Whether to suppress individual link logs.
 * @returns {Promise<{url: string, status: number|string, finalUrl?: string}>} The URL, its status, and the final URL after redirects.
 */
async function checkSingleLink(item, fileName, redirectCount = 0, quiet = false) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), linkTimeout);

  try {
    const response = await fetch(item.url, {
      method: 'HEAD',
      signal: controller.signal,
      redirect: 'manual', // Manually handle redirects
    });
    clearTimeout(timeoutId);

    // Handle redirects
    if (
      response.status >= 300 &&
      response.status < 400 &&
      response.headers.has('location') &&
      redirectCount < maxRedirects
    ) {
      const redirectUrl = response.headers.get('location');
      const absoluteRedirectUrl = new URL(redirectUrl, item.url).href; // Resolve relative redirects
      if (!quiet) {
        console.log(
          `  [${fileName}] - Redirect (${response.status}): ${item.url} -> ${absoluteRedirectUrl} (Attempt ${redirectCount + 1}/${maxRedirects})`,
        );
      }
      // Recursively call checkSingleLink with the new URL
      return await checkSingleLink(
        { ...item, url: absoluteRedirectUrl },
        fileName,
        redirectCount + 1,
        quiet,
      );
    }

    // If it's a successful non-redirecting link or after max redirects
    if (response.status === 200) {
      if (!quiet) {
        console.log(`  [${fileName}] - Status ${response.status}: ${item.url}`);
      }
      return { url: item.url, status: response.status, finalUrl: item.url };
    } else {
      if (!quiet) {
        console.log(`  [${fileName}] - Status ${response.status}: ${item.url}`);
      }
      return { url: item.url, status: response.status };
    }
  } catch (error) {
    clearTimeout(timeoutId);
    if (error.name === 'AbortError') {
      if (!quiet) {
        console.log(`  [${fileName}] - Timed out: ${item.url}`);
      }
      return { url: item.url, status: 'timedout' };
    }
    if (!quiet) {
      console.log(`  [${fileName}] - Invalid/Error (${error.message}): ${item.url}`);
    }
    return { url: item.url, status: 'invalid' };
  }
}

/**
 * Processes a list of stream links with a concurrency limit.
 * @param {Array<{title: string, url: string, originalIndex: number, originalTitleLineIndex: number}>} linksToProcess - Array of stream objects.
 * @param {string} fileName - The name of the file being processed.
 * @param {boolean} quiet - Whether to suppress logs.
 * @returns {Promise<Map<number, {titleLine: string, urlLine: string}>>} A map of valid links.
 */
async function processLinks(linksToProcess, fileName, quiet = false) {
  const tempValidLinks = new Map();
  const activePromises = new Set();
  let linksProcessedCount = 0;

  for (let i = 0; i < linksToProcess.length; i++) {
    const item = linksToProcess[i];
    const promise = checkSingleLink(item, fileName, 0, quiet).then((result) => {
      // We only care about successful 200 status AFTER all redirects
      if (result && result.status === 200) {
        // Store the final valid URL if a redirection occurred, otherwise the original
        const urlToStore = result.finalUrl || item.url;
        tempValidLinks.set(item.originalIndex, {
          titleLine: item.title,
          urlLine: urlToStore, // Use the final validated URL
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
 * This function is now more robust in preserving non-stream lines
 * and correctly handling only valid #EXTINF + URL pairs.
 * @param {string} originalM3uContent - The original M3U content.
 * @param {Map<number, {titleLine: string, urlLine: string}>} tempValidLinks - Map of valid links by their original URL line index, with potentially updated URLs.
 * @returns {string} The content of the cleaned M3U playlist.
 */
function generateOutputM3U(originalM3uContent, tempValidLinks) {
  const originalLines = originalM3uContent.split('\n');
  const outputLines = ['#EXTM3U']; // Always start with #EXTM3U
  const addedLines = new Set(['#EXTM3U']); // Keep track of lines already added to avoid duplicates

  for (let i = 0; i < originalLines.length; i++) {
    const line = originalLines[i].trim();

    if (line.startsWith('#EXTM3U')) {
      continue; // Skip the original #EXTM3U as we added it at the beginning
    }

    // Handle #EXTINF lines. We only add them if their associated URL is valid.
    if (line.startsWith('#EXTINF')) {
      const nextLineIndex = i + 1;
      // Check if there is a next line and if it corresponds to a valid stream URL
      if (
        nextLineIndex < originalLines.length &&
        tempValidLinks.has(nextLineIndex)
      ) {
        const { titleLine, urlLine } = tempValidLinks.get(nextLineIndex);
        // Add #EXTINF and its validated URL
        if (!addedLines.has(titleLine)) {
          outputLines.push(titleLine);
          addedLines.add(titleLine);
        }
        if (!addedLines.has(urlLine)) {
          outputLines.push(urlLine);
          addedLines.add(urlLine);
        }
        i = nextLineIndex; // Skip the URL line as it's already processed with its #EXTINF
      }
      // If the next line is not a valid URL or doesn't exist, we simply skip this #EXTINF
      continue;
    }

    // Handle standalone HTTP/HTTPS links (without an #EXTINF directly above them)
    // or HTTP/HTTPS links that *were* preceded by #EXTINF but deemed invalid
    else if (line.startsWith('http://') || line.startsWith('https://')) {
      // If this specific URL line itself (by its original index) was marked as valid
      // and it wasn't already handled by an #EXTINF block
      if (tempValidLinks.has(i)) {
        const { urlLine } = tempValidLinks.get(i);
        if (!addedLines.has(urlLine)) {
          outputLines.push(urlLine);
          addedLines.add(urlLine);
        }
      }
      continue; // Move to the next iteration
    }

    // Preserve any other non-empty lines (e.g., comments, #EXTGRP, etc.)
    if (line.length > 0 && !addedLines.has(line)) {
      outputLines.push(line);
      addedLines.add(line);
    }
  }
  return outputLines.join('\n');
}

/**
 * Main function to read, process, and write M3U files.
 * @param {string} inputDir - The directory containing M3U files.
 * @param {string} outputDir - The directory to save checked M3U files.
 * @param {boolean} quiet - Whether to run in quiet mode.
 */
async function main(inputDir, outputDir, quiet = false) {
  try {
    // Ensure output directory exists
    await fs.mkdir(outputDir, { recursive: true });

    const files = await fs.readdir(inputDir);
    const m3uFiles = files.filter(
      (file) => file.endsWith('.m3u') || file.endsWith('.m3u8'),
    );

    if (m3uFiles.length === 0) {
      if (!quiet) {
        console.log(`No .m3u or .m3u8 files found in "${inputDir}"`);
      }
      return;
    }

    if (!quiet) {
      console.log(`Found ${m3uFiles.length} M3U files to check in "${inputDir}".`);
    }

    for (const fileName of m3uFiles) {
      if (!quiet) {
        console.log(`\n--- Checking "${fileName}" ---`);
      }
      const fullPath = path.join(inputDir, fileName);
      const originalM3uContent = await fs.readFile(fullPath, 'utf8');

      const linksToProcess = parseM3UContent(originalM3uContent);
      if (!quiet) {
        console.log(`  Found ${linksToProcess.length} stream links.`);
      }

      // Case 1: No stream links were found at all by the parser
      if (linksToProcess.length === 0) {
        const outputM3uContent = generateOutputM3U(originalM3uContent, new Map());
        // If, after preserving other M3U tags, the output is only '#EXTM3U',
        // then the file effectively contained no streams or meaningful content.
        if (outputM3uContent.trim() !== '#EXTM3U') {
          const outputPath = path.join(outputDir, fileName);
          await fs.writeFile(outputPath, outputM3uContent, 'utf8');
          if (!quiet) {
            console.log(
              `  "${fileName}" had no stream links but contained other M3U data. Saved to "${outputPath}"`,
            );
          }
        } else {
          if (!quiet) {
            console.log(
              `  "${fileName}" contained only the M3U header or no valid streams (initial parse). Skipping output.`,
            );
          }
        }
        if (quiet) {
          console.log(`${fileName} checked - 0/0 streams were alive`);
        }
        continue; // Move to the next file
      }

      // Case 2: Stream links were found, now check their validity
      const tempValidLinks = await processLinks(linksToProcess, fileName, quiet);

      const validStreamCount = tempValidLinks.size;
      if (quiet) {
        console.log(`${fileName} checked - ${validStreamCount}/${linksToProcess.length} streams were alive`);
      } else {
        console.log(
          `  Check complete for "${fileName}". Found ${validStreamCount} valid streams out of ${linksToProcess.length}.`,
        );
      }

      // Condition 2: Exclude if none of the links are status coded 200
      if (validStreamCount === 0) {
        if (!quiet) {
          console.log(
            `  "${fileName}" has no valid (200 OK) streams after checking. Skipping output.`,
          );
        }
        continue; // Move to the next file without writing
      }

      const outputFileName = fileName;
      const outputPath = path.join(outputDir, outputFileName);
      const outputM3uContent = generateOutputM3U(
        originalM3uContent,
        tempValidLinks,
      );

      // Final check: ensure the generated output M3U isn't just '#EXTM3U' if validStreamCount > 0
      // This is a safety check, in theory, if validStreamCount > 0, this shouldn't happen.
      if (outputM3uContent.trim() === '#EXTM3U') {
        if (!quiet) {
          console.warn(
            `  WARNING: "${fileName}" had ${validStreamCount} valid streams, but output M3U is only '#EXTM3U'. Skipping output.`,
          );
        }
      } else {
        await fs.writeFile(outputPath, outputM3uContent, 'utf8');
        if (!quiet) {
          console.log(`  Saved checked playlist to "${outputPath}"`);
        }
      }
    }
    if (!quiet) {
      console.log('\n--- All M3U files processed ---');
    }
  } catch (error) {
    console.error('An error occurred:', error);
    process.exit(1);
  }
}

// Get input and output directories from command-line arguments, handling --quiet flag
let quiet = false;
let filteredArgs = [];
for (const arg of process.argv.slice(2)) {
  if (arg === '--quiet') {
    quiet = true;
  } else {
    filteredArgs.push(arg);
  }
}
const inputDirectory = filteredArgs[0] || 'm3u-files';
const outputDirectory = filteredArgs[1] || 'm3u-checked';

if (!quiet) {
  console.log(`Starting M3U Link Checker...`);
  console.log(`Input Directory: ${inputDirectory}`);
  console.log(`Output Directory: ${outputDirectory}`);
}

main(inputDirectory, outputDirectory, quiet);