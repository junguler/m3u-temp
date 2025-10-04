#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { URL } = require('url');

// Parse command line arguments
const args = process.argv.slice(2);
const config = {
  inputFolder: 'input_folder',
  outputFolder: 'output_folder',
  concurrency: 10,
  timeout: 10000
};

for (let i = 0; i < args.length; i++) {
  switch(args[i]) {
    case '--input':
    case '-i':
      config.inputFolder = args[++i];
      break;
    case '--output':
    case '-o':
      config.outputFolder = args[++i];
      break;
    case '--concurrency':
    case '-c':
      config.concurrency = parseInt(args[++i]);
      break;
    case '--timeout':
    case '-t':
      config.timeout = parseInt(args[++i]) * 1000;
      break;
    case '--help':
    case '-h':
      console.log(`
Usage: node script.js [options]

Options:
  -i, --input <folder>        Input folder path (default: input_folder)
  -o, --output <folder>       Output folder path (default: output_folder)
  -c, --concurrency <number>  Concurrent searches (default: 10)
  -t, --timeout <seconds>     Timeout per search in seconds (default: 10)
  -h, --help                  Show this help message
      `);
      process.exit(0);
  }
}

console.log('Configuration:', config);

// Create output folder if it doesn't exist
if (!fs.existsSync(config.outputFolder)) {
  fs.mkdirSync(config.outputFolder, { recursive: true });
}

// Helper function to make HTTP/HTTPS requests
function makeRequest(url, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const protocol = parsedUrl.protocol === 'https:' ? https : http;
    
    const options = {
      hostname: parsedUrl.hostname,
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
      },
      timeout: timeout
    };

    const req = protocol.request(options, (res) => {
      // Handle redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        makeRequest(res.headers.location, timeout).then(resolve).catch(reject);
        return;
      }

      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => resolve({ statusCode: res.statusCode, data, headers: res.headers }));
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });

    req.end();
  });
}

// Search for logo using multiple methods
async function findLogo(title, timeout) {
  const cleanTitle = title.trim().replace(/[^\w\s]/gi, ' ').trim();
  
  // Method 1: Google Custom Search (scraping)
  try {
    const logoUrl = await searchGoogleImages(cleanTitle, timeout);
    if (logoUrl) return logoUrl;
  } catch (e) {
    // Silent fail, try next method
  }

  // Method 2: DuckDuckGo Images
  try {
    const logoUrl = await searchDuckDuckGoImages(cleanTitle, timeout);
    if (logoUrl) return logoUrl;
  } catch (e) {
    // Silent fail, try next method
  }

  // Method 3: Bing Images
  try {
    const logoUrl = await searchBingImages(cleanTitle, timeout);
    if (logoUrl) return logoUrl;
  } catch (e) {
    // Silent fail
  }

  return null;
}

// Google Images search
async function searchGoogleImages(query, timeout) {
  try {
    const searchQuery = encodeURIComponent(`${query} logo`);
    const url = `https://www.google.com/search?q=${searchQuery}&tbm=isch`;
    
    const response = await makeRequest(url, timeout);
    
    if (response.statusCode === 200) {
      // Extract image URLs from the HTML
      const imageUrls = extractImageUrls(response.data);
      return selectBestImage(imageUrls);
    }
  } catch (e) {
    return null;
  }
  return null;
}

