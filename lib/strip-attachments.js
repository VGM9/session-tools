'use strict';
/**
 * strip-attachments.js — Externalise base64 blobs from VS Code chat session files.
 *
 * Ported from src/strip-attachments.ts in VGM9/qhoami.
 * Zero VS Code API dependencies. Pure Node.js: fs, crypto, path.
 *
 * @module @vgm9/session-tools/strip-attachments
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

/** @type {number} Threshold: replace string values longer than this many characters. */
const DEFAULT_BLOB_THRESHOLD = 100_000;

/**
 * Build a compact inline reference marker.
 * @param {string} sha256 - 64-hex SHA-256 hash
 * @param {number} bytes - original byte count estimate
 * @param {string} mime - MIME type string
 * @returns {string}
 */
function makeRef(sha256, bytes, mime) {
  return `__qhoami:sha256:${sha256}:bytes:${bytes}:mime:${mime}__`;
}

/**
 * Parse a compact inline reference marker.
 * @param {string} s
 * @returns {{ sha256: string, bytes: number, mime: string } | null}
 */
function parseRef(s) {
  const m = s.match(/^__qhoami:sha256:([0-9a-f]{64}):bytes:(\d+):mime:([^_]+)__$/);
  if (!m) return null;
  return { sha256: m[1], bytes: parseInt(m[2], 10), mime: m[3] };
}

/**
 * Detect MIME type from a base64 string by inspecting the decoded header bytes.
 * @param {string} b64
 * @returns {string}
 */
function detectMime(b64) {
  const dataUriMatch = b64.match(/^data:([^;]+);base64,/);
  if (dataUriMatch) return dataUriMatch[1];
  try {
    const sample = Buffer.from(b64.slice(0, 24), 'base64');
    if (sample[0] === 0x89 && sample[1] === 0x50 && sample[2] === 0x4e && sample[3] === 0x47) return 'image/png';
    if (sample[0] === 0xff && sample[1] === 0xd8) return 'image/jpeg';
    if (sample[0] === 0x47 && sample[1] === 0x49 && sample[2] === 0x46) return 'image/gif';
    if (sample[0] === 0x52 && sample[1] === 0x49 && sample[2] === 0x46 && sample[3] === 0x46) return 'image/webp';
    if (sample[0] === 0x25 && sample[1] === 0x50 && sample[2] === 0x44 && sample[3] === 0x46) return 'application/pdf';
  } catch (_) { /* ignore */ }
  return 'application/octet-stream';
}

/**
 * @param {string} mime
 * @returns {string}
 */
function mimeToExt(mime) {
  const map = {
    'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif',
    'image/webp': '.webp', 'application/pdf': '.pdf',
    'application/octet-stream': '.bin',
  };
  return map[mime] || '.bin';
}

/**
 * Scan content for JSON string literals exceeding threshold characters.
 * @param {string} content
 * @param {number} threshold
 * @param {string} attachmentDir
 * @param {Map<string, object>} savedMap
 * @param {boolean} dryRun
 * @returns {{ newContent: string, blobsExtracted: number }}
 */
function extractBlobs(content, threshold, attachmentDir, savedMap, dryRun) {
  const chunks = [];
  let chunkStart = 0;
  let i = 0;
  const n = content.length;
  let blobsExtracted = 0;

  while (i < n) {
    const q = content.indexOf('"', i);
    if (q === -1) break;

    let j = q + 1;
    while (j < n) {
      const c = content[j];
      if (c === '\\') { j += 2; continue; }
      if (c === '"') { j++; break; }
      j++;
    }

    const strContentLen = j - q - 2;
    if (strContentLen > threshold) {
      const raw = content.slice(q + 1, j - 1);

      if (raw.startsWith('__qhoami:sha256:')) {
        i = j;
        continue;
      }

      const sha256 = crypto.createHash('sha256').update(raw, 'utf8').digest('hex');
      const mime = detectMime(raw);
      const ext = mimeToExt(mime);
      const fileName = `${sha256}${ext}`;
      const savedPath = path.join(attachmentDir, fileName);

      if (!savedMap.has(sha256)) {
        const record = { sha256, savedPath, mimeType: mime, originalChars: strContentLen };
        savedMap.set(sha256, record);

        if (!dryRun) {
          fs.mkdirSync(attachmentDir, { recursive: true });
          const dataUriMatch = raw.match(/^data:[^;]+;base64,(.+)$/s);
          const blobData = dataUriMatch ? Buffer.from(dataUriMatch[1], 'base64') : Buffer.from(raw, 'base64');
          if (!fs.existsSync(savedPath)) {
            fs.writeFileSync(savedPath, blobData);
          }
        }
      }

      const originalBytes = Math.floor(strContentLen * 3 / 4);
      const ref = makeRef(sha256, originalBytes, mime);

      chunks.push(content.slice(chunkStart, q));
      chunks.push('"' + ref + '"');
      chunkStart = j;
      blobsExtracted++;
    }

    i = j;
  }

  const newContent = chunkStart === 0 ? content : [...chunks, content.slice(chunkStart)].join('');
  return { newContent, blobsExtracted };
}

