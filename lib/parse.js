'use strict';
/**
 * lib/parse.js — Session metadata extraction for @vgm9/session-tools.
 *
 * Ported from qhoami/session-runtime.ts. This is the canonical implementation
 * outside the VS Code extension. All session parsing that does NOT require
 * vscode.* API lives here.
 *
 * PUBLIC API
 * ──────────
 *   getSessionMetadata(sessionPath)   → { schemaVersion, title, patchCount }
 *   resolveJsonlPath(sessionId)       → absolute path string | null
 *   stripBlobStrings(content, maxLen) → string (safe for JSON.parse)
 *
 * FORMAT HISTORY — both formats may appear on any machine simultaneously:
 *
 *   OLD (.json, pre 2026-01-28):
 *     Single JSON object: { version, requests: [...], sessionId, customTitle, ... }
 *     Compaction signal: requests[N].result.metadata.summary != null
 *
 *   NEW (.jsonl, 2026-01-28+):
 *     Append-only CRDT log. One JSON object per line.
 *     kind:0 — header, v.version is schema version integer
 *     kind:1 — scalar field update (k=path array, v=new value)
 *     kind:2 — array/object patch (may contain base64 blobs — skip by size)
 *     Compaction signal: kind:1 where k=['requests', N, 'result'],
 *                        v.metadata.summary != null
 *
 * PATCH COUNT — exact algorithm (verified against real sessions):
 *   Count unique request identifiers (requestId string from kind:0 snapshot,
 *   or array index from kind:1 patches) where result.metadata.summary != null.
 *
 *   FALSE POSITIVES (documented; do not reintroduce):
 *     ✗ line.includes('Compacted conversation')   — text match, wrong by 8x
 *     ✗ line.includes('<conversation-summary>')   — user text false positives
 *     ✗ /"summary"\s*:\s*"./                      — string summaries, 18 hits for 6 real
 *     ✗ /"summary"\s*:\s*\{/                      — regex on JSON, wrong approach
 *     ✓ CORRECT: structural traversal, result.metadata.summary != null
 */

const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Lines longer than this are skipped in JSONL format (kind:2 array patches only).
 * kind:0 and kind:1 lines are always parsed regardless of length.
 *
 * Base64 blobs in kind:2 lines start at ~50 KB; metadata fields are < 10 KB.
 * 100 KB sits safely between the two populations.
 */
const MAX_METADATA_LINE_BYTES = 100 * 1024;

// ---------------------------------------------------------------------------
// mtime-based cache — avoids re-parsing large files on every call
// ---------------------------------------------------------------------------
const _metaCache = new Map(); // path → { mtimeMs, meta }

// ---------------------------------------------------------------------------
// stripBlobStrings
// ---------------------------------------------------------------------------

/**
 * Strip oversized JSON string literals from raw JSON text, replacing each
 * with `""`. Returns a new string that is valid JSON and contains all
 * metadata fields intact.
 *
 * WHY: VS Code old-format session files embed base64 file attachments as JSON
 * string values. A single value can be 193 MB. JSON.parse of the raw content
 * would allocate ~800 MB. After stripping, parse is fast.
 *
 * CORRECTNESS: All metadata fields (customTitle, requestId, result.metadata.summary)
 * are small. result.metadata.summary is an OBJECT, not inside a string literal —
 * it is never touched by this function.
 *
 * ALGORITHM: Single O(N) pass finding unescaped " pairs (raw string literal
 * boundaries). Not a regex over JSON structure.
 *
 * @param {string} content   Raw JSON text.
 * @param {number} [maxLen=100_000]  Replace string literals with content length > this.
 * @returns {string}
 */
function stripBlobStrings(content, maxLen = 100_000) {
  const chunks = [];
  let chunkStart = 0;
  let i = 0;
  const n = content.length;

  while (i < n) {
    const q = content.indexOf('"', i);
    if (q === -1) { break; }

    // Find matching closing quote, respecting backslash escapes.
    let j = q + 1;
    while (j < n) {
      const c = content[j];
      if (c === '\\') { j += 2; continue; } // skip escape
      if (c === '"') { j++; break; }
      j++;
    }

    const strContentLen = j - q - 2;
    if (strContentLen > maxLen) {
      chunks.push(content.slice(chunkStart, q));
      chunks.push('""');
      chunkStart = j;
    }
    i = j;
  }

  if (chunkStart === 0) { return content; } // fast path: nothing stripped
  chunks.push(content.slice(chunkStart));
  return chunks.join('');
}

