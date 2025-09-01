// m3u-checker.js
// made with Gemini 2.5 Flash via https://t3.chat/ free tier - thanks
// usage example:
// node ./m3u-checker.js -> this expects m3u files in "m3u-files" folder and puts output files in "m3u-checked"
// or
// node ./m3u-checker.js input_folder/ output_folder/

const fs = require("fs/promises"); // For promise-based operations
const fsSync = require("fs"); // For createWriteStream and other synchronous/callback-based operations
const path = require("path");

const concurrencyLimit = 10;
const linkTimeout = 5000;
const maxRedirects = 3;

let logStream; // Declare logStream globally

/**
 * Custom console object to redirect output to both console and log file.
 */
const customConsole = {
  log: (...args) => {
    const message = args.map(arg => String(arg)).join(" ");
    console.log(message);
    if (logStream) {
      logStream.write(message + "\n");
    }
  },
  error: (...args) => {
    const message = args.map(arg => String(arg)).join(" ");
    console.error(message);
    if (logStream) {
      logStream.write(`ERROR: ${message}\n`);
    }
  },
};

/**
 * Parses the content of an M3U file and extracts stream links.
 * @param {string} content The content of the M3U file.
 * @returns {Array<object>} An array of objects, each representing a stream link.
 */
function parseM3UContent(content) {
  let lines = content.split("\n");
  let links = [];
  let currentTitle = "";
  let currentTitleLineIndex = -1;

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i].trim();
    if (line.startsWith("#EXTINF")) {
      currentTitle = line;
      currentTitleLineIndex = i;
    } else if (line.startsWith("http://") || line.startsWith("https://")) {
      links.push({
        title: currentTitle,
        url: line,
        originalIndex: i,
        originalTitleLineIndex: currentTitleLineIndex,
      });
      currentTitle = ""; // Reset for the next link
      currentTitleLineIndex = -1;
    }
  }
  return links;
}

/**
 * Checks a single stream link for its availability and status.
 * Handles redirects up to a maximum number of attempts.
 * @param {object} link The link object containing url, title, etc.
 * @param {string} fileName The name of the M3U file the link belongs to, for logging.
 * @param {number} redirectCount The current redirect count.
 * @returns {Promise<object>} An object containing the URL, status, and final URL (if applicable).
 */
async function checkSingleLink(link, fileName, redirectCount = 0) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), linkTimeout);

  try {
    const response = await fetch(link.url, {
      method: "HEAD",
      signal: controller.signal,
      redirect: "manual", // Handle redirects manually
    });
    clearTimeout(timeoutId);

    if (
      response.status >= 300 &&
      response.status < 400 &&
      response.headers.has("location") &&
      redirectCount < maxRedirects
    ) {
      const location = response.headers.get("location");
      const newUrl = new URL(location, link.url).href;
      customConsole.log(
        `  [${fileName}] - Redirect (${response.status}): ${link.url} -> ${newUrl} (Attempt ${
          redirectCount + 1
        }/${maxRedirects})`,
      );
      return await checkSingleLink(
        { ...link, url: newUrl },
        fileName,
        redirectCount + 1,
      );
    }

    if (response.status === 200) {
      customConsole.log(`  [${fileName}] - Status ${response.status}: ${link.url}`);
      return { url: link.url, status: response.status, finalUrl: link.url };
    }

    customConsole.log(`  [${fileName}] - Status ${response.status}: ${link.url}`);
    return { url: link.url, status: response.status };
  } catch (error) {
    clearTimeout(timeoutId);
    if (error.name === "AbortError") {
      customConsole.log(`  [${fileName}] - Timed out: ${link.url}`);
      return { url: link.url, status: "timedout" };
    }
    customConsole.log(`  [${fileName}] - Invalid/Error (${error.message}): ${link.url}`);
    return { url: link.url, status: "invalid" };
  }
}

/**
 * Processes a list of links concurrently, checking their status.
 * @param {Array<object>} links An array of link objects.
 * @param {string} fileName The name of the M3U file the links belong to, for logging.
 * @returns {Promise<Map<number, object>>} A Map where keys are original line indices and values are objects for valid links.
 */
async function processLinks(links, fileName) {
  const validLinks = new Map();
  const activeChecks = new Set();
  let completedChecks = 0;

  for (let i = 0; i < links.length; i++) {
    const link = links[i];
    const checkPromise = checkSingleLink(link, fileName).then(result => {
      if (result && result.status === 200) {
        const finalUrl = result.finalUrl || link.url;
        validLinks.set(link.originalIndex, {
          titleLine: link.title,
          urlLine: finalUrl,
        });
      }
      completedChecks++;
      activeChecks.delete(checkPromise); // Remove the promise from active checks
      return result;
    });
    activeChecks.add(checkPromise);

    if (activeChecks.size >= concurrencyLimit) {
      await Promise.race(Array.from(activeChecks));
    }
  }

  // Wait for all remaining checks to complete
  await Promise.allSettled(Array.from(activeChecks));

  return validLinks;
}