/**
 * @param {string} sessionPath
 * @param {string} content
 * @param {Required<StripOptions>} options
 * @param {Map<string, object>} savedMap
 * @returns {{ newContent: string, blobsFound: number }}
 */
function processOldJsonFormat(sessionPath, content, options, savedMap) {
  const { newContent, blobsExtracted } = extractBlobs(content, options.blobThresholdChars, options.attachmentDir, savedMap, options.dryRun);
  return { newContent, blobsFound: blobsExtracted };
}

/**
 * @param {string} sessionPath
 * @param {string} content
 * @param {Required<StripOptions>} options
 * @param {Map<string, object>} savedMap
 * @returns {{ newContent: string, blobsFound: number }}
 */
function processJsonlFormat(sessionPath, content, options, savedMap) {
  const lines = content.split('\n');
  const outLines = [];
  let totalBlobs = 0;

  for (const line of lines) {
    if (!line.trim()) { outLines.push(line); continue; }
    if (line.length > options.blobThresholdChars) {
      const { newContent: newLine, blobsExtracted } = extractBlobs(line, options.blobThresholdChars, options.attachmentDir, savedMap, options.dryRun);
      outLines.push(newLine);
      totalBlobs += blobsExtracted;
    } else {
      outLines.push(line);
    }
  }

  return { newContent: outLines.join('\n'), blobsFound: totalBlobs };
}

/**
 * Strip base64 blobs from a VS Code chat session file.
 * @param {string} sessionPath - Absolute path to the session file (.json or .jsonl)
 * @param {StripOptions} options
 * @returns {StripResult}
 *
 * @typedef {Object} StripOptions
 * @property {string} attachmentDir
 * @property {number} [blobThresholdChars=100000]
 * @property {boolean} [dryRun=false]
 * @property {boolean} [backupOriginal=false]
 *
 * @typedef {Object} AttachmentRecord
 * @property {string} sha256
 * @property {string} savedPath
 * @property {string} mimeType
 * @property {number} originalChars
 *
 * @typedef {Object} StripResult
 * @property {string} sessionPath
 * @property {number} originalBytes
 * @property {number} strippedBytes
 * @property {number} blobsFound
 * @property {number} uniqueBlobs
 * @property {AttachmentRecord[]} attachments
 * @property {boolean} dryRun
 */
function stripAttachments(sessionPath, options) {
  const opts = {
    blobThresholdChars: DEFAULT_BLOB_THRESHOLD,
    dryRun: false,
    backupOriginal: false,
    ...options,
  };

  const content = fs.readFileSync(sessionPath, 'utf8');
  const originalBytes = Buffer.byteLength(content, 'utf8');

  const firstLine = content.slice(0, 200).trimStart();
  const isJsonl = firstLine.startsWith('{"kind"') || sessionPath.endsWith('.jsonl');

  const savedMap = new Map();
  let newContent;
  let blobsFound;

  if (isJsonl) {
    ({ newContent, blobsFound } = processJsonlFormat(sessionPath, content, opts, savedMap));
  } else {
    ({ newContent, blobsFound } = processOldJsonFormat(sessionPath, content, opts, savedMap));
  }

  const strippedBytes = Buffer.byteLength(newContent, 'utf8');
  const result = {
    sessionPath,
    originalBytes,
    strippedBytes,
    blobsFound,
    uniqueBlobs: savedMap.size,
    attachments: Array.from(savedMap.values()),
    dryRun: opts.dryRun,
  };

  if (!opts.dryRun && blobsFound > 0) {
    if (opts.backupOriginal) {
      fs.copyFileSync(sessionPath, sessionPath + '.bak');
    }
    const tmpPath = sessionPath + '.tmp';
    fs.writeFileSync(tmpPath, newContent, 'utf8');
    fs.renameSync(tmpPath, sessionPath);
  }

  return result;
}

/**
 * Re-inflate a stripped session file by replacing reference markers with original content.
 * @param {string} sessionPath - Absolute path to the stripped session file
 * @param {string} attachmentDir - Directory where attachments were saved
 * @returns {number} Number of references restored
 */
function reinflateAttachments(sessionPath, attachmentDir) {
  const content = fs.readFileSync(sessionPath, 'utf8');
  let restored = 0;

  const newContent = content.replace(/"(__qhoami:sha256:[^"]+)"/g, (match, ref) => {
    const parsed = parseRef(ref);
    if (!parsed) return match;

    for (const ext of ['.png', '.jpg', '.gif', '.webp', '.pdf', '.bin']) {
      const filePath = path.join(attachmentDir, `${parsed.sha256}${ext}`);
      if (fs.existsSync(filePath)) {
        const data = fs.readFileSync(filePath);
        const b64 = data.toString('base64');
        const mime = parsed.mime;
        const restoredVal = mime !== 'application/octet-stream'
          ? `"data:${mime};base64,${b64}"`
          : `"${b64}"`;
        restored++;
        return restoredVal;
      }
    }
    return match;
  });

  if (restored > 0) {
    const tmpPath = sessionPath + '.tmp';
    fs.writeFileSync(tmpPath, newContent, 'utf8');
    fs.renameSync(tmpPath, sessionPath);
  }

  return restored;
}

module.exports = { stripAttachments, reinflateAttachments, makeRef, parseRef };