// ---------------------------------------------------------------------------
// parseOldJsonFormat (pre 2026-01-28)
// ---------------------------------------------------------------------------

/**
 * @param {string} filePath
 * @param {string} content   Raw file text.
 * @param {number} mtimeMs
 * @returns {{ schemaVersion: string, title: string|null, patchCount: number|'error' }}
 */
function parseOldJsonFormat(filePath, content, mtimeMs) {
  try {
    const stripped = stripBlobStrings(content);
    const parsed = JSON.parse(stripped);
    const title = typeof parsed.customTitle === 'string' ? parsed.customTitle : null;
    let patchCount = 0;
    for (const req of parsed.requests ?? []) {
      if (req?.result?.metadata?.summary != null) { patchCount++; }
    }
    const meta = { schemaVersion: 'n/a', title, patchCount };
    _metaCache.set(filePath, { mtimeMs, meta });
    return meta;
  } catch {
    return { schemaVersion: 'error', title: null, patchCount: 'error' };
  }
}

// ---------------------------------------------------------------------------
// parseJsonlFormat (2026-01-28+)
// ---------------------------------------------------------------------------

/**
 * @param {string} filePath
 * @param {string} content   Raw file text.
 * @param {number} mtimeMs
 * @returns {{ schemaVersion: string, title: string|null, patchCount: number|'error' }}
 */