// DuckDuckGo Images search
async function searchDuckDuckGoImages(query, timeout) {
  try {
    const searchQuery = encodeURIComponent(`${query} logo`);
    const url = `https://duckduckgo.com/?q=${searchQuery}&iax=images&ia=images`;
    
    const response = await makeRequest(url, timeout);
    
    if (response.statusCode === 200) {
      // First, get the vqd token
      const vqdMatch = response.data.match(/vqd=['"]([^'"]+)['"]/);
      if (vqdMatch) {
        const vqd = vqdMatch[1];
        const apiUrl = `https://duckduckgo.com/i.js?q=${searchQuery}&vqd=${vqd}`;
        
        try {
          const apiResponse = await makeRequest(apiUrl, timeout);
          if (apiResponse.statusCode === 200) {
            const data = JSON.parse(apiResponse.data);
            if (data.results && data.results.length > 0) {
              const imageUrls = data.results.map(r => r.image).filter(Boolean);
              return selectBestImage(imageUrls);
            }
          }
        } catch (e) {
          // Fallback to HTML parsing
          const imageUrls = extractImageUrls(response.data);
          return selectBestImage(imageUrls);
        }
      }
    }
  } catch (e) {
    return null;
  }
  return null;
}

// Bing Images search
async function searchBingImages(query, timeout) {
  try {
    const searchQuery = encodeURIComponent(`${query} logo`);
    const url = `https://www.bing.com/images/search?q=${searchQuery}`;
    
    const response = await makeRequest(url, timeout);
    
    if (response.statusCode === 200) {
      const imageUrls = extractImageUrls(response.data);
      return selectBestImage(imageUrls);
    }
  } catch (e) {
    return null;
  }
  return null;
}

// Extract image URLs from HTML
function extractImageUrls(html) {
  const urls = [];
  
  // Various regex patterns to extract image URLs
  const patterns = [
    /"(https?:\/\/[^"]+\.(?:jpg|jpeg|png|gif|webp))"/gi,
    /'(https?:\/\/[^']+\.(?:jpg|jpeg|png|gif|webp))'/gi,
    /urlKATEX_INLINE_OPEN(https?:\/\/[^)]+\.(?:jpg|jpeg|png|gif|webp))KATEX_INLINE_CLOSE/gi,
    /"ou":"(https?:\/\/[^"]+\.(?:jpg|jpeg|png|gif|webp))"/gi,
    /"thumbnail":"(https?:\/\/[^"]+)"/gi,
    /"murl":"(https?:\/\/[^"]+)"/gi,
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(html)) !== null) {
      const url = match[1];
      if (url && !isFavicon(url) && !urls.includes(url)) {
        urls.push(url);
      }
    }
  }

  return urls;
}

// Check if URL is likely a favicon
function isFavicon(url) {
  const lowerUrl = url.toLowerCase();
  return lowerUrl.includes('favicon') || 
         lowerUrl.includes('icon') && lowerUrl.includes('16') ||
         lowerUrl.includes('icon') && lowerUrl.includes('32') ||
         lowerUrl.endsWith('.ico');
}

// Select best image from list
function selectBestImage(urls) {
  if (urls.length === 0) return null;

  // Filter out likely favicons and small images
  const filtered = urls.filter(url => {
    if (isFavicon(url)) return false;
    
    // Avoid very small images based on URL patterns
    if (/\d+x\d+/.test(url)) {
      const sizeMatch = url.match(/(\d+)x(\d+)/);
      if (sizeMatch) {
        const width = parseInt(sizeMatch[1]);
        const height = parseInt(sizeMatch[2]);
        if (width < 100 || height < 100) return false;
      }
    }
    
    return true;
  });

  // Prioritize URLs with "logo" in them
  const logoUrls = filtered.filter(url => url.toLowerCase().includes('logo'));
  if (logoUrls.length > 0) return logoUrls[0];

  // Return first filtered URL or first URL if no filtered ones
  return filtered.length > 0 ? filtered[0] : urls[0];
}

// Parse M3U file
function parseM3U(content) {
  const lines = content.split('\n');
  const entries = [];
  let currentEntry = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    
    if (line.startsWith('#EXTINF:')) {
      currentEntry = { extinf: line };
      
      // Extract title
      const titleMatch = line.match(/,(.+)$/);
      if (titleMatch) {
        currentEntry.title = titleMatch[1].trim();
      }
      
      // Extract existing tvg-logo
      const logoMatch = line.match(/tvg-logo="([^"]*)"/);
      if (logoMatch) {
        currentEntry.existingLogo = logoMatch[1];
      }
    } else if (line && !line.startsWith('#') && currentEntry) {
      currentEntry.url = line;
      entries.push(currentEntry);
      currentEntry = null;
    }
  }

  return entries;
}