/**
 * Generates the content of a new M3U file with only valid links.
 * @param {string} originalM3UContent The content of the original M3U file.
 * @param {Map<number, object>} validLinks A Map of valid links.
 * @returns {string} The content of the new M3U file.
 */
function generateOutputM3U(originalM3UContent, validLinks) {
  let originalLines = originalM3UContent.split("\n");
  let outputLines = [];
  const addedLines = new Set(); // To prevent duplicate lines in the output

  outputLines.push("#EXTM3U");
  addedLines.add("#EXTM3U");

  for (let i = 0; i < originalLines.length; i++) {
    let line = originalLines[i].trim();

    if (!line.startsWith("#EXTM3U")) {
      if (line.startsWith("#EXTINF")) {
        const nextLineIndex = i + 1;
        if (nextLineIndex < originalLines.length) {
          const urlLine = originalLines[nextLineIndex].trim();
          if (
            (urlLine.startsWith("http://") || urlLine.startsWith("https://")) &&
            validLinks.has(nextLineIndex)
          ) {
            const { titleLine, urlLine: finalUrlLine } =
              validLinks.get(nextLineIndex);
            if (!addedLines.has(titleLine)) {
              outputLines.push(titleLine);
              addedLines.add(titleLine);
            }
            if (!addedLines.has(finalUrlLine)) {
              outputLines.push(finalUrlLine);
              addedLines.add(finalUrlLine);
            }
            i = nextLineIndex; // Skip the URL line as it's already processed
          }
        }
      } else if (line.startsWith("http://") || line.startsWith("https://")) {
        if (validLinks.has(i)) {
          const { urlLine: finalUrlLine } = validLinks.get(i);
          if (!addedLines.has(finalUrlLine)) {
            outputLines.push(finalUrlLine);
            addedLines.add(finalUrlLine);
          }
        }
      } else if (line.trim() === "" || !addedLines.has(line)) {
        // Add other lines (like comments or blank lines) if not already added
        outputLines.push(line);
        addedLines.add(line);
      }
    }
  }

  return outputLines.join("\n");
}

/**
 * Main function to process M3U files in the input directory and save checked files to the output directory.
 * @param {string} inputDir The path to the input directory.
 * @param {string} outputDir The path to the output directory.
 */
async function main(inputDir, outputDir) {
  try {
    // Initialize log file using fsSync.createWriteStream
    logStream = fsSync.createWriteStream("log.txt", { flags: "w" });

    await fs.mkdir(outputDir, { recursive: true });

    const files = await fs.readdir(inputDir);
    const m3uFiles = files.filter(
      file => file.endsWith(".m3u") || file.endsWith(".m3u8"),
    );

    if (m3uFiles.length === 0) {
      customConsole.log(`No .m3u or .m3u8 files found in "${inputDir}"`);
      return;
    }

    customConsole.log(`Found ${m3uFiles.length} M3U files to check in "${inputDir}".`);

    for (const fileName of m3uFiles) {
      customConsole.log(`\n--- Checking "${fileName}" ---`);
      const fullPath = path.join(inputDir, fileName);
      const m3uContent = await fs.readFile(fullPath, "utf8");
      const links = parseM3UContent(m3uContent);

      customConsole.log(`  Found ${links.length} stream links.`);

      if (links.length === 0) {
        customConsole.log(`  No stream links found in "${fileName}". Copying as-is.`);
        await fs.writeFile(path.join(outputDir, fileName), m3uContent, "utf8");
        continue;
      }

      const validLinks = await processLinks(links, fileName);
      const validCount = validLinks.size;

      customConsole.log(
        `  Check complete for "${fileName}". Found ${validCount} valid streams out of ${links.length}.`,
      );

      const outputFileName = fileName;
      const outputPath = path.join(outputDir, outputFileName);
      const outputM3UContent = generateOutputM3U(m3uContent, validLinks);

      await fs.writeFile(outputPath, outputM3UContent, "utf8");
      customConsole.log(`  Saved checked playlist to "${outputPath}"`);
    }

    customConsole.log("\n--- All M3U files processed ---");
  } catch (error) {
    customConsole.error("An error occurred:", error);
    process.exit(1);
  } finally {
    if (logStream) {
      logStream.end(); // Close the log stream
    }
  }
}

// Get arguments from the command line
const args = process.argv.slice(2);
const inputDirectory = args[0] || "m3u-files";
const outputDirectory = args[1] || "m3u-checked";

customConsole.log("Starting M3U Link Checker...");
customConsole.log(`Input Directory: ${inputDirectory}`);
customConsole.log(`Output Directory: ${outputDirectory}`);

main(inputDirectory, outputDirectory);