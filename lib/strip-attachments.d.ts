export interface StripOptions {
  /** Directory to save extracted attachment files. Will be created if absent. */
  attachmentDir: string;
  /** Replace strings longer than this many characters. Default: 100_000 (100 KB). */
  blobThresholdChars?: number;
  /** If true, report what would be stripped without modifying any files. */
  dryRun?: boolean;
  /** If true, copy the session file to <path>.bak before modifying. */
  backupOriginal?: boolean;
}

export interface AttachmentRecord {
  sha256: string;
  savedPath: string;
  mimeType: string;
  originalChars: number;
}

export interface StripResult {
  sessionPath: string;
  originalBytes: number;
  strippedBytes: number;
  blobsFound: number;
  uniqueBlobs: number;
  attachments: AttachmentRecord[];
  dryRun: boolean;
}

/** Build a compact inline reference marker. */
export function makeRef(sha256: string, bytes: number, mime: string): string;

/** Parse a compact inline reference marker. Returns null if not a valid ref. */
export function parseRef(s: string): { sha256: string; bytes: number; mime: string } | null;

/**
 * Strip base64 blobs from a VS Code chat session file.
 * Writes atomically. Detects format automatically (.json vs .jsonl).
 */
export function stripAttachments(sessionPath: string, options: StripOptions): StripResult;

/**
 * Re-inflate a stripped session file by replacing reference markers with original content.
 * Returns the number of references restored.
 */
export function reinflateAttachments(sessionPath: string, attachmentDir: string): number;
