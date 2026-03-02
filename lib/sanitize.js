'use strict';
/**
 * sanitize.js — Produce a sanitized copy of a VS Code chat session file.
 *
 * WHAT THIS DOES
 * ──────────────
 * Walks every string value in the session file. Strings at known metadata
 * paths are kept verbatim. All other strings are replaced with a
 * deterministic placeholder "[FUZZ:N]" where N increments per unique
 * original string (same original → same N within a run).
 * Base64 blobs (strings > 500 chars of base64 alphabet) are replaced with "".
 *
 * WHAT IS PRESERVED VERBATIM
 * ──────────────────────────
 * • JSONL structural fields: kind, k (key path array), i (splice index)
 * • schemaVersion / version
 * • customTitle
 * • timestamps (ISO strings, ms numbers)
 * • model identifiers  (e.g. "copilot/claude-sonnet-4.6")
 * • modeKind / modeId / modeSlug / agentId
 * • result.metadata.summary — OBJECT SHAPE ONLY: presence vs null is the
 *   patchCount signal; string content inside the summary IS fuzzed
 * • sessionId (UUID)
 * • JSON structural types: numbers, booleans, null, arrays, objects — untouched
 *
 * WHY THIS EXISTS
 * ───────────────
 * Real session files contain private conversation text and cannot be
 * committed to public repos as test fixtures. Sanitized sessions preserve
 * all structural properties used by the parsers (patchCount, title, model,
 * format detection) while making message content unreadable.
 *
 * USAGE (library)
 * ───────────────
 *   const { sanitizeSession } = require('@vgm9/session-tools/lib/sanitize');
 *   sanitizeSession('/path/to/session.jsonl', '/path/to/output.jsonl');
 *   sanitizeSession('/path/to/session.json',  '/path/to/output.json');
 *   // or get the string:
 *   const safe = sanitizeSession('/path/to/session.jsonl');  // returns string if no outPath
 *
 * USAGE (CLI)
 * ──────────
 *   session-sanitize <input> [output]
 *   session-sanitize e9311698.jsonl test/fixtures/e9311698-sanitized.jsonl
 */

const fs = require('fs');
const path = require('path');

// ── Metadata key allowlist ───────────────────────────────────────────────────
// These exact key names at any depth are preserved verbatim regardless of value.
// Everything else that is a plain string gets fuzzed.
const VERBATIM_KEYS = new Set([
  // structural JSONL fields
  'kind', 'k', 'i',
  // versioning
  'version', 'schemaVersion', 'v_version',
  // identity
  'sessionId',
  // title — short human readable, needed for title tests
  'customTitle',
  // timestamps — ISO strings or ms numbers
  'timestamp', 'creationDate', 'lastMessageDate',
  // model / mode — known short identifiers, not user content
  'model', 'modelId', 'modeKind', 'modeId', 'modeSlug', 'agentId',
  'vendor', 'family',
  // file structure keys that are not content
  'ext', 'mimeType', 'size', 'sizeKB', 'index',
  // result metadata keys — PRESENCE matters, not content
  // (we keep the key names but fuzz string values inside)
]);

// These key names at any depth signal that the VALUE (if object/present) is
// the patchCount structural signal — we must preserve the object shape
// (non-null vs null) but fuzz string leaf values inside.
const STRUCTURAL_PRESENCE_KEYS = new Set([
  'summary',   // result.metadata.summary — non-null object = compaction event
  'metadata',
]);

// Base64 detection: a string is almost certainly a blob if it's long and
// consists mostly of base64 alphabet characters.
const BASE64_RE = /^[A-Za-z0-9+/=]{500,}$/;
// Also catch data URIs
const DATA_URI_RE = /^data:[^;]+;base64,/;

/**
 * Sanitize the content of a session file (string input, string output).
 * @param {string} content  Raw file content.
 * @param {boolean} isJsonl  True for .jsonl, false for old .json.
 * @returns {string}  Sanitized content, safe to commit.
 */
function sanitizeContent(content, isJsonl) {
  // fuzzMap: original string → placeholder index (deterministic within this run)
  const fuzzMap = new Map();
  let fuzzCounter = 0;

  function fuzzString(s) {
    if (BASE64_RE.test(s) || DATA_URI_RE.test(s)) { return ''; }
    if (!fuzzMap.has(s)) {
      fuzzMap.set(s, fuzzCounter++);
    }
    return `[FUZZ:${fuzzMap.get(s)}]`;
  }

  /**
   * Walk an arbitrary JSON value, fuzzing strings at non-metadata paths.
   * @param {*}      value    The value to walk.
   * @param {string} keyName  The key name under which this value appeared ('' for root).
   * @returns {*}  Sanitized value.
   */
  function walk(value, keyName) {
    if (value === null || typeof value !== 'object' && typeof value !== 'string') {
      // number, boolean, null, undefined — pass through
      return value;
    }

    if (typeof value === 'string') {
      // Verbatim if the containing key is in the allowlist
      if (VERBATIM_KEYS.has(keyName)) { return value; }
      // Verbatim if it looks like a UUID (session/request IDs)
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) { return value; }
      // Verbatim if it looks like an ISO timestamp
      if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(value)) { return value; }
      return fuzzString(value);
    }

    if (Array.isArray(value)) {
      return value.map(item => walk(item, keyName));
    }

    // Object: walk each key
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (VERBATIM_KEYS.has(k)) {
        // Keep value verbatim (but if it's an object/array, still walk children
        // so blobs inside are stripped)
        out[k] = typeof v === 'string' ? v : walk(v, k);
      } else if (STRUCTURAL_PRESENCE_KEYS.has(k)) {
        // Preserve shape: null stays null, object stays object (fuzz insides),
        // string gets fuzzed
        if (v === null || v === undefined) {
          out[k] = v;
        } else if (typeof v === 'object') {
          out[k] = walk(v, k); // recurse — fuzz string leaves inside
        } else {
          out[k] = fuzzString(String(v));
        }
      } else {
        out[k] = walk(v, k);
      }
    }
    return out;
  }

  if (isJsonl) {
    const lines = content.split('\n');
    const outLines = lines.map(line => {
      const trimmed = line.trim();
      if (!trimmed) { return ''; }
      try {
        const obj = JSON.parse(trimmed);
        const sanitized = walk(obj, '');
        return JSON.stringify(sanitized);
      } catch {
        return line; // leave unparseable lines as-is
      }
    });
    return outLines.join('\n');
  } else {
    // Old .json format — single JSON object
    const obj = JSON.parse(content);
    return JSON.stringify(walk(obj, ''), null, 2);
  }
}

/**
 * Sanitize a session file. Writes output to outPath if provided,
 * otherwise returns the sanitized string.
 *
 * @param {string}       sessionPath  Absolute path to input session file.
 * @param {string|null}  [outPath]    Output path. If omitted, returns string.
 * @returns {string|undefined}  Sanitized content if outPath omitted.
 */
function sanitizeSession(sessionPath, outPath) {
  const content = fs.readFileSync(sessionPath, 'utf8');
  // Format detection: JSONL if first non-whitespace JSON has a "kind" field,
  // or if file ends with .jsonl.  Same logic as the main parser.
  const firstLine = content.trimStart().slice(0, 200);
  const isJsonl = sessionPath.endsWith('.jsonl') ||
    (firstLine.startsWith('{') && /"kind"\s*:/.test(firstLine));

  const result = sanitizeContent(content, isJsonl);

  if (outPath) {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, result, 'utf8');
    return undefined;
  }
  return result;
}

module.exports = { sanitizeSession, sanitizeContent };
