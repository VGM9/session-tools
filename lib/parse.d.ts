/**
 * Type declarations for @vgm9/session-tools/lib/parse
 *
 * Canonical session metadata extraction for VS Code chat session files.
 * Handles both old .json format (pre 2026-01-28) and new .jsonl format.
 */

export interface SessionMetadata {
  /**
   * 'n/a'      — old .json format (no kind:0 header)
   * 'unknown'  — .jsonl format but kind:0.v.version was absent
   * 'error'    — file could not be read or parsed
   * otherwise  — the integer schema version as a string (e.g. '3')
   */
  schemaVersion: string;
  /** Session custom title, or null if not set. */
  title: string | null;
  /**
   * Count of unique context-window compaction events (real agent reboots).
   * 'error' if the file could not be read.
   * See parse.js docs for the exact algorithm and false-positive history.
   */
  patchCount: number | 'error';
}

/**
 * Parse a VS Code chat session file and return metadata.
 *
 * Handles both old .json format (pre 2026-01-28) and new .jsonl format.
 * Results are mtime-cached — large sessions are only re-parsed when changed.
 *
 * @param sessionPath  Absolute path to a .json or .jsonl session file.
 */
export function getSessionMetadata(sessionPath: string): SessionMetadata;

/**
 * Find the absolute path to the JSONL session file for a given session ID.
 *
 * Accepts UUID form or legacy base64-encoded form.
 * Scans workspaceStorage under Code Insiders, then Code stable.
 * Pure fs operation — no VS Code API needed.
 *
 * @returns Absolute path, or null if not found.
 */
export function resolveJsonlPath(sessionId: string): string | null;

/**
 * Strip oversized JSON string literals from raw JSON text, replacing each with "".
 * Returns a new string that is valid JSON and contains all metadata fields intact.
 *
 * Use before JSON.parse on old-format session files that embed large base64 blobs.
 *
 * @param content  Raw JSON text from fs.readFileSync.
 * @param maxLen   Replace string literals with content length exceeding this. Default 100_000.
 */
export function stripBlobStrings(content: string, maxLen?: number): string;

/**
 * Parse old .json format session file (pre 2026-01-28).
 * @internal Lower-level — use getSessionMetadata() for normal use.
 */
export function parseOldJsonFormat(
  filePath: string,
  content: string,
  mtimeMs: number
): SessionMetadata;

/**
 * Parse new .jsonl format session file (2026-01-28+).
 * @internal Lower-level — use getSessionMetadata() for normal use.
 */
export function parseJsonlFormat(
  filePath: string,
  content: string,
  mtimeMs: number
): SessionMetadata;
