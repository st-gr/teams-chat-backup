#!/usr/bin/env node
module.exports = main; // Export the main function

const fs = require('fs/promises');
const fsSync = require('fs');
const path = require('path');
const https = require('https');
const { existsSync } = require('fs');

// Load configuration
const config = require('./config.json');

// Construct URLs and paths using config
function buildMetadataUrl() {
    const { cdn } = config;
    const metadataPath = cdn.metadata.path
        .replace('{version}', cdn.metadata.version)
        .replace('{emoticonAssetVersion}', cdn.emoticons.emoticonAssetVersion);
    return `${cdn.baseUrl}/${cdn.assetsPath}/${metadataPath}`;
}

function buildEmoticonUrl(id, etag) {
    const { cdn } = config;
    const emoticonPath = cdn.emoticons.path
        .replace('{version}', cdn.emoticons.version)
        .replace('{id}', id);
    const queryString = `?${new URLSearchParams({
        v: etag // Using the queryParams.v template value with the actual etag
    }).toString()}`;
    return `${cdn.baseUrl}/${cdn.assetsPath}/${emoticonPath}${queryString}`;
}

// Constants using config
const METADATA_URL = buildMetadataUrl();
const OUTPUT_DIR = path.join(__dirname, '..', config.output.directory);
const METADATA_PATH = path.join(OUTPUT_DIR, config.output.metadataFile);

// Headers for request, not necessary
const headers = {
    'accept': '*/*',
    'accept-language': 'en-US,en;q=0.9',
    'cache-control': 'no-cache',
    'origin': 'https://teams.microsoft.com',
    'pragma': 'no-cache',
    'referer': 'https://teams.microsoft.com/',
    'sec-ch-ua': '"Not(A:Brand";v="99", "Google Chrome";v="133", "Chromium";v="133"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'cross-site',
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36'
};

async function checkForExistingPngs(directory) {
    try {
        const files = await fs.readdir(directory);
        return files.some(file => file.toLowerCase().endsWith('.png'));
    } catch (error) {
        return false;
    }
}

async function downloadFile(url, outputPath) {
    return new Promise((resolve, reject) => {
        const file = fsSync.createWriteStream(outputPath);
        https.get(url, { headers }, (response) => {
            if (response.statusCode !== 200) {
                file.close();
                reject(new Error(`HTTP Status ${response.statusCode}`));
                return;
            }
            response.pipe(file);
            file.on('finish', () => {
                file.close();
                resolve();
            });
        }).on('error', (err) => {
            file.close();
            fsSync.unlink(outputPath, () => {}); // Ignore unlink errors
            reject(err);
        });
    });
}

async function ensureDirectoryExists(dirPath) {
    try {
        await fs.access(dirPath);
    } catch {
        await fs.mkdir(dirPath, { recursive: true });
    }
}

async function main() {
    // Check if directory exists and create if necessary
    await ensureDirectoryExists(OUTPUT_DIR);

    // Check if both conditions are met (metadata exists and at least one PNG exists)
    const metadataExists = existsSync(METADATA_PATH);
    const hasPngs = await checkForExistingPngs(OUTPUT_DIR);

    if (metadataExists && hasPngs) {
        console.log('Assets already exist:');
        console.log(`- Metadata file found at: ${METADATA_PATH}`);
        console.log(`- PNG files found in: ${OUTPUT_DIR}`);
        console.log('Skipping download. Delete files to force re-download.');
        return;
    }

    // Download metadata if not exists
    if (!existsSync(METADATA_PATH)) {
        console.log('Downloading metadata file...');
        await downloadFile(METADATA_URL, METADATA_PATH);
        console.log('Metadata file downloaded successfully.');
    }

    // Read and parse metadata
    const metadataContent = JSON.parse(await fs.readFile(METADATA_PATH, 'utf8'));
    
    // Get all emoticons from all categories
    const emoticons = metadataContent.categories.flatMap(category => category.emoticons);
    
    if (!Array.isArray(emoticons)) {
        throw new Error('Failed to extract emoticons from categories');
    }

    // Process each emoticon
    let processed = 0;
    const total = emoticons.length;

    console.log(`Found ${total} emoticons to process`);
    console.log(`Output directory: ${OUTPUT_DIR}`);

    for (const emoticon of emoticons) {
        processed++;
        const { id, etag } = emoticon;
        
        if (!id || !etag) {
            console.log(`[${processed}/${total}] Skipping emoticon with missing id or etag`);
            continue;
        }

        // Use buildEmoticonUrl instead of EMOTICON_URL_TEMPLATE
        const url = buildEmoticonUrl(id, etag);

        const fileName = `${id}_${etag}.png`;
        const filePath = path.join(OUTPUT_DIR, fileName);

        // Skip if file already exists
        if (existsSync(filePath)) {
            console.log(`[${processed}/${total}] Skipping existing: ${fileName}`);
            continue;
        }

        try {
            await downloadFile(url, filePath);
            console.log(`[${processed}/${total}] Downloaded: ${fileName}`);
        } catch (error) {
            console.error(`Error downloading ${fileName}:`, error.message);
        }

        // Add a small delay to avoid overwhelming the server
        await new Promise(resolve => setTimeout(resolve, 100));
    }

    console.log('Download complete!');
}

// Run main if this is the main module
if (require.main === module) {
    main().catch(error => {
        console.error('Error:', error);
        process.exit(1);
    });
}