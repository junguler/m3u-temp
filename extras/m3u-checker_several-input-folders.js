// m3u-checker.js
//
// Usage:
//
//   node m3u-checker.js
//   node m3u-checker.js input_folder/ output_folder/
//   node m3u-checker.js input_folder/ output_folder/ --quiet
//
// The input folder may contain several sub-folders. Every folder that holds
// .m3u / .m3u8 files is checked, and its cleaned playlists are written to a
// folder with the same name (same relative path) inside the output folder:
//
//   node m3u-checker.js test_input/ test_output/ --quiet
//
//     test_input/*.m3u         ->  test_output/*.m3u
//     test_input/radio/*.m3u   ->  test_output/radio/*.m3u
//     test_input/tv/*.m3u      ->  test_output/tv/*.m3u
//
// Defaults: input = m3u-files, output = m3u-checked
//
// Optional environment variables:
//
//   CONCURRENCY=100
//   LINK_TIMEOUT=8000
//   MAX_REDIRECTS=3
//   PROGRESS_INTERVAL=30000   (milliseconds between progress reports)
//
// Example:
//
//   CONCURRENCY=150 LINK_TIMEOUT=8000 node m3u-checker.js test_input/ test_output/

const fs = require('fs/promises');
const path = require('path');

const concurrencyLimit = Number(process.env.CONCURRENCY || 100);
const linkTimeout = Number(process.env.LINK_TIMEOUT || 8000);
const maxRedirects = Number(process.env.MAX_REDIRECTS || 3);
const progressInterval = Number(process.env.PROGRESS_INTERVAL || 30000);

const USER_AGENT = 'm3u-checker/1.0';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Global statistics used by the periodic progress report.
 */
const stats = {
  startTime: Date.now(),
  totalFiles: 0,
  filesParsed: 0,
  filesDone: 0,
  totalLinks: 0,
  checked: 0,
  alive: 0,
  timedOut: 0,
  invalid: 0,
  httpError: 0,
  inFlight: 0,

  // label ("folder/file.m3u") -> { total, checked, alive }
  activeFiles: new Map(),

  // folder name -> { files, links, alive }
  folders: new Map(),
};

/**
 * Formats milliseconds as e.g. "1h 02m 05s", "3m 07s" or "12s".
 *
 * @param {number} ms
 * @returns {string}
 */
function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return (
      `${hours}h ` +
      `${String(minutes).padStart(2, '0')}m ` +
      `${String(seconds).padStart(2, '0')}s`
    );
  }

  if (minutes > 0) {
    return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
  }

  return `${seconds}s`;
}

/**
 * Prints one progress report.
 *
 * @param {boolean} final  true for the closing summary
 */
function printProgress(final = false) {
  const elapsedMs = Date.now() - stats.startTime;
  const elapsedSeconds = elapsedMs / 1000;

  const percent =
    stats.totalLinks > 0
      ? ((stats.checked / stats.totalLinks) * 100).toFixed(1)
      : '0.0';

  const rate = elapsedSeconds > 0 ? stats.checked / elapsedSeconds : 0;

  // The ETA is only meaningful once every file has been parsed,
  // because only then is the total link count final.
  let eta = 'estimating...';

  if (stats.filesParsed >= stats.totalFiles && rate > 0) {
    const remaining = stats.totalLinks - stats.checked;
    eta = remaining > 0 ? formatDuration((remaining / rate) * 1000) : '0s';
  }

  const label = final ? 'FINAL' : 'PROGRESS';

  const lines = [
    '',
    `[${label}] Elapsed: ${formatDuration(elapsedMs)}`,
    `[${label}] Files:   ${stats.filesDone}/${stats.totalFiles} done ` +
      `(${stats.filesParsed}/${stats.totalFiles} read)`,
    `[${label}] Links:   ${stats.checked}/${stats.totalLinks} checked ` +
      `(${percent}%), ${stats.inFlight} in flight`,
    `[${label}] Results: ${stats.alive} alive, ` +
      `${stats.timedOut} timed out, ` +
      `${stats.invalid} invalid/unreachable, ` +
      `${stats.httpError} HTTP errors`,
  ];

  if (!final) {
    lines.push(
      `[${label}] Speed:   ${rate.toFixed(1)} links/s, ETA: ${eta}`,
    );

    if (stats.activeFiles.size > 0) {
      const active = [...stats.activeFiles.entries()]
        .sort((a, b) => b[1].total - b[1].checked - (a[1].total - a[1].checked))
        .slice(0, 5);

      lines.push(
        `[${label}] Busiest unfinished files ` +
          `(${stats.activeFiles.size} in progress):`,
      );

      for (const [name, info] of active) {
        lines.push(
          `[${label}]   ${name}: ${info.checked}/${info.total} checked, ` +
            `${info.alive} alive`,
        );
      }
    }
  } else {
    lines.push(
      `[${label}] Average speed: ${rate.toFixed(1)} links/s`,
    );
  }

  console.log(lines.join('\n'));
}

