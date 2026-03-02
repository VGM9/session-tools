/**
 * @vgm9/session-tools
 *
 * Library for parsing and extracting data from VS Code chat session JSON files.
 *
 * Session format history:
 *   <VS Code 1.109: single .json file, top-level { requests: [] }
 *   >=VS Code 1.109: .jsonl file, mutation log (kind 0=snapshot, 1=set, 2=push, 3=delete)
 *
 * These session files are stored in:
 *   AppData/[Code|Code - Insiders]/User/workspaceStorage/{hash}/chatSessions/{uuid}.{json|jsonl}
 *
 * @author ALTAIR 0.0.Q
 * @version 0.3.0 — JSONL support (VS Code >=1.109)
 */

const fs = require('fs');
const path = require('path');

/**
 * Extract all embedded base64 images from a session JSON
 * @param {string} sessionPath - Path to session JSON file
 * @returns {Array<{index: number, mimeType: string, ext: string, sizeKB: number, base64Data: string, context: string}>}
 */
function extractImagesFromSession(sessionPath) {
    const data = fs.readFileSync(sessionPath, 'utf8');
    return extractImagesFromJson(data);
}

/**
 * Extract all embedded base64 images from raw JSON string
 * @param {string} jsonData - Raw JSON string content
 * @returns {Array<{index: number, mimeType: string, ext: string, sizeKB: number, base64Data: string, context: string}>}
 */
function extractImagesFromJson(jsonData) {
    const imageRegex = /data:image\/(png|jpeg|jpg|gif|webp);base64,([A-Za-z0-9+/=]+)/g;
    
    let match;
    let count = 0;
    const images = [];
    
    while ((match = imageRegex.exec(jsonData)) !== null) {
        count++;
        const mimeType = match[1];
        const base64Data = match[2];
        const ext = mimeType === 'jpeg' ? 'jpg' : mimeType;
        
        // Get context before the image (for identification)
        const startPos = match.index;
        const contextBefore = jsonData.substring(Math.max(0, startPos - 200), startPos);
        
        images.push({
            index: count,
            mimeType,
            ext,
            size: base64Data.length,
            sizeKB: Math.round(base64Data.length * 0.75 / 1024),
            base64Data,
            context: contextBefore.replace(/[^\x20-\x7E]/g, '').substring(-100)
        });
    }
    
    return images;
}

/**
 * Save extracted images to disk
 * @param {Array} images - Images array from extractImagesFromSession
 * @param {string} outputDir - Directory to save images
 * @param {string} [prefix='extracted_'] - Filename prefix
 * @returns {Array<string>} Array of saved file paths
 */
function saveImages(images, outputDir, prefix = 'extracted_') {
    fs.mkdirSync(outputDir, { recursive: true });
    
    const savedPaths = [];
    
    for (const img of images) {
        const filename = `${prefix}${img.index}.${img.ext}`;
        const filepath = path.join(outputDir, filename);
        
        const buffer = Buffer.from(img.base64Data, 'base64');
        fs.writeFileSync(filepath, buffer);
        
        savedPaths.push(filepath);
    }
    
    return savedPaths;
}

/**
 * Read a session file (handles both legacy .json and current .jsonl formats).
 * Returns a plain object with the same shape as the old .json format's top-level object.
 * @param {string} sessionPath
 * @returns {object}
 */
function readSessionData(sessionPath) {
    const content = fs.readFileSync(sessionPath, 'utf8');
    if (sessionPath.endsWith('.jsonl')) {
        return replayJsonl(content);
    }
    return JSON.parse(content);
}

/**
 * Replay a JSONL mutation log into a plain object.
 * Handles EntryKind: 0=Initial(snapshot), 1=Set, 2=Push/splice, 3=Delete
 * @param {string} content - Raw JSONL file content
 * @returns {object}
 */
function replayJsonl(content) {
    const entries = content.split('\n')
        .map(l => l.trim())
        .filter(Boolean)
        .map(l => JSON.parse(l));

    const initial = entries.find(e => e.kind === 0);
    if (!initial) throw new Error('JSONL has no kind:0 initial snapshot');
    const state = JSON.parse(JSON.stringify(initial.v)); // deep clone

    for (const entry of entries) {
        if (entry.kind === 0) continue;
        applyMutation(state, entry);
    }
    return state;
}

