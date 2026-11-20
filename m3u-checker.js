// m3u-checker.js
//
// Recursively scans the input folder for .m3u / .m3u8 files (any depth) and
// writes cleaned playlists to the output folder, preserving the sub-folder
// structure.
//
// Normal processing:
//   input/rock/a.m3u        -> output/rock/a.m3u
//
// Runtime-limit checkpointing:
//   input/rock/unfinished_a.m3u  contains only links not yet checked
//   output/rock/unfinished_a.m3u contains links already checked and found alive
//
// On the next run, matching unfinished_ files in BOTH folders are processed
// before new playlists. When a checkpoint finishes, its input file is removed
// and its output file is renamed back to the original name:
//   output/rock/unfinished_a.m3u -> output/rock/a.m3u
//
// Hidden folders (starting with ".") and node_modules are skipped, as is the
// output folder if it lives inside the input folder. Symlinked directories are
// not followed.
//
// Usage:
//   node m3u-checker.js
//   node m3u-checker.js input_folder/ output_folder/
//   node m3u-checker.js input_folder/ output_folder/ --quiet
//
// Optional environment variables (time values are supplied in milliseconds):
//   CONCURRENCY=100          max simultaneous HTTP link checks
//   FILE_CONCURRENCY=5       max playlists processed at the same time
//   LINK_TIMEOUT=8000        timeout for each HTTP request
//   MAX_REDIRECTS=3          maximum redirects followed per link
//   PROGRESS_INTERVAL=60000  milliseconds between progress reports (default)
//
// Runtime limit (for the GitHub Actions 6-hour job limit):
//   MAX_RUNTIME_MS = 5h 45m
//   After this duration, the script stops accepting new link checks. In-flight
//   checks are allowed to finish, then each unfinished playlist is checkpointed.
//   Checked links are removed from the input checkpoint, so later runs do not
//   need to repeat completed work.
//
// Processing order:
//   1. Paired unfinished_ checkpoints (smallest remaining first).
//   2. New playlists (smallest first).
//   Up to FILE_CONCURRENCY playlists run concurrently, sharing one global
//   CONCURRENCY limiter.
//
// Example:
//   CONCURRENCY=150 FILE_CONCURRENCY=5 LINK_TIMEOUT=8000 node m3u-checker.js

'use strict';

const fs = require('fs/promises');
const path = require('path');

// Duration units (JavaScript timers and Date.now() use milliseconds).
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

