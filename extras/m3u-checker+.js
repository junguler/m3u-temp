// m3u-checker.js
//
// Usage:
//
//   node m3u-checker.js
//   node m3u-checker.js input_folder/ output_folder/
//   node m3u-checker.js input_folder/ output_folder/ --quiet
//
// Optional environment variables:
//
//   CONCURRENCY=100
//   LINK_TIMEOUT=8000
//   MAX_REDIRECTS=3
//
// Example:
//
//   CONCURRENCY=150 LINK_TIMEOUT=8000 node m3u-checker.js

const fs = require('fs/promises');
const path = require('path');

const concurrencyLimit = Number(process.env.CONCURRENCY || 100);
const linkTimeout = Number(process.env.LINK_TIMEOUT || 8000);
const maxRedirects = Number(process.env.MAX_REDIRECTS || 3);

const USER_AGENT = 'm3u-checker/1.0';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Creates a global concurrency limiter.
 *
 * This limiter is shared across all files, so processing multiple files
 * concurrently cannot create more than concurrencyLimit HTTP requests.
 *
 * @param {number} limit
 * @returns {(task: () => Promise<any>) => Promise<any>}
 */
function createLimiter(limit) {
  const queue = [];
  let active = 0;

  function runNext() {
    while (active < limit && queue.length > 0) {
      const { task, resolve, reject } = queue.shift();

      active++;

      Promise.resolve()
        .then(task)
        .then(resolve, reject)
        .finally(() => {
          active--;
          runNext();
        });
    }
  }

  return function limitTask(task) {
    return new Promise((resolve, reject) => {
      queue.push({ task, resolve, reject });
      runNext();
    });
  };
}

/**
 * Parses M3U content and extracts stream links.
 *
 * The URL does not need to be immediately after #EXTINF.
 * For example, #EXTGRP lines between the title and URL are supported.
 *
 * @param {string} m3uContent
 * @returns {Array<{
 *   title: string,
 *   url: string,
 *   originalIndex: number,
 *   originalTitleLineIndex: number
 * }>}
 */