/**
 * Records the result of one checked link in the global statistics.
 *
 * @param {number|string} status
 * @param {string} fileName
 */
function recordResult(status, fileName) {
  stats.checked++;

  const fileInfo = stats.activeFiles.get(fileName);

  if (fileInfo) {
    fileInfo.checked++;
  }

  if (typeof status === 'number' && status >= 200 && status < 300) {
    stats.alive++;

    if (fileInfo) {
      fileInfo.alive++;
    }
  } else if (status === 'timedout') {
    stats.timedOut++;
  } else if (status === 'invalid') {
    stats.invalid++;
  } else {
    stats.httpError++;
  }
}

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

      const result = await limiter(async () => {
        stats.inFlight++;

        try {
          return await checkSingleLink(item, fileName, quiet);
        } finally {
          stats.inFlight--;
        }
      });

      recordResult(result?.status, fileName);

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
 * @param {{
 *   inputDir: string,
 *   outputDir: string,
 *   folderName: string,
 *   fileName: string,
 *   label: string
 * }} job
 * @param {boolean} quiet
 * @param {(task: () => Promise<any>) => Promise<any>} limiter
 */
async function processFile(job, quiet, limiter) {
  const { inputDir, outputDir, folderName, fileName } = job;

  // Used in logs and the progress report. Includes the folder so identical
  // file names in different folders stay distinguishable.
  const label = job.label;

  const folderStats = stats.folders.get(folderName);
  const fullPath = path.join(inputDir, fileName);
  const originalM3uContent = await fs.readFile(fullPath, 'utf8');

  const linksToProcess = parseM3UContent(originalM3uContent);

  // Register this file with the progress reporter.
  stats.filesParsed++;
  stats.totalLinks += linksToProcess.length;
  stats.activeFiles.set(label, {
    total: linksToProcess.length,
    checked: 0,
    alive: 0,
  });

  if (!quiet) {
    console.log(
      `[${label}] Found ${linksToProcess.length} stream links.`,
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
          `[${label}] No stream links found. Saved metadata output.`,
        );
      }
    } else if (!quiet) {
      console.log(
        `[${label}] No stream links or meaningful content. Skipped.`,
      );
    }

    if (quiet) {
      console.log(`${label} checked - 0/0 streams were alive`);
    }

    return;
  }

  const validLinks = await processLinks(
    linksToProcess,
    label,
    quiet,
    limiter,
  );

  const validStreamCount = validLinks.size;

  folderStats.files++;
  folderStats.links += linksToProcess.length;
  folderStats.alive += validStreamCount;

  if (quiet) {
    console.log(
      `${label} checked - ` +
        `${validStreamCount}/${linksToProcess.length} streams were alive`,
    );
  } else {
    console.log(
      `[${label}] Complete: ` +
        `${validStreamCount}/${linksToProcess.length} streams alive.`,
    );
  }

  if (validStreamCount === 0) {
    if (!quiet) {
      console.log(`[${label}] No valid streams. Output skipped.`);
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
        `[${label}] Valid links were found, but output was empty. Skipped.`,
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
    console.log(`[${label}] Saved to "${outputPath}"`);
  }
}