function applyMutation(state, entry) {
    const { kind, k, v, i } = entry;
    if (!k || k.length === 0) return;
    let obj = state;
    for (let idx = 0; idx < k.length - 1; idx++) {
        if (obj[k[idx]] === undefined) obj[k[idx]] = {};
        obj = obj[k[idx]];
    }
    const last = k[k.length - 1];
    if (kind === 1) { // Set
        obj[last] = v;
    } else if (kind === 2) { // Push/splice
        if (!Array.isArray(obj[last])) obj[last] = [];
        if (i !== undefined) obj[last].splice(i);
        if (v) obj[last].push(...v);
    } else if (kind === 3) { // Delete
        delete obj[last];
    }
}

/**
 * Parse session file and extract metadata
 * @param {string} sessionPath - Path to session .json or .jsonl file
 * @returns {{sessionId: string, creationDate: Date, customTitle: string|null, requestCount: number, rebootCount: number, requests: Array}}
 */
function parseSession(sessionPath) {
    const data = readSessionData(sessionPath);
    const requests = data.requests || [];
    
    // Count ONLY summarizer-full events (true reboots)
    // See VGM9/___/protocols/REBOOT_DEFINITION.md for specification
    let rebootCount = 0;
    for (const req of requests) {
        for (const resp of (req.response || [])) {
            // Check both progressTaskSerialized (current) and progressTask (legacy)
            if (resp.kind === 'progressTaskSerialized' || resp.kind === 'progressTask') {
                const content = resp.content || {};
                if (content.value === 'Summarized conversation history') {
                    rebootCount++;
                }
            }
        }
    }
    
    return {
        sessionId: data.sessionId || path.basename(sessionPath, '.json'),
        creationDate: data.creationDate ? new Date(data.creationDate) : null,
        customTitle: data.customTitle || null,
        requestCount: requests.length,
        rebootCount,
        requests: requests.map((req, i) => ({
            index: i,
            timestamp: req.timestamp ? new Date(req.timestamp) : null,
            messagePreview: req.message?.text?.slice(0, 200),
            responseCount: (req.response || []).length
        }))
    };
}

/**
 * Find all session files (.json and .jsonl) in a workspace storage directory
 * @param {string} storageHash - Workspace storage hash directory
 * @param {string} [appDataPath] - Optional AppData path (auto-detected if not provided)
 * @returns {Array<string>} Array of session file paths
 */
function findSessionFiles(storageHash, appDataPath = null) {
    if (!appDataPath) {
        try {
            const { getAppDataPath } = require('@vgm9/appdata-path');
            appDataPath = getAppDataPath();
        } catch {
            const os = require('os');
            const appName = process.env.VSCODE_APP_NAME || 'Code - Insiders';
            appDataPath = path.join(os.homedir(), 'AppData', 'Roaming', appName, 'User');
        }
    }

    const sessionsDir = path.join(appDataPath, 'workspaceStorage', storageHash, 'chatSessions');

    if (!fs.existsSync(sessionsDir)) {
        return [];
    }

    return fs.readdirSync(sessionsDir)
        .filter(f => f.endsWith('.json') || f.endsWith('.jsonl'))
}

/**
 * Extract user messages from session
 * @param {string} sessionPath - Path to session .json or .jsonl file
 * @returns {Array<{index: number, timestamp: Date, text: string}>}
 */
function extractUserMessages(sessionPath) {
    const data = readSessionData(sessionPath);
    const requests = data.requests || [];
    
    return requests.map((req, i) => ({
        index: i,
        timestamp: req.timestamp ? new Date(req.timestamp) : null,
        text: req.message?.text || ''
    }));
}

/**
 * Check if a session file contains images
 * @param {string} sessionPath - Path to session JSON file
 * @returns {boolean}
 */
function hasImages(sessionPath) {
    const data = fs.readFileSync(sessionPath, 'utf8');
    return /data:image\/(png|jpeg|jpg|gif|webp);base64,/.test(data);
}

const { sanitizeSession, sanitizeContent } = require('./sanitize');

module.exports = {
    extractImagesFromSession,
    extractImagesFromJson,
    saveImages,
    readSessionData,
    replayJsonl,
    parseSession,
    findSessionFiles,
    extractUserMessages,
    hasImages,
    sanitizeSession,
    sanitizeContent
};