function parseM3UContent(m3uContent) {
  const originalLines = m3uContent.split(/\r?\n/);
  const linksToProcess = [];

  let currentTitle = '';
  let currentTitleLineIndex = -1;

  for (let i = 0; i < originalLines.length; i++) {
    const line = originalLines[i].trim();

    if (line.startsWith('#EXTINF')) {
      currentTitle = line;
      currentTitleLineIndex = i;
      continue;
    }

    if (line.startsWith('http://') || line.startsWith('https://')) {
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
 * Performs one HTTP request with a timeout.
 *
 * @param {string} url
 * @param {object} options
 * @returns {Promise<Response>}
 */
async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, linkTimeout);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
      redirect: 'manual',
      headers: {
        'User-Agent': USER_AGENT,
        Accept: '*/*',
        ...(options.headers || {}),
      },
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Checks a URL with HEAD first.
 *
 * Some streaming servers reject HEAD with 405 or 501 even though GET works,
 * so those responses fall back to a small ranged GET request.
 *
 * @param {string} url
 * @returns {Promise<Response>}
 */
async function requestUrl(url) {
  let response = await fetchWithTimeout(url, {
    method: 'HEAD',
  });

  if (response.status === 405 || response.status === 501) {
    response = await fetchWithTimeout(url, {
      method: 'GET',
      headers: {
        Range: 'bytes=0-0',
      },
    });

    // Do not download the complete stream.
    try {
      await response.body?.cancel();
    } catch {
      // Ignore body cancellation errors.
    }
  }

  return response;
}

/**
 * Checks a single stream link, following redirects.
 *
 * @param {{
 *   title: string,
 *   url: string,
 *   originalIndex: number,
 *   originalTitleLineIndex: number
 * }} item
 * @param {string} fileName
 * @param {boolean} quiet
 * @param {number} redirectCount
 * @returns {Promise<{
 *   url: string,
 *   status: number|string,
 *   finalUrl?: string
 * }>}
 */
async function checkSingleLink(
  item,
  fileName,
  quiet = false,
  redirectCount = 0,
) {
  try {
    const response = await requestUrl(item.url);

    const isRedirect =
      response.status >= 300 &&
      response.status < 400 &&
      response.headers.has('location');

    if (isRedirect && redirectCount < maxRedirects) {
      const redirectUrl = response.headers.get('location');
      const absoluteRedirectUrl = new URL(redirectUrl, item.url).href;

      if (!quiet) {
        console.log(
          `  [${fileName}] Redirect ${response.status}: ` +
            `${item.url} -> ${absoluteRedirectUrl} ` +
            `(attempt ${redirectCount + 1}/${maxRedirects})`,
        );
      }

      return checkSingleLink(
        {
          ...item,
          url: absoluteRedirectUrl,
        },
        fileName,
        quiet,
        redirectCount + 1,
      );
    }

    // Treat all 2xx responses as alive.
    if (response.status >= 200 && response.status < 300) {
      if (!quiet) {
        console.log(
          `  [${fileName}] Status ${response.status}: ${item.url}`,
        );
      }

      return {
        url: item.url,
        status: response.status,
        finalUrl: item.url,
      };
    }

    if (!quiet) {
      console.log(
        `  [${fileName}] Status ${response.status}: ${item.url}`,
      );
    }

    return {
      url: item.url,
      status: response.status,
    };
  } catch (error) {
    if (error?.name === 'AbortError') {
      if (!quiet) {
        console.log(`  [${fileName}] Timed out: ${item.url}`);
      }

      return {
        url: item.url,
        status: 'timedout',
      };
    }

    if (!quiet) {
      console.log(
        `  [${fileName}] Error (${error.message}): ${item.url}`,
      );
    }

    return {
      url: item.url,
      status: 'invalid',
    };
  }
}

/**
 * Processes links using the shared global limiter.
 *
 * @param {Array} linksToProcess
 * @param {string} fileName
 * @param {boolean} quiet
 * @param {(task: () => Promise<any>) => Promise<any>} limiter
 * @returns {Promise<Map<number, {titleLine: string, urlLine: string}>>}
 */
async function processLinks(
  linksToProcess,
  fileName,
  quiet,
  limiter,
) {
  const validLinks = new Map();

  let nextIndex = 0;

  async function worker() {
    while (true) {
      const currentIndex = nextIndex++;

      if (currentIndex >= linksToProcess.length) {
        return;
      }

      const item = linksToProcess[currentIndex];

      const result = await limiter(() =>
        checkSingleLink(item, fileName, quiet),
      );

      if (
        result &&
        typeof result.status === 'number' &&
        result.status >= 200 &&
        result.status < 300
      ) {
        validLinks.set(item.originalIndex, {
          titleLine: item.title,
          urlLine: result.finalUrl || item.url,
        });
      }
    }
  }

  // One worker per available global slot, capped by this file's link count.
  const workerCount = Math.min(
    concurrencyLimit,
    linksToProcess.length,
  );

  await Promise.all(
    Array.from({ length: workerCount }, () => worker()),
  );

  return validLinks;
}

/**
 * Finds the next HTTP/HTTPS URL after an #EXTINF line.
 *
 * It stops if another #EXTINF is found first.
 *
 * @param {string[]} lines
 * @param {number} titleIndex
 * @returns {number}
 */
function findNextUrlIndex(lines, titleIndex) {
  for (let i = titleIndex + 1; i < lines.length; i++) {
    const line = lines[i].trim();

    if (line.startsWith('#EXTINF')) {
      return -1;
    }

    if (line.startsWith('http://') || line.startsWith('https://')) {
      return i;
    }
  }

  return -1;
}

/**
 * Generates the cleaned M3U playlist.
 *
 * Validated stream entries are retained. Invalid stream entries are removed.
 * Non-stream lines are preserved where practical.
 *
 * @param {string} originalM3uContent
 * @param {Map<number, {titleLine: string, urlLine: string}>} validLinks
 * @returns {string}
 */
function generateOutputM3U(originalM3uContent, validLinks) {
  const originalLines = originalM3uContent.split(/\r?\n/);
  const outputLines = ['#EXTM3U'];

  for (let i = 0; i < originalLines.length; i++) {
    const rawLine = originalLines[i];
    const line = rawLine.trim();

    if (line.length === 0) {
      continue;
    }

    if (line.startsWith('#EXTM3U')) {
      continue;
    }

    if (line.startsWith('#EXTINF')) {
      const urlIndex = findNextUrlIndex(originalLines, i);

      if (urlIndex !== -1 && validLinks.has(urlIndex)) {
        const { titleLine, urlLine } = validLinks.get(urlIndex);

        outputLines.push(titleLine);

        // Preserve lines such as #EXTGRP between #EXTINF and the URL.
        for (let j = i + 1; j < urlIndex; j++) {
          const intermediateLine = originalLines[j].trim();

          if (
            intermediateLine.length > 0 &&
            !intermediateLine.startsWith('http://') &&
            !intermediateLine.startsWith('https://') &&
            !intermediateLine.startsWith('#EXTINF')
          ) {
            outputLines.push(intermediateLine);
          }
        }

        outputLines.push(urlLine);

        // Skip all lines belonging to this entry.
        i = urlIndex;
      } else {
        // Skip invalid #EXTINF entries and their associated URL.
        if (urlIndex !== -1) {
          i = urlIndex;
        }
      }

      continue;
    }

    if (line.startsWith('http://') || line.startsWith('https://')) {
      if (validLinks.has(i)) {
        const { urlLine } = validLinks.get(i);
        outputLines.push(urlLine);
      }

      continue;
    }

    // Preserve other playlist metadata and comments.
    outputLines.push(line);
  }

  return `${outputLines.join('\n')}\n`;
}

/**
 * Processes one M3U file.
 *
 * @param {string} inputDir
 * @param {string} outputDir
 * @param {string} fileName
 * @param {boolean} quiet
 * @param {(task: () => Promise<any>) => Promise<any>} limiter
 */
async function processFile(
  inputDir,
  outputDir,
  fileName,
  quiet,
  limiter,
) {
  const fullPath = path.join(inputDir, fileName);
  const originalM3uContent = await fs.readFile(fullPath, 'utf8');

  const linksToProcess = parseM3UContent(originalM3uContent);

  if (!quiet) {
    console.log(
      `[${fileName}] Found ${linksToProcess.length} stream links.`,
    );
  }

  if (linksToProcess.length === 0) {
    const outputM3uContent = generateOutputM3U(
      originalM3uContent,
      new Map(),
    );

    if (outputM3uContent.trim() !== '#EXTM3U') {
      const outputPath = path.join(outputDir, fileName);

      await fs.writeFile(
        outputPath,
        outputM3uContent,
        'utf8',
      );

      if (!quiet) {
        console.log(
          `[${fileName}] No stream links found. Saved metadata output.`,
        );
      }
    } else if (!quiet) {
      console.log(
        `[${fileName}] No stream links or meaningful content. Skipped.`,
      );
    }

    if (quiet) {
      console.log(`${fileName} checked - 0/0 streams were alive`);
    }

    return;
  }

  const validLinks = await processLinks(
    linksToProcess,
    fileName,
    quiet,
    limiter,
  );

  const validStreamCount = validLinks.size;

  if (quiet) {
    console.log(
      `${fileName} checked - ` +
        `${validStreamCount}/${linksToProcess.length} streams were alive`,
    );
  } else {
    console.log(
      `[${fileName}] Complete: ` +
        `${validStreamCount}/${linksToProcess.length} streams alive.`,
    );
  }

  if (validStreamCount === 0) {
    if (!quiet) {
      console.log(`[${fileName}] No valid streams. Output skipped.`);
    }

    return;
  }

  const outputM3UContent = generateOutputM3U(
    originalM3uContent,
    validLinks,
  );

  if (outputM3UContent.trim() === '#EXTM3U') {
    if (!quiet) {
      console.warn(
        `[${fileName}] Valid links were found, but output was empty. Skipped.`,
      );
    }

    return;
  }

  const outputPath = path.join(outputDir, fileName);

  await fs.writeFile(
    outputPath,
    outputM3UContent,
    'utf8',
  );

  if (!quiet) {
    console.log(`[${fileName}] Saved to "${outputPath}"`);
  }
}

/**
 * Main function.
 *
 * @param {string} inputDir
 * @param {string} outputDir
 * @param {boolean} quiet
 */
async function main(inputDir, outputDir, quiet = false) {
  await fs.mkdir(outputDir, { recursive: true });

  const files = await fs.readdir(inputDir);

  const m3uFiles = files.filter((file) => {
    const lowerFile = file.toLowerCase();

    return (
      lowerFile.endsWith('.m3u') ||
      lowerFile.endsWith('.m3u8')
    );
  });

  if (m3uFiles.length === 0) {
    if (!quiet) {
      console.log(`No .m3u or .m3u8 files found in "${inputDir}"`);
    }

    return;
  }

  console.log(
    `Found ${m3uFiles.length} M3U files. ` +
      `Global concurrency: ${concurrencyLimit}. ` +
      `Timeout: ${linkTimeout}ms.`,
  );

  // One global limiter is shared by every file.
  const limiter = createLimiter(concurrencyLimit);

  // Process files concurrently while keeping total HTTP concurrency capped.
  await Promise.all(
    m3uFiles.map((fileName) =>
      processFile(
        inputDir,
        outputDir,
        fileName,
        quiet,
        limiter,
      ),
    ),
  );

  if (!quiet) {
    console.log('\n--- All M3U files processed ---');
  }
}

// Parse command-line arguments.
let quiet = false;
const filteredArgs = [];

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
  console.log('Starting M3U Link Checker...');
  console.log(`Input Directory: ${inputDirectory}`);
  console.log(`Output Directory: ${outputDirectory}`);
  console.log(`Concurrency: ${concurrencyLimit}`);
  console.log(`Timeout: ${linkTimeout}ms`);
}

main(inputDirectory, outputDirectory, quiet).catch((error) => {
  console.error('An error occurred:', error);
  process.exitCode = 1;
});