function parseJsonlFormat(filePath, content, mtimeMs) {
  let schemaVersion = 'unknown';
  let title = null;
  // Set of unique identifiers (requestId string from kind:0, or index number from kind:1)
  // for requests that had a real context compaction. Deduplicates re-patches of same request.
  const compactedRequestIds = new Set();

  for (const line of content.split('\n')) {
    if (!line.trim()) { continue; }
    try {
      // Fast kind detection — avoid full JSON.parse on oversized kind:2 lines.
      const kindMatch = line.match(/^\{"kind"\s*:\s*(\d+)/);
      const lineKind = kindMatch ? parseInt(kindMatch[1], 10) : -1;

      // Skip oversized kind:2 patches (base64 blobs) — they carry no metadata.
      if (lineKind === 2 && line.length > MAX_METADATA_LINE_BYTES) { continue; }

      const obj = JSON.parse(line);

      if (obj.kind === 0) {
        // Header snapshot — always the first line, may be 30 MB+ in long sessions.
        // Contains full v.version (schema version) and embedded request array.
        if (schemaVersion === 'unknown') {
          const v = obj.v || {};
          schemaVersion = String(v.version ?? 'unknown');
          if (title === null && typeof v.customTitle === 'string') {
            title = v.customTitle;
          }
          // Count compactions embedded in the snapshot's requests array.
          const snapshotReqs = v.requests;
          if (Array.isArray(snapshotReqs)) {
            for (const req of snapshotReqs) {
              if (!req) { continue; }
              const meta = req?.result?.metadata;
              if (meta && 'summary' in meta && meta.summary != null) {
                const id = req.requestId;
                if (id) { compactedRequestIds.add(id); }
              }
            }
          }
        }
      } else if (obj.kind === 1) {
        const k = obj.k;
        if (!Array.isArray(k)) { continue; }

        if (k.length === 1 && k[0] === 'customTitle' && typeof obj.v === 'string') {
          if (title === null) { title = obj.v; }

        } else if (k.length === 3 && k[0] === 'requests' && k[2] === 'result') {
          // Result metadata for request at index k[1].
          // summary != null → real context compaction.
          const reqIdx = k[1];
          if (typeof reqIdx !== 'number') { continue; }
          const v = obj.v || {};
          const meta = v.metadata || {};
          if ('summary' in meta && meta.summary != null) {
            compactedRequestIds.add(reqIdx);
          }
        }
      }
      // kind:2 — NOT scanned for compaction. Overcounts if you do.
    } catch { /* skip malformed lines */ }
  }

  const patchCount = compactedRequestIds.size;
  const meta = { schemaVersion, title, patchCount };
  _metaCache.set(filePath, { mtimeMs, meta });
  return meta;
}

// ---------------------------------------------------------------------------
// getSessionMetadata — public entry point
// ---------------------------------------------------------------------------

/**
 * Parse a VS Code chat session file and return metadata.
 *
 * Handles both old .json format (pre 2026-01-28) and new .jsonl format.
 * Results are mtime-cached — large sessions are only re-parsed when changed.
 *
 * @param {string} sessionPath  Absolute path to a .json or .jsonl session file.
 * @returns {{ schemaVersion: string, title: string|null, patchCount: number|'error' }}
 *   schemaVersion: v.version from kind:0 header ('unknown' if absent, 'n/a' for old format,
 *                  'error' if file unreadable)
 *   title:         customTitle from session ('n/a' for old format without title)
 *   patchCount:    unique context-window compaction events, 'error' if unreadable
 */
function getSessionMetadata(sessionPath) {
  try {
    const mtimeMs = fs.statSync(sessionPath).mtimeMs;
    const cached = _metaCache.get(sessionPath);
    if (cached?.mtimeMs === mtimeMs) { return cached.meta; }

    const content = fs.readFileSync(sessionPath, 'utf8');

    // Detect format by parsing the first line only.
    // Old format: first line is typically just '{' (not a complete JSON object).
    // New JSONL format: first line is always kind:0 (a complete small JSON object).
    // Parsing only the first line is O(line length) — never O(file size).
    const firstNewline = content.indexOf('\n');
    const firstLine = firstNewline === -1 ? content : content.slice(0, firstNewline);
    let firstObj = null;
    try { firstObj = JSON.parse(firstLine); } catch { /* expected for old format */ }
    const isJsonl = firstObj !== null && firstObj.kind === 0;

    return isJsonl
      ? parseJsonlFormat(sessionPath, content, mtimeMs)
      : parseOldJsonFormat(sessionPath, content, mtimeMs);
  } catch {
    return { schemaVersion: 'error', title: null, patchCount: 'error' };
  }
}

// ---------------------------------------------------------------------------
// resolveJsonlPath
// ---------------------------------------------------------------------------

/**
 * Find the absolute path to the JSONL session file for a given session ID.
 *
 * Accepts UUID form (`xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`) or legacy
 * base64-encoded form for backward compatibility.
 *
 * Scans workspaceStorage under Code Insiders, then Code stable. Pure fs
 * operation — no VS Code API needed.
 *
 * @param {string} sessionId  Session UUID or base64-encoded UUID.
 * @returns {string|null}     Absolute path, or null if not found.
 */
function resolveJsonlPath(sessionId) {
  try {
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

    let uuid = sessionId;
    if (!UUID_RE.test(uuid)) {
      // Try decoding as base64 → UUID
      try {
        const decoded = Buffer.from(sessionId, 'base64').toString('utf8');
        if (UUID_RE.test(decoded)) { uuid = decoded; }
      } catch { /* use as-is */ }
    }

    const filename = uuid + '.jsonl';
    const appData = process.env.APPDATA;
    if (!appData) { return null; }

    const roots = [
      path.join(appData, 'Code - Insiders', 'User', 'workspaceStorage'),
      path.join(appData, 'Code', 'User', 'workspaceStorage'),
    ];

    for (const root of roots) {
      if (!fs.existsSync(root)) { continue; }
      for (const hash of fs.readdirSync(root)) {
        const candidate = path.join(root, hash, 'chatSessions', filename);
        if (fs.existsSync(candidate)) { return candidate; }
      }
    }
    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  getSessionMetadata,
  resolveJsonlPath,
  stripBlobStrings,
  // Lower-level — exported for testing; prefer getSessionMetadata for normal use.
  parseOldJsonFormat,
  parseJsonlFormat,
};
