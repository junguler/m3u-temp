// m3u-checker.js
//
// Usage:
//
//   node m3u-checker.js                                   (m3u-files -> m3u-checked)
//   node m3u-checker.js input_folder/ output_folder/
//   node m3u-checker.js input_folder/ output_folder/ --quiet
//
// How it avoids false negatives while staying fast:
//
//   1. Pass 1 runs at high concurrency (fast). Every unique URL is checked once,
//      even if it appears in many files.
//   2. Anything that failed for a *possibly temporary* reason (timeout, network
//      error, DNS hiccup, 429, 5xx) is re-checked in retry passes with lower
//      concurrency, a longer timeout and GET instead of HEAD.
//   3. Only definitive answers (404, 410, 403 after GET, bad URL, ...) are dead
//      immediately. A link is only removed after surviving the retry passes.
//   4. A per-host cap stops big stream servers from rate-limiting you.
//
// Optional environment variables (defaults in brackets):
//
//   CONCURRENCY=100          global parallel requests in pass 1
//   PER_HOST=8               max parallel requests to the same host in pass 1
//   LINK_TIMEOUT=8000        per-request timeout in ms in pass 1
//   MAX_REDIRECTS=5          redirects followed per link
//   RETRY_PASSES=2           extra passes for links that failed temporarily (0 = off)
//   RETRY_CONCURRENCY=20     global parallel requests in retry passes
//   RETRY_PER_HOST=3         per-host parallel requests in retry passes
//   RETRY_TIMEOUT=15000      per-request timeout in ms in retry passes
//   RETRY_DELAY=3000         pause in ms before each retry pass
//   DEDUPE=1                 remove duplicate URLs within a playlist (0 = keep)
//   REWRITE_REDIRECTS=1      replace a URL only if it permanently (301/308) redirects
//   USER_AGENT="..."         override the User-Agent header
//
// Example:
//
//   CONCURRENCY=150 RETRY_PASSES=3 node m3u-checker.js in/ out/ --quiet

// DNS lookups go through libuv's thread pool (default size 4). With lots of
// requests in flight they queue up and count against the timeout, which causes
// false "timed out" results. This must be set before the pool is first used.
process.env.UV_THREADPOOL_SIZE ||= '64';

const fs = require('fs/promises');
const path = require('path');

