#!/usr/bin/env node
/**
 * session-list CLI
 * 
 * List chat sessions from a workspace storage directory.
 * 
 * Usage:
 *   session-list <workspace-hash>
 *   session-list --help
 * 
 * @author ALTAIR 0.0.Q
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { findSessionFiles, parseSession, hasImages } = require('../lib/index.js');

function printHelp() {
    console.log(`
Usage: session-list <workspace-hash> [options]

List chat sessions from a VS Code workspace storage directory.

Arguments:
  workspace-hash    The workspace storage hash directory name

Options:
  --with-images     Only show sessions containing images
  --json            Output as JSON
  --help, -h        Show this help message

Finding your workspace hash:
  Look in: AppData/[Code|Code - Insiders]/User/workspaceStorage/
  Each subdirectory is a hash. Check workspace.json inside for folder/workspace URI.

Examples:
  session-list fc7deee2819a0e3e3f792481dedcbc98
  session-list abc123 --with-images
  session-list abc123 --json
`);
}

function getAppDataPath() {
    const appName = process.env.VSCODE_APP_NAME || 'Code - Insiders';
    
    switch (process.platform) {
        case 'win32':
            return path.join(os.homedir(), 'AppData', 'Roaming', appName, 'User');
        case 'darwin':
            return path.join(os.homedir(), 'Library', 'Application Support', appName, 'User');
        default: // linux
            return path.join(os.homedir(), '.config', appName, 'User');
    }
}

function main() {
    const args = process.argv.slice(2);
    
    if (args.includes('--help') || args.includes('-h') || args.length === 0) {
        printHelp();
        process.exit(args.length === 0 ? 1 : 0);
    }
    
    const hash = args.find(a => !a.startsWith('--'));
    const withImages = args.includes('--with-images');
    const jsonOutput = args.includes('--json');
    
    if (!hash) {
        console.error('Error: workspace-hash argument required');
        process.exit(1);
    }
    
    const appDataPath = getAppDataPath();
    const sessionFiles = findSessionFiles(hash, appDataPath);
    
    if (sessionFiles.length === 0) {
        console.error(`No sessions found for hash: ${hash}`);
        console.error(`Looked in: ${path.join(appDataPath, 'workspaceStorage', hash, 'chatSessions')}`);
        process.exit(1);
    }
    
    const sessions = [];
    
    for (const file of sessionFiles) {
        try {
            const session = parseSession(file);
            const containsImages = hasImages(file);
            
            if (withImages && !containsImages) continue;
            
            sessions.push({
                ...session,
                hasImages: containsImages,
                filePath: file
            });
        } catch (e) {
            // Skip malformed files
        }
    }
    
    // Sort by creation date (most recent first)
    sessions.sort((a, b) => (b.creationDate || 0) - (a.creationDate || 0));
    
    if (jsonOutput) {
        console.log(JSON.stringify(sessions, null, 2));
        return;
    }
    
    console.log(`Found ${sessions.length} session(s) in ${hash}\n`);
    
    for (const s of sessions) {
        const imgMarker = s.hasImages ? ' 🖼️' : '';
        const titleMarker = s.customTitle ? ` "${s.customTitle}"` : '';
        console.log(`${s.sessionId.slice(0, 12)}...${titleMarker}${imgMarker}`);
        console.log(`  Requests: ${s.requestCount} | Reboots: ${s.rebootCount}`);
        console.log(`  Created: ${s.creationDate ? s.creationDate.toISOString() : 'unknown'}`);
        console.log();
    }
}

main();