// Update M3U entry with logo
function updateEntryWithLogo(entry, logoUrl) {
  let extinf = entry.extinf;
  
  if (entry.existingLogo) {
    // Replace existing logo
    extinf = extinf.replace(/tvg-logo="[^"]*"/, `tvg-logo="${logoUrl}"`);
  } else {
    // Add new logo attribute
    if (extinf.includes('tvg-')) {
      // Insert after other tvg- attributes
      extinf = extinf.replace(/tvg-[^=]+="[^"]*"/, `$& tvg-logo="${logoUrl}"`);
    } else {
      // Insert before the comma and title
      extinf = extinf.replace(/,/, ` tvg-logo="${logoUrl}",`);
    }
  }
  
  return extinf;
}

// Process entries with concurrency control
async function processEntriesWithConcurrency(entries, concurrency, timeout) {
  const results = [];
  let successCount = 0;
  let failCount = 0;

  for (let i = 0; i < entries.length; i += concurrency) {
    const batch = entries.slice(i, i + concurrency);
    
    const promises = batch.map(async (entry, index) => {
      const globalIndex = i + index;
      console.log(`[${globalIndex + 1}/${entries.length}] Searching logo for: ${entry.title}`);
      
      if (entry.existingLogo && entry.existingLogo.length > 0) {
        console.log(`  -> Already has logo, skipping`);
        return entry;
      }

      try {
        const logoUrl = await findLogo(entry.title, timeout);
        
        if (logoUrl) {
          console.log(`  -> Found: ${logoUrl}`);
          entry.extinf = updateEntryWithLogo(entry, logoUrl);
          successCount++;
        } else {
          console.log(`  -> Not found`);
          failCount++;
        }
      } catch (e) {
        console.log(`  -> Error: ${e.message}`);
        failCount++;
      }

      return entry;
    });

    const batchResults = await Promise.all(promises);
    results.push(...batchResults);
  }

  console.log(`\nProcessing complete: ${successCount} found, ${failCount} not found`);
  return results;
}

// Generate M3U content from entries
function generateM3U(entries) {
  let content = '#EXTM3U\n';
  
  for (const entry of entries) {
    content += entry.extinf + '\n';
    content += entry.url + '\n';
  }
  
  return content;
}

// Process a single M3U file
async function processM3UFile(inputPath, outputPath) {
  console.log(`\nProcessing: ${inputPath}`);
  
  const content = fs.readFileSync(inputPath, 'utf8');
  const entries = parseM3U(content);
  
  console.log(`Found ${entries.length} streams`);
  
  const updatedEntries = await processEntriesWithConcurrency(
    entries,
    config.concurrency,
    config.timeout
  );
  
  const updatedContent = generateM3U(updatedEntries);
  fs.writeFileSync(outputPath, updatedContent, 'utf8');
  
  console.log(`Saved to: ${outputPath}`);
}

// Main function
async function main() {
  if (!fs.existsSync(config.inputFolder)) {
    console.error(`Input folder does not exist: ${config.inputFolder}`);
    process.exit(1);
  }

  const files = fs.readdirSync(config.inputFolder);
  const m3uFiles = files.filter(f => f.toLowerCase().endsWith('.m3u') || f.toLowerCase().endsWith('.m3u8'));

  if (m3uFiles.length === 0) {
    console.log('No M3U files found in input folder');
    process.exit(0);
  }

  console.log(`Found ${m3uFiles.length} M3U file(s)`);

  for (const file of m3uFiles) {
    const inputPath = path.join(config.inputFolder, file);
    const outputPath = path.join(config.outputFolder, file);
    
    await processM3UFile(inputPath, outputPath);
  }

  console.log('\nAll files processed!');
}

main().catch(console.error);