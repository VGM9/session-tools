#!/usr/bin/env node
/**
 * session-extract-images CLI
 * 
 * Extract embedded base64 images from VS Code chat session JSON files.
 * 
 * Usage:
 *   session-extract-images <session.json> [output-dir]
 *   session-extract-images --help
 * 
 * @author ALTAIR 0.0.Q
 */

const fs = require('fs');
const path = require('path');
const { extractImagesFromSession, saveImages } = require('../lib/index.js');

function printHelp() {
    console.log(`
Usage: session-extract-images <session.json> [output-dir]

Extract embedded base64 images from VS Code chat session JSON files.

Arguments:
  session.json    Path to the session JSON file
  output-dir      Directory to save extracted images (default: ./extracted_images)

Options:
  --help, -h      Show this help message

Examples:
  session-extract-images ./session.json ./images
  session-extract-images ~/.../chatSessions/abc123.json ./out
`);
}

function main() {
    const args = process.argv.slice(2);
    
    if (args.includes('--help') || args.includes('-h') || args.length === 0) {
        printHelp();
        process.exit(args.length === 0 ? 1 : 0);
    }
    
    const sessionPath = args[0];
    const outputDir = args[1] || './extracted_images';
    
    if (!fs.existsSync(sessionPath)) {
        console.error(`Error: Session file not found: ${sessionPath}`);
        process.exit(1);
    }
    
    console.log(`Reading session: ${sessionPath}`);
    
    const images = extractImagesFromSession(sessionPath);
    
    if (images.length === 0) {
        console.log('No embedded images found in session.');
        process.exit(0);
    }
    
    console.log(`Found ${images.length} embedded image(s)\n`);
    
    const savedPaths = saveImages(images, outputDir);
    
    for (let i = 0; i < images.length; i++) {
        const img = images[i];
        console.log(`Image ${img.index}:`);
        console.log(`  Type: ${img.mimeType}`);
        console.log(`  Size: ~${img.sizeKB} KB`);
        console.log(`  Saved: ${savedPaths[i]}`);
        console.log();
    }
    
    console.log(`Extracted ${images.length} images to ${outputDir}`);
}

main();