function readIntegerEnv(name, fallback, minimum = 1) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;

  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${name} must be an integer greater than or equal to ${minimum}.`);
  }
  return value;
}

const concurrencyLimit = readIntegerEnv('CONCURRENCY', 50);
const fileConcurrency = readIntegerEnv('FILE_CONCURRENCY', 5);
const linkTimeout = readIntegerEnv('LINK_TIMEOUT', 8 * SECOND);
const maxRedirects = readIntegerEnv('MAX_REDIRECTS', 3, 0);
const progressInterval = readIntegerEnv('PROGRESS_INTERVAL', 1 * MINUTE);

// Hard runtime limit for GitHub Actions (6h maximum). Stop 15 minutes early.
// const MAX_RUNTIME_MS = (5 * HOUR) + (45 * MINUTE);
const MAX_RUNTIME_MS = (15 * MINUTE);

const USER_AGENT = 'm3u-checker/1.0';
const UNFINISHED_PREFIX = 'unfinished_';

/** Set to true when MAX_RUNTIME_MS is reached; workers stop taking new links. */
let timeUp = false;

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
  // fileName -> { total, checked, alive }
  activeFiles: new Map(),
};

/**
 * Formats milliseconds as e.g. "1h 02m 05s", "3m 07s" or "12s".
 * @param {number} ms
 * @returns {string}
 */
function formatDuration(ms) {
  // Round to the nearest whole second, then split into readable units.
  const roundedMs = Math.max(0, Math.round(ms / SECOND) * SECOND);
  const hours = Math.floor(roundedMs / HOUR);
  const minutes = Math.floor((roundedMs % HOUR) / MINUTE);
  const seconds = Math.floor((roundedMs % MINUTE) / SECOND);

  if (hours > 0) {
    return `${hours}h ${String(minutes).padStart(2, '0')}m ${String(seconds).padStart(2, '0')}s`;
  }
  if (minutes > 0) {
    return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
  }
  return `${seconds}s`;
}

/**
 * Prints one progress report.
 * @param {boolean} final - true for the closing summary
 */
function printProgress(final = false) {
  const elapsedMs = Date.now() - stats.startTime;
  const elapsedSeconds = elapsedMs / SECOND;
  const percent = stats.totalLinks > 0
    ? ((stats.checked / stats.totalLinks) * 100).toFixed(1)
    : '0.0';
  const rate = elapsedSeconds > 0 ? stats.checked / elapsedSeconds : 0;

  let eta = 'estimating...';
  if (stats.totalLinks > 0 && rate > 0) {
    const remaining = stats.totalLinks - stats.checked;
    eta = remaining > 0 ? formatDuration((remaining / rate) * SECOND) : '0s';
  }

  const label = final ? 'FINAL' : 'PROGRESS';
  const lines = [
    '',
    `[${label}] Elapsed: ${formatDuration(elapsedMs)}`,
    `[${label}] Files: ${stats.filesDone}/${stats.totalFiles} done (${stats.filesParsed}/${stats.totalFiles} read)`,
    `[${label}] Links: ${stats.checked}/${stats.totalLinks} checked (${percent}%), ${stats.inFlight} in flight`,
    `[${label}] Results: ${stats.alive} alive, ${stats.timedOut} timed out, ${stats.invalid} invalid/unreachable, ${stats.httpError} HTTP errors`,
  ];

  if (!final) {
    lines.push(`[${label}] Speed: ${rate.toFixed(1)} links/s, ETA: ${eta}`);
    if (stats.activeFiles.size > 0) {
      const active = [...stats.activeFiles.entries()]
        .sort((a, b) => (b[1].total - b[1].checked) - (a[1].total - a[1].checked))
        .slice(0, 5);
      lines.push(`[${label}] Busiest unfinished files (${stats.activeFiles.size} in progress):`);
      for (const [name, info] of active) {
        lines.push(`[${label}] ${name}: ${info.checked}/${info.total} checked, ${info.alive} alive`);
      }
    }
  } else {
    lines.push(`[${label}] Average speed: ${rate.toFixed(1)} links/s`);
  }

  console.log(lines.join('\n'));
}

/**
 * Records the result of one checked link in the global statistics.
 * @param {number|string} status
 * @param {string} fileName
 */
function recordResult(status, fileName) {
  stats.checked++;
  const fileInfo = stats.activeFiles.get(fileName);
  if (fileInfo) fileInfo.checked++;

  if (typeof status === 'number' && status >= 200 && status < 300) {
    stats.alive++;
    if (fileInfo) fileInfo.alive++;
  } else if (status === 'timedout') {
    stats.timedOut++;
  } else if (status === 'invalid') {
    stats.invalid++;
  } else {
    stats.httpError++;
  }
}

/**
 * Creates a global concurrency limiter shared by all playlist workers.
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

  return (task) => new Promise((resolve, reject) => {
    queue.push({ task, resolve, reject });
    runNext();
  });
}

/**
 * Parses M3U content and extracts HTTP/HTTPS stream links.
 * @param {string} m3uContent
 * @returns {Array<{title: string, url: string, originalIndex: number, originalTitleLineIndex: number}>}
 */
function parseM3UContent(m3uContent) {
  const lines = m3uContent.split(/\r?\n/);
  const linksToProcess = [];
  let currentTitle = '';
  let currentTitleLineIndex = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
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
 * @param {string} url
 * @param {object} options
 * @returns {Promise<Response>}
 */
async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), linkTimeout);

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
 * Checks a URL with HEAD first. 405/501 fall back to a one-byte ranged GET.
 * @param {string} url
 * @returns {Promise<Response>}
 */
async function requestUrl(url) {
  let response = await fetchWithTimeout(url, { method: 'HEAD' });

  if (response.status === 405 || response.status === 501) {
    try {
      await response.body?.cancel();
    } catch {
      // Ignore body cancellation errors.
    }

    response = await fetchWithTimeout(url, {
      method: 'GET',
      headers: { Range: 'bytes=0-0' },
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
 * Checks one stream URL, following redirects.
 * @param {{title: string, url: string, originalIndex: number, originalTitleLineIndex: number}} item
 * @param {string} fileName
 * @param {boolean} quiet
 * @param {number} redirectCount
 * @returns {Promise<{url: string, status: number|string, finalUrl?: string}>}
 */
async function checkSingleLink(item, fileName, quiet = false, redirectCount = 0) {
  let response;

  try {
    response = await requestUrl(item.url);
    const isRedirect = response.status >= 300
      && response.status < 400
      && response.headers.has('location');

    if (isRedirect && redirectCount < maxRedirects) {
      const redirectUrl = response.headers.get('location');
      const absoluteRedirectUrl = new URL(redirectUrl, item.url).href;

      if (!quiet) {
        console.log(
          `[${fileName}] Redirect ${response.status}: ${item.url} -> ${absoluteRedirectUrl} (attempt ${redirectCount + 1}/${maxRedirects})`,
        );
      }

      // Release the redirect response before opening the next connection.
      try {
        await response.body?.cancel();
      } catch {
        // Ignore body cancellation errors.
      }
      response = null;

      return await checkSingleLink(
        { ...item, url: absoluteRedirectUrl },
        fileName,
        quiet,
        redirectCount + 1,
      );
    }

    if (response.status >= 200 && response.status < 300) {
      if (!quiet) console.log(`[${fileName}] Status ${response.status}: ${item.url}`);
      return { url: item.url, status: response.status, finalUrl: item.url };
    }

    if (!quiet) console.log(`[${fileName}] Status ${response.status}: ${item.url}`);
    return { url: item.url, status: response.status };
  } catch (error) {
    if (error?.name === 'AbortError') {
      if (!quiet) console.log(`[${fileName}] Timed out: ${item.url}`);
      return { url: item.url, status: 'timedout' };
    }

    if (!quiet) {
      console.log(`[${fileName}] Error (${error.message}): ${item.url}`);
    }
    return { url: item.url, status: 'invalid' };
  } finally {
    // Cancel response bodies so sockets are released instead of keeping the
    // Node.js event loop alive after the checker has finished.
    if (response?.body) {
      try {
        await response.body.cancel();
      } catch {
        // Ignore errors if the body was already consumed or canceled.
      }
    }
  }
}

/**
 * Processes links using the shared global limiter.
 * Every completed result is added to checkedIndices, including failed links.
 * Links waiting in the limiter when timeUp becomes true are NOT marked checked.
 * @param {Array} linksToProcess
 * @param {string} fileName
 * @param {boolean} quiet
 * @param {(task: () => Promise<any>) => Promise<any>} limiter
 * @returns {Promise<{validLinks: Map<number, {titleLine: string, urlLine: string}>, checkedIndices: Set<number>}>}
 */
async function processLinks(linksToProcess, fileName, quiet, limiter) {
  const validLinks = new Map();
  const checkedIndices = new Set();
  let nextIndex = 0;

  async function worker() {
    while (true) {
      if (timeUp) return;

      const currentIndex = nextIndex++;
      if (currentIndex >= linksToProcess.length) return;
      const item = linksToProcess[currentIndex];

      const result = await limiter(async () => {
        // A queued task must remain unchecked if the time limit has fired
        // before it receives a global request slot.
        if (timeUp) return null;

        stats.inFlight++;
        try {
          return await checkSingleLink(item, fileName, quiet);
        } finally {
          stats.inFlight--;
        }
      });

      if (result === null) return;

      checkedIndices.add(item.originalIndex);
      recordResult(result.status, fileName);

      if (typeof result.status === 'number' && result.status >= 200 && result.status < 300) {
        validLinks.set(item.originalIndex, {
          titleLine: item.title,
          urlLine: result.finalUrl || item.url,
        });
      }
    }
  }

  const workerCount = Math.min(concurrencyLimit, linksToProcess.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return { validLinks, checkedIndices };
}

/**
 * Finds the next HTTP/HTTPS URL after an #EXTINF line, stopping at another
 * #EXTINF if one appears first.
 * @param {string[]} lines
 * @param {number} titleIndex
 * @returns {number}
 */
function findNextUrlIndex(lines, titleIndex) {
  for (let i = titleIndex + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith('#EXTINF')) return -1;
    if (line.startsWith('http://') || line.startsWith('https://')) return i;
  }
  return -1;
}

/**
 * Generates a complete cleaned playlist from one original input file.
 * Non-stream metadata/comments are preserved where practical.
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

    if (line.length === 0 || line.startsWith('#EXTM3U')) continue;

    if (line.startsWith('#EXTINF')) {
      const urlIndex = findNextUrlIndex(originalLines, i);
      if (urlIndex !== -1 && validLinks.has(urlIndex)) {
        const { titleLine, urlLine } = validLinks.get(urlIndex);
        outputLines.push(titleLine);

        for (let j = i + 1; j < urlIndex; j++) {
          const intermediateLine = originalLines[j].trim();
          if (
            intermediateLine.length > 0
            && !intermediateLine.startsWith('http://')
            && !intermediateLine.startsWith('https://')
            && !intermediateLine.startsWith('#EXTINF')
          ) {
            outputLines.push(intermediateLine);
          }
        }

        outputLines.push(urlLine);
        i = urlIndex;
      } else if (urlIndex !== -1) {
        // Skip a checked-invalid or unchecked entry in this output.
        i = urlIndex;
      }
      continue;
    }

    if (line.startsWith('http://') || line.startsWith('https://')) {
      if (validLinks.has(i)) outputLines.push(validLinks.get(i).urlLine);
      continue;
    }

    outputLines.push(line);
  }

  return `${outputLines.join('\n')}\n`;
}

/**
 * Builds only the newly validated stream entries. This is used when resuming:
 * the accumulated output already contains earlier successful entries, so
 * copying all metadata from the remaining input again would duplicate it.
 * @param {string} m3uContent
 * @param {Map<number, {titleLine: string, urlLine: string}>} validLinks
 * @returns {string}
 */
function generateValidEntriesOnly(m3uContent, validLinks) {
  const lines = m3uContent.split(/\r?\n/);
  const outputLines = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    if (line.startsWith('#EXTINF')) {
      const urlIndex = findNextUrlIndex(lines, i);
      if (urlIndex !== -1 && validLinks.has(urlIndex)) {
        const { titleLine, urlLine } = validLinks.get(urlIndex);
        outputLines.push(titleLine);

        for (let j = i + 1; j < urlIndex; j++) {
          const intermediateLine = lines[j].trim();
          if (
            intermediateLine.length > 0
            && !intermediateLine.startsWith('http://')
            && !intermediateLine.startsWith('https://')
            && !intermediateLine.startsWith('#EXTINF')
          ) {
            outputLines.push(intermediateLine);
          }
        }

        outputLines.push(urlLine);
        i = urlIndex;
      } else if (urlIndex !== -1) {
        i = urlIndex;
      }
      continue;
    }

    if ((line.startsWith('http://') || line.startsWith('https://')) && validLinks.has(i)) {
      outputLines.push(validLinks.get(i).urlLine);
    }
  }

  return outputLines.length > 0 ? `${outputLines.join('\n')}\n` : '';
}

/**
 * Removes every completed URL entry from an input playlist, regardless of
 * whether the link was alive or dead. Unchecked entries remain intact.
 * @param {string} originalM3uContent
 * @param {Set<number>} checkedIndices
 * @returns {string}
 */
function removeCheckedEntries(originalM3uContent, checkedIndices) {
  const lines = originalM3uContent.split(/\r?\n/);
  const remainingLines = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    if (line.startsWith('#EXTINF')) {
      const urlIndex = findNextUrlIndex(lines, i);
      if (urlIndex !== -1) {
        if (!checkedIndices.has(urlIndex)) {
          for (let j = i; j <= urlIndex; j++) remainingLines.push(lines[j]);
        }
        i = urlIndex;
        continue;
      }
    }

    if (line.startsWith('http://') || line.startsWith('https://')) {
      if (!checkedIndices.has(i)) remainingLines.push(lines[i]);
      continue;
    }

    remainingLines.push(lines[i]);
  }

  // Keep a valid M3U header even if the source did not have one.
  const nonEmpty = remainingLines.some((line) => line.trim().length > 0);
  if (!nonEmpty) return '#EXTM3U\n';
  if (!remainingLines.some((line) => line.trim().startsWith('#EXTM3U'))) {
    remainingLines.unshift('#EXTM3U');
  }
  return `${remainingLines.join('\n').replace(/\n+$/g, '')}\n`;
}

/**
 * Appends newly validated entries to a previously checkpointed output file.
 * @param {string} existingOutput
 * @param {string} newEntries
 * @returns {string}
 */
function appendM3UEntries(existingOutput, newEntries) {
  const base = existingOutput.trim().length > 0
    ? existingOutput.replace(/\s+$/g, '')
    : '#EXTM3U';
  if (!newEntries) return `${base}\n`;
  return `${base}\n${newEntries.replace(/^\s+|\s+$/g, '')}\n`;
}

/**
 * Returns true when a file exists. Other filesystem errors are propagated.
 * @param {string} filePath
 * @returns {Promise<boolean>}
 */
async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

/**
 * Atomically writes a file through a temporary sibling file.
 * The rename replacement fallback also supports Windows, where renaming over
 * an existing destination can fail.
 * @param {string} filePath
 * @param {string} content
 */
async function writeFileAtomic(filePath, content) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;

  try {
    await fs.writeFile(tempPath, content, 'utf8');
    try {
      await fs.rename(tempPath, filePath);
    } catch (error) {
      if (error.code !== 'EEXIST' && error.code !== 'EPERM' && error.code !== 'EACCES') {
        throw error;
      }
      await fs.rm(filePath, { force: true });
      await fs.rename(tempPath, filePath);
    }
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}

/**
 * Moves a file, replacing the destination when needed.
 * @param {string} sourcePath
 * @param {string} destinationPath
 */
async function moveReplacing(sourcePath, destinationPath) {
  await fs.mkdir(path.dirname(destinationPath), { recursive: true });
  try {
    await fs.rename(sourcePath, destinationPath);
  } catch (error) {
    if (error.code !== 'EEXIST' && error.code !== 'EPERM' && error.code !== 'EACCES') {
      throw error;
    }
    await fs.rm(destinationPath, { force: true });
    await fs.rename(sourcePath, destinationPath);
  }
}

/**
 * Adds the unfinished_ prefix to a relative file path's basename.
 * @param {string} fileName
 * @returns {string}
 */
function addUnfinishedPrefix(fileName) {
  const directory = path.dirname(fileName);
  const baseName = path.basename(fileName);
  return path.join(directory, `${UNFINISHED_PREFIX}${baseName}`);
}

/**
 * Removes exactly one unfinished_ prefix from a relative file path's basename.
 * @param {string} fileName
 * @returns {string}
 */
function removeUnfinishedPrefix(fileName) {
  const directory = path.dirname(fileName);
  const baseName = path.basename(fileName);
  return path.join(directory, baseName.slice(UNFINISHED_PREFIX.length));
}

/**
 * Recursively collects every .m3u / .m3u8 file below rootDir.
 * Returned paths are relative to rootDir and use "/" separators.
 * @param {string} rootDir
 * @param {string[]} skipDirs
 * @returns {Promise<string[]>}
 */
async function collectM3UFiles(rootDir, skipDirs = []) {
  const results = [];
  const skip = new Set(skipDirs.map((dir) => path.resolve(dir)));

  async function walk(currentDir) {
    const entries = await fs.readdir(currentDir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);

      if (entry.isDirectory()) {
        if (
          entry.name.startsWith('.')
          || entry.name === 'node_modules'
          || skip.has(path.resolve(fullPath))
        ) {
          continue;
        }
        await walk(fullPath);
      } else if (entry.isFile() && /\.m3u8?$/i.test(entry.name)) {
        results.push(path.relative(rootDir, fullPath).split(path.sep).join('/'));
      }
    }
  }

  await walk(rootDir);
  return results;
}

/**
 * Repairs a narrow interruption window around finalization/checkpoint creation:
 * - output unfinished file + original input still present: the input was never
 *   renamed, so discard the orphan partial output and safely recheck the source.
 * - output unfinished file + no corresponding input at all: input removal
 *   already happened, so promote the output to its final name.
 * A correctly paired checkpoint is left untouched.
 * @param {string} inputDir
 * @param {string} outputDir
 */
async function recoverOrphanedOutputCheckpoints(inputDir, outputDir) {
  const outputFiles = await collectM3UFiles(outputDir);

  for (const outputFile of outputFiles) {
    if (!path.basename(outputFile).startsWith(UNFINISHED_PREFIX)) continue;

    const unfinishedInputPath = path.join(inputDir, outputFile);
    const originalRelativePath = removeUnfinishedPrefix(outputFile);
    const originalInputPath = path.join(inputDir, originalRelativePath);
    const partialOutputPath = path.join(outputDir, outputFile);

    if (await fileExists(unfinishedInputPath)) {
      // If the process crashed after creating the checkpoint input but before
      // deleting the original, the original is now a stale duplicate. The
      // checkpoint pair is the authoritative, already-progressed copy.
      if (await fileExists(originalInputPath)) {
        await fs.rm(originalInputPath, { force: true });
      }
      continue;
    }

    if (await fileExists(originalInputPath)) {
      // The first checkpoint did not finish moving the input. The original is
      // still complete, so discard the orphan and let the next scan recheck it.
      await fs.rm(partialOutputPath, { force: true });
      continue;
    }

    // The input has already gone; this is most likely a crash between deleting
    // the input checkpoint and renaming the completed output checkpoint.
    const finalOutputPath = path.join(outputDir, originalRelativePath);
    await moveReplacing(partialOutputPath, finalOutputPath);
    console.log(`[RECOVERY] Finalized orphaned checkpoint: ${finalOutputPath}`);
  }
}

/**
 * Finalizes a resumed playlist after all remaining links have been checked.
 * @param {string} inputPath
 * @param {string} partialOutputPath
 * @param {string} finalOutputPath
 * @param {string} outputContent
 * @param {string} fileName
 * @param {boolean} quiet
 */
async function finalizeResumedFile(
  inputPath,
  partialOutputPath,
  finalOutputPath,
  outputContent,
  fileName,
  quiet,
) {
  const hasAliveStreams = parseM3UContent(outputContent).length > 0;

  if (!hasAliveStreams) {
    await fs.rm(inputPath, { force: true });
    await fs.rm(partialOutputPath, { force: true });
    if (!quiet) console.log(`[${fileName}] Complete. No valid streams; removed checkpoint files.`);
    else console.log(`${fileName} checked - 0 valid streams; checkpoint removed`);
    return;
  }

  // Save the complete accumulated output before removing the input checkpoint.
  await writeFileAtomic(partialOutputPath, outputContent);
  await fs.rm(inputPath, { force: true });
  await moveReplacing(partialOutputPath, finalOutputPath);

  if (!quiet) console.log(`[${fileName}] Complete. Final output saved to "${finalOutputPath}"`);
  else console.log(`${fileName} checked - ${parseM3UContent(outputContent).length} valid streams; finalized`);
}

/**
 * Processes one playlist. For a resumed file, fileName is the relative path
 * including unfinished_; otherwise it is the original relative path.
 * @param {string} inputDir
 * @param {string} outputDir
 * @param {{fileName: string, isResuming: boolean}}
 * @param {boolean} quiet
 * @param {(task: () => Promise<any>) => Promise<any>} limiter
 */
async function processFile(inputDir, outputDir, fileInfo, quiet, limiter) {
  const { fileName, isResuming } = fileInfo;
  if (timeUp) {
    if (!quiet) console.log(`[${fileName}] Skipped (runtime limit already reached).`);
    return;
  }

  const inputPath = path.join(inputDir, fileName);
  const partialRelativePath = isResuming ? fileName : addUnfinishedPrefix(fileName);
  const finalRelativePath = isResuming ? removeUnfinishedPrefix(fileName) : fileName;
  const partialInputPath = path.join(inputDir, partialRelativePath);
  const partialOutputPath = path.join(outputDir, partialRelativePath);
  const finalOutputPath = path.join(outputDir, finalRelativePath);

  const originalM3uContent = await fs.readFile(inputPath, 'utf8');
  const linksToProcess = parseM3UContent(originalM3uContent);

  stats.filesParsed++;
  stats.activeFiles.set(fileName, {
    total: linksToProcess.length,
    checked: 0,
    alive: 0,
  });

  if (!quiet) {
    console.log(
      `[${fileName}] ${isResuming ? 'Resuming' : 'Found'} ${linksToProcess.length} remaining stream links.`,
    );
  }

  // A paired checkpoint's output contains previously validated entries.
  let existingPartialOutput = '';
  let hasExistingPartialOutput = false;
  if (isResuming && await fileExists(partialOutputPath)) {
    existingPartialOutput = await fs.readFile(partialOutputPath, 'utf8');
    hasExistingPartialOutput = true;
  }

  if (linksToProcess.length === 0) {
    if (isResuming) {
      await finalizeResumedFile(
        inputPath,
        partialOutputPath,
        finalOutputPath,
        existingPartialOutput,
        fileName,
        quiet,
      );
    } else {
      const outputM3uContent = generateOutputM3U(originalM3uContent, new Map());
      if (outputM3uContent.trim() !== '#EXTM3U') {
        await writeFileAtomic(finalOutputPath, outputM3uContent);
        if (!quiet) console.log(`[${fileName}] No stream links found. Saved metadata output.`);
      } else if (!quiet) {
        console.log(`[${fileName}] No stream links or meaningful content. Skipped.`);
      }
      await fs.rm(inputPath, { force: true });
      if (quiet) console.log(`${fileName} checked - 0/0 streams were alive`);
    }
    return;
  }

  const { validLinks, checkedIndices } = await processLinks(
    linksToProcess,
    fileName,
    quiet,
    limiter,
  );

  const currentFileStats = stats.activeFiles.get(fileName);
  const fullyChecked = checkedIndices.size === linksToProcess.length;

  // Update the accumulated output with successful links from this run.
  let accumulatedOutput;
  if (hasExistingPartialOutput) {
    const newEntries = generateValidEntriesOnly(originalM3uContent, validLinks);
    accumulatedOutput = appendM3UEntries(existingPartialOutput, newEntries);
  } else {
    accumulatedOutput = generateOutputM3U(originalM3uContent, validLinks);
  }

  if (!fullyChecked) {
    // Time limit reached with unchecked links remaining. Save the successes
    // first, then replace the input with only links that were not completed.
    // In-flight requests are awaited by processLinks and are included in
    // checkedIndices; requests still waiting in the limiter remain in input.
    const remainingContent = removeCheckedEntries(originalM3uContent, checkedIndices);

    await writeFileAtomic(partialOutputPath, accumulatedOutput);
    await writeFileAtomic(partialInputPath, remainingContent);

    if (path.resolve(inputPath) !== path.resolve(partialInputPath)) {
      await fs.rm(inputPath, { force: true });
    }

    const checkedCount = currentFileStats ? currentFileStats.checked : checkedIndices.size;
    if (!quiet) {
      console.log(
        `[${fileName}] Checkpoint saved: ${checkedCount}/${linksToProcess.length} checked; `
        + `${linksToProcess.length - checkedCount} links remain. `
        + `Saved as "${partialRelativePath}" in input and output.`,
      );
    } else {
      console.log(
        `${partialRelativePath} checkpointed - ${checkedCount}/${linksToProcess.length} checked, `
        + `${linksToProcess.length - checkedCount} remain`,
      );
    }
    return;
  }

  const newlyAlive = validLinks.size;
  const totalAlive = parseM3UContent(accumulatedOutput).length;

  if (quiet) {
    console.log(
      `${fileName} checked - ${newlyAlive}/${linksToProcess.length} remaining streams were alive`,
    );
  } else {
    console.log(
      `[${fileName}] Complete: ${newlyAlive}/${linksToProcess.length} remaining streams alive.`,
    );
  }

  if (isResuming) {
    await finalizeResumedFile(
      inputPath,
      partialOutputPath,
      finalOutputPath,
      accumulatedOutput,
      fileName,
      quiet,
    );
    return;
  }

  if (totalAlive === 0) {
    if (!quiet) console.log(`[${fileName}] No valid streams. Output skipped.`);
    await fs.rm(inputPath, { force: true });
    return;
  }

  await writeFileAtomic(finalOutputPath, accumulatedOutput);
  await fs.rm(inputPath, { force: true });
  if (!quiet) console.log(`[${fileName}] Saved to "${finalOutputPath}" and removed from input.`);
}

/**
 * Main function.
 * @param {string} inputDir
 * @param {string} outputDir
 * @param {boolean} quiet
 */
async function main(inputDir, outputDir, quiet = false) {
  const resolvedInputDir = path.resolve(inputDir);
  const resolvedOutputDir = path.resolve(outputDir);

  if (resolvedInputDir === resolvedOutputDir) {
    throw new Error('Input and output directories must be different.');
  }

  await fs.mkdir(outputDir, { recursive: true });

  // Repair an interrupted finalization before collecting this run's work.
  await recoverOrphanedOutputCheckpoints(inputDir, outputDir);

  const m3uFiles = await collectM3UFiles(inputDir, [outputDir]);
  if (m3uFiles.length === 0) {
    if (!quiet) console.log(`No .m3u or .m3u8 files found in "${inputDir}" (searched recursively)`);
    return;
  }

  if (!quiet) {
    console.log(`Counting stream links in ${m3uFiles.length} files to prioritise checkpoints and smaller playlists...`);
  }

  const filesWithCounts = await Promise.all(m3uFiles.map(async (fileName) => {
    const fullPath = path.join(inputDir, fileName);
    const content = await fs.readFile(fullPath, 'utf8');
    const linkCount = parseM3UContent(content).length;
    const hasUnfinishedPrefix = path.basename(fileName).startsWith(UNFINISHED_PREFIX);
    const matchingPartialOutput = hasUnfinishedPrefix
      ? path.join(outputDir, fileName)
      : null;
    const isResuming = Boolean(matchingPartialOutput && await fileExists(matchingPartialOutput));

    return { fileName, linkCount, isResuming };
  }));

  // Paired unfinished checkpoints always take priority over fresh playlists.
  filesWithCounts.sort((a, b) => {
    if (a.isResuming !== b.isResuming) return a.isResuming ? -1 : 1;
    return a.linkCount - b.linkCount || a.fileName.localeCompare(b.fileName);
  });

  const sortedM3uFiles = filesWithCounts.map((file) => file.fileName);
  stats.totalLinks = filesWithCounts.reduce((sum, file) => sum + file.linkCount, 0);

  if (!quiet) {
    const smallest = filesWithCounts[0];
    const largest = filesWithCounts[filesWithCounts.length - 1];
    const resumeCount = filesWithCounts.filter((file) => file.isResuming).length;
    console.log(
      `Found ${sortedM3uFiles.length} M3U files (${resumeCount} unfinished checkpoints). `
      + `Smallest: ${smallest.linkCount} links (${smallest.fileName}); `
      + `largest: ${largest.linkCount} links (${largest.fileName}).`,
    );
  }

  console.log(
    `Found ${sortedM3uFiles.length} M3U files (recursive). `
    + `Link concurrency: ${concurrencyLimit}. `
    + `File concurrency: ${fileConcurrency}. `
    + `Timeout: ${linkTimeout}ms. `
    + `Max runtime: ${formatDuration(MAX_RUNTIME_MS)}. `
    + `Order: unfinished checkpoints → smallest → largest.`,
  );

  stats.totalFiles = sortedM3uFiles.length;
  stats.startTime = Date.now();

  const progressTimer = setInterval(() => printProgress(false), progressInterval);
  const timeUpTimer = setTimeout(() => {
    timeUp = true;
    console.log(
      `\n[TIME LIMIT] Maximum runtime of ${formatDuration(MAX_RUNTIME_MS)} reached. `
      + `Stopping new link checks. In-flight requests will finish, then incomplete playlists will be checkpointed.`,
    );
    printProgress(false);
  }, MAX_RUNTIME_MS);

  const limiter = createLimiter(concurrencyLimit);

  try {
    let nextIndex = 0;
    const workers = [];

    async function fileWorker() {
      while (true) {
        if (timeUp) return;
        const index = nextIndex++;
        if (index >= filesWithCounts.length) return;

        const fileInfo = filesWithCounts[index];
        try {
          await processFile(inputDir, outputDir, fileInfo, quiet, limiter);
        } finally {
          stats.filesDone++;
          stats.activeFiles.delete(fileInfo.fileName);
        }
      }
    }

    const workerCount = Math.min(fileConcurrency, sortedM3uFiles.length);
    for (let i = 0; i < workerCount; i++) workers.push(fileWorker());
    await Promise.all(workers);
  } finally {
    clearInterval(progressTimer);
    clearTimeout(timeUpTimer);
  }

  printProgress(true);

  if (timeUp) {
    console.log('\n--- Runtime limit reached. Unfinished playlists were checkpointed for the next run ---');
  } else if (!quiet) {
    console.log('\n--- All M3U files processed ---');
  }
}

// Parse command-line arguments.
let quiet = false;
const filteredArgs = [];
for (const arg of process.argv.slice(2)) {
  if (arg === '--quiet') quiet = true;
  else filteredArgs.push(arg);
}

const inputDirectory = filteredArgs[0] || 'm3u-files';
const outputDirectory = filteredArgs[1] || 'm3u-checked';

if (!quiet) {
  console.log('Starting M3U Link Checker...');
  console.log(`Input Directory: ${inputDirectory}`);
  console.log(`Output Directory: ${outputDirectory}`);
  console.log(`Link concurrency: ${concurrencyLimit}`);
  console.log(`File concurrency: ${fileConcurrency}`);
  console.log(`Timeout: ${linkTimeout}ms`);
  console.log(`Progress interval: ${progressInterval}ms`);
  console.log(`Max runtime: ${formatDuration(MAX_RUNTIME_MS)}`);
}

main(inputDirectory, outputDirectory, quiet).catch((error) => {
  console.error('An error occurred:', error);
  process.exitCode = 1;
});