/**
 * Walks the input folder (including all sub-folders) and builds one job per
 * M3U file. Each sub-folder is mapped to a same-named sub-folder of the
 * output folder.
 *
 * @param {string} inputRoot
 * @param {string} outputRoot
 * @returns {Promise<Array<{
 *   inputDir: string,
 *   outputDir: string,
 *   folderName: string,
 *   fileName: string,
 *   label: string
 * }>>}
 */
async function collectJobs(inputRoot, outputRoot) {
  const jobs = [];
  const resolvedOutput = path.resolve(outputRoot);

  async function walk(relativeDir) {
    const inputDir = path.join(inputRoot, relativeDir);

    // Never descend into the output folder if it lives inside the input folder.
    if (path.resolve(inputDir) === resolvedOutput) {
      return;
    }

    let entries;

    try {
      entries = await fs.readdir(inputDir, { withFileTypes: true });
    } catch (error) {
      console.warn(
        `Skipping "${inputDir}": cannot read folder (${error.message}).`,
      );
      return;
    }

    entries.sort((a, b) => a.name.localeCompare(b.name));

    const m3uFiles = entries
      .filter((entry) => {
        const lowerName = entry.name.toLowerCase();

        return (
          entry.isFile() &&
          (lowerName.endsWith('.m3u') || lowerName.endsWith('.m3u8'))
        );
      })
      .map((entry) => entry.name);

    if (m3uFiles.length > 0) {
      const outputDir = path.join(outputRoot, relativeDir);
      const folderName = relativeDir || '.';

      await fs.mkdir(outputDir, { recursive: true });

      stats.folders.set(folderName, { files: 0, links: 0, alive: 0 });

      for (const fileName of m3uFiles) {
        jobs.push({
          inputDir,
          outputDir,
          folderName,
          fileName,
          label: relativeDir
            ? `${relativeDir.split(path.sep).join('/')}/${fileName}`
            : fileName,
        });
      }
    }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        await walk(path.join(relativeDir, entry.name));
      }
    }
  }

  await walk('');

  return jobs;
}

/**
 * Main function.
 *
 * @param {string} inputDir
 * @param {string} outputDir
 * @param {boolean} quiet
 */
async function main(inputDir, outputDir, quiet = false) {
  const jobs = await collectJobs(inputDir, outputDir);

  if (jobs.length === 0) {
    console.log(`No .m3u or .m3u8 files found in "${inputDir}"`);
    return;
  }

  console.log(
    `Found ${jobs.length} M3U files in ${stats.folders.size} folder(s). ` +
      `Global concurrency: ${concurrencyLimit}. ` +
      `Timeout: ${linkTimeout}ms.`,
  );

  stats.totalFiles = jobs.length;
  stats.startTime = Date.now();

  // Periodic progress report (printed even in --quiet mode).
  const progressTimer = setInterval(() => {
    printProgress(false);
  }, progressInterval);

  // One global limiter is shared by every file in every folder.
  const limiter = createLimiter(concurrencyLimit);

  try {
    // Process all files concurrently while keeping total HTTP concurrency capped.
    await Promise.all(
      jobs.map((job) =>
        processFile(job, quiet, limiter)
          .catch((error) => {
            console.error(`[${job.label}] Failed:`, error.message);
          })
          .finally(() => {
            stats.filesDone++;
            stats.activeFiles.delete(job.label);
          }),
      ),
    );
  } finally {
    clearInterval(progressTimer);
  }

  printProgress(true);

  console.log('\n[FOLDERS] Per-folder results:');

  for (const [folderName, info] of stats.folders) {
    const target =
      folderName === '.' ? outputDir : path.join(outputDir, folderName);

    console.log(
      `[FOLDERS]   ${folderName}: ${info.alive}/${info.links} streams alive ` +
        `across ${info.files} file(s) -> ${target}`,
    );
  }

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
  console.log(`Progress interval: ${progressInterval}ms`);
}

main(inputDirectory, outputDirectory, quiet).catch((error) => {
  console.error('An error occurred:', error);
  process.exitCode = 1;
});