function envNumber(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

const CONCURRENCY = Math.max(1, envNumber('CONCURRENCY', 100));
const PER_HOST = Math.max(1, envNumber('PER_HOST', 8));
const LINK_TIMEOUT = Math.max(1, envNumber('LINK_TIMEOUT', 8000));
const MAX_REDIRECTS = envNumber('MAX_REDIRECTS', 5);
const RETRY_PASSES = envNumber('RETRY_PASSES', 2);
const RETRY_CONCURRENCY = Math.max(1, envNumber('RETRY_CONCURRENCY', 20));
const RETRY_PER_HOST = Math.max(1, envNumber('RETRY_PER_HOST', 3));
const RETRY_TIMEOUT = Math.max(1, envNumber('RETRY_TIMEOUT', 15000));
const RETRY_DELAY = envNumber('RETRY_DELAY', 3000);
const DEDUPE = process.env.DEDUPE !== '0';
const REWRITE_REDIRECTS = process.env.REWRITE_REDIRECTS !== '0';
const USER_AGENT =
  process.env.USER_AGENT || 'VLC/3.0.20 LibVLC/3.0.20';

const HEARTBEAT_MS = 30000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const isUrlLine = (line) => /^https?:\/\//i.test(line);

// ---------------------------------------------------------------------------
// Concurrency limiter
// ---------------------------------------------------------------------------

/**
 * Creates a limiter that runs at most `limit` tasks at the same time.
 * @param {number} limit
 * @returns {(task: () => Promise<any>) => Promise<any>}
 */
function createLimiter(limit) {
  const queue = [];
  let head = 0;
  let active = 0;

  function runNext() {
    while (active < limit && head < queue.length) {
      const { task, resolve, reject } = queue[head];
      queue[head++] = undefined; // let it be garbage collected

      // Compact the queue occasionally so it doesn't grow forever.
      if (head > 1024 && head * 2 > queue.length) {
        queue.splice(0, head);
        head = 0;
      }

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

// ---------------------------------------------------------------------------
// Checking a single link
// ---------------------------------------------------------------------------

/**
 * One HTTP request with a timeout. Redirects are never followed automatically.
 */
async function request(url, method, timeout) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    return await fetch(url, {
      method,
      signal: controller.signal,
      redirect: 'manual',
      headers: {
        'User-Agent': USER_AGENT,
        Accept: '*/*',
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * GET that never downloads the stream: we only need the status and headers.
 * No Range header on purpose, some servers answer it with 400/416.
 */
async function requestGet(url, timeout) {
  const response = await request(url, 'GET', timeout);

  // Fire and forget, awaiting cancel() can hang on live streams.
  try {
    response.body?.cancel().catch(() => {});
  } catch {
    // ignore
  }

  return response;
}

/**
 * HEAD first (cheap). Falls back to GET when HEAD is rejected or the
 * connection errors, because many stream servers handle HEAD badly.
 * With getFirst (retry passes) it goes straight to GET.
 */
async function probe(url, timeout, getFirst) {
  if (getFirst) {
    return requestGet(url, timeout);
  }

  let response;

  try {
    response = await request(url, 'HEAD', timeout);
  } catch (error) {
    // A timeout means the server is slow, not that HEAD is unsupported.
    // The retry passes will try it again using GET.
    if (error?.name === 'AbortError') throw error;
    return requestGet(url, timeout);
  }

  if (response.status >= 400 && response.status !== 410) {
    return requestGet(url, timeout);
  }

  return response;
}

function describeError(error) {
  if (error?.name === 'AbortError') return 'timeout';
  return error?.cause?.code || error?.code || error?.message || 'error';
}

/**
 * Checks one URL, following redirects.
 *
 * state:
 *   'alive'  - got a 2xx response
 *   'dead'   - definitive failure, no point retrying
 *   'retry'  - failure that might be temporary
 *
 * @param {string} startUrl
 * @param {{timeout: number, getFirst: boolean}} opts
 * @returns {Promise<{
 *   state: 'alive'|'dead'|'retry',
 *   reason: string,
 *   finalUrl?: string,
 *   permanent?: boolean
 * }>}
 */
async function checkLink(startUrl, opts) {
  try {
    new URL(startUrl);
  } catch {
    return { state: 'dead', reason: 'invalid-url' };
  }

  let url = startUrl;
  let permanent = true;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let response;

    try {
      response = await probe(url, opts.timeout, opts.getFirst);
    } catch (error) {
      return { state: 'retry', reason: describeError(error) };
    }

    const status = response.status;

    if (status >= 300 && status < 400 && response.headers.has('location')) {
      if (hop === MAX_REDIRECTS) {
        return { state: 'dead', reason: 'too-many-redirects' };
      }

      let next;
      try {
        next = new URL(response.headers.get('location'), url);
      } catch {
        return { state: 'dead', reason: 'bad-redirect' };
      }

      if (next.protocol !== 'http:' && next.protocol !== 'https:') {
        return { state: 'dead', reason: `redirect-to-${next.protocol}` };
      }

      if (status !== 301 && status !== 308) permanent = false;

      url = next.href;
      continue;
    }

    if (status >= 200 && status < 300) {
      return {
        state: 'alive',
        reason: String(status),
        finalUrl: url,
        permanent: permanent && url !== startUrl,
      };
    }

    if (status === 408 || status === 425 || status === 429 || status >= 500) {
      return { state: 'retry', reason: String(status) };
    }

    return { state: 'dead', reason: String(status) };
  }

  return { state: 'dead', reason: 'too-many-redirects' };
}

// ---------------------------------------------------------------------------
// Running a pass over many URLs
// ---------------------------------------------------------------------------

function hostOf(url) {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return '';
  }
}

/**
 * Checks every URL once, with a global cap and a per-host cap.
 * The host slot is taken first so global slots are never wasted waiting
 * on a busy host.
 *
 * @param {string[]} urls
 * @param {{concurrency: number, perHost: number, timeout: number,
 *          getFirst: boolean, label: string, quiet: boolean}} opts
 * @returns {Promise<Map<string, object>>}
 */
async function runPass(urls, opts) {
  const globalLimiter = createLimiter(opts.concurrency);
  const hostLimiters = new Map();
  const results = new Map();
  let done = 0;

  function limiterForHost(host) {
    let limiter = hostLimiters.get(host);
    if (!limiter) {
      limiter = createLimiter(opts.perHost);
      hostLimiters.set(host, limiter);
    }
    return limiter;
  }

  const heartbeat = setInterval(() => {
    console.log(`  ${opts.label}: ${done}/${urls.length} checked...`);
  }, HEARTBEAT_MS);
  heartbeat.unref();

  try {
    await Promise.all(
      urls.map((url) =>
        limiterForHost(hostOf(url))(() =>
          globalLimiter(async () => {
            const result = await checkLink(url, opts);
            results.set(url, result);
            done++;

            if (!opts.quiet) {
              console.log(`  [${result.state} ${result.reason}] ${url}`);
            }
          }),
        ),
      ),
    );
  } finally {
    clearInterval(heartbeat);
  }

  return results;
}

/**
 * Pass 1 plus retry passes. Returns the final result for every URL.
 * Anything still 'retry' after the last pass is treated as dead.
 */
async function checkAllUrls(urls, quiet) {
  const results = await runPass(urls, {
    concurrency: CONCURRENCY,
    perHost: PER_HOST,
    timeout: LINK_TIMEOUT,
    getFirst: false,
    label: 'pass 1',
    quiet,
  });

  const count = (state) =>
    [...results.values()].filter((r) => r.state === state).length;

  console.log(
    `Pass 1 done: ${count('alive')} alive, ${count('dead')} dead, ` +
      `${count('retry')} to re-check.`,
  );

  let rescued = 0;

  for (let pass = 1; pass <= RETRY_PASSES; pass++) {
    const retryUrls = [...results.entries()]
      .filter(([, result]) => result.state === 'retry')
      .map(([url]) => url);

    if (retryUrls.length === 0) break;

    console.log(
      `Retry pass ${pass}/${RETRY_PASSES}: re-checking ${retryUrls.length} ` +
        `links (concurrency ${RETRY_CONCURRENCY}, timeout ${RETRY_TIMEOUT}ms)...`,
    );

    await sleep(RETRY_DELAY);

    const again = await runPass(retryUrls, {
      concurrency: RETRY_CONCURRENCY,
      perHost: RETRY_PER_HOST,
      timeout: RETRY_TIMEOUT,
      getFirst: true,
      label: `retry ${pass}`,
      quiet,
    });

    let rescuedNow = 0;
    for (const [url, result] of again) {
      results.set(url, result);
      if (result.state === 'alive') rescuedNow++;
    }

    rescued += rescuedNow;
    console.log(`Retry pass ${pass} done: ${rescuedNow} links were alive after all.`);
  }

  return { results, rescued };
}

// ---------------------------------------------------------------------------
// Playlist handling
// ---------------------------------------------------------------------------

/**
 * Extracts every stream URL in a playlist.
 * @param {string} content
 * @returns {string[]}
 */
function extractUrls(content) {
  const urls = [];
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (isUrlLine(line)) urls.push(line);
  }
  return urls;
}

/**
 * Builds the cleaned playlist.
 *
 * - An #EXTINF line and any #tag lines after it (#EXTGRP, #EXTVLCOPT, ...)
 *   stay attached to the URL that follows and are kept or dropped together.
 * - Titles are never lost, even if two entries share the same #EXTINF line.
 * - Duplicate URLs are removed (first occurrence wins) when DEDUPE is on.
 *
 * @param {string} content
 * @param {Map<string, object>} results
 * @returns {{text: string, total: number, alive: number, duplicates: number}}
 */
function buildOutput(content, results) {
  const out = ['#EXTM3U'];
  const seen = new Set();

  let pending = [];
  let total = 0;
  let alive = 0;
  let duplicates = 0;

  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();

    if (line.length === 0 || line.startsWith('#EXTM3U')) continue;

    if (isUrlLine(line)) {
      total++;
      const result = results.get(line);

      if (result && result.state === 'alive') {
        alive++;

        const finalUrl =
          REWRITE_REDIRECTS && result.permanent ? result.finalUrl : line;

        if (DEDUPE && seen.has(finalUrl)) {
          duplicates++;
        } else {
          seen.add(finalUrl);
          out.push(...pending, finalUrl);
        }
      }

      pending = [];
      continue;
    }

    if (line.startsWith('#EXTINF')) {
      // A previous #EXTINF that never got a URL is dropped.
      pending = [line];
      continue;
    }

    if (line.startsWith('#')) {
      if (pending.length > 0) {
        pending.push(line);
      } else {
        out.push(line);
      }
      continue;
    }

    // Anything else (rtmp://, relative paths, ...) is kept as it is.
    out.push(...pending, line);
    pending = [];
  }

  return { text: `${out.join('\n')}\n`, total, alive, duplicates };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(inputDir, outputDir, quiet) {
  const startedAt = Date.now();

  await fs.mkdir(outputDir, { recursive: true });

  const files = (await fs.readdir(inputDir))
    .filter((file) => {
      const lower = file.toLowerCase();
      return lower.endsWith('.m3u') || lower.endsWith('.m3u8');
    })
    .sort();

  if (files.length === 0) {
    console.log(`No .m3u or .m3u8 files found in "${inputDir}"`);
    return;
  }

  // Read everything and collect the unique URLs across all files.
  const playlists = [];
  const uniqueUrls = new Set();

  for (const fileName of files) {
    const content = await fs.readFile(path.join(inputDir, fileName), 'utf8');
    playlists.push({ fileName, content });
    for (const url of extractUrls(content)) uniqueUrls.add(url);
  }

  console.log(
    `Found ${files.length} M3U files with ${uniqueUrls.size} unique stream links.`,
  );

  const { results, rescued } = await checkAllUrls([...uniqueUrls], quiet);

  // Write the output files in alphabetical order.
  let totalLinks = 0;
  let totalAlive = 0;

  for (const { fileName, content } of playlists) {
    const { text, total, alive, duplicates } = buildOutput(content, results);

    totalLinks += total;
    totalAlive += alive;

    const dupNote = duplicates > 0 ? ` (${duplicates} duplicates removed)` : '';
    console.log(
      `${fileName} checked - ${alive}/${total} streams were alive${dupNote}`,
    );

    if (alive === 0 && total > 0) {
      if (!quiet) console.log(`  No valid streams. Output skipped.`);
      continue;
    }

    if (text.trim() === '#EXTM3U') {
      if (!quiet) console.log(`  Nothing to save. Output skipped.`);
      continue;
    }

    await fs.writeFile(path.join(outputDir, fileName), text, 'utf8');
  }

  // Why links were marked dead, useful for spotting false negatives.
  const reasons = new Map();
  for (const result of results.values()) {
    if (result.state === 'alive') continue;
    reasons.set(result.reason, (reasons.get(result.reason) || 0) + 1);
  }

  const reasonText = [...reasons.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([reason, n]) => `${reason}=${n}`)
    .join(', ');

  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);

  console.log('\n--- All M3U files processed ---');
  console.log(`Alive: ${totalAlive}/${totalLinks} entries in ${seconds}s`);
  console.log(`Rescued by retry passes: ${rescued}`);
  if (reasonText) console.log(`Dead reasons: ${reasonText}`);
}

// Command-line arguments.
let quiet = false;
const args = [];

for (const arg of process.argv.slice(2)) {
  if (arg === '--quiet') {
    quiet = true;
  } else {
    args.push(arg);
  }
}

const inputDirectory = args[0] || 'm3u-files';
const outputDirectory = args[1] || 'm3u-checked';

if (!quiet) {
  console.log('Starting M3U Link Checker...');
  console.log(`Input Directory: ${inputDirectory}`);
  console.log(`Output Directory: ${outputDirectory}`);
  console.log(
    `Concurrency: ${CONCURRENCY} (per host ${PER_HOST}), timeout ${LINK_TIMEOUT}ms, ` +
      `retry passes ${RETRY_PASSES}`,
  );
}

main(inputDirectory, outputDirectory, quiet).catch((error) => {
  console.error('An error occurred:', error);
  process.exitCode = 1;
});
