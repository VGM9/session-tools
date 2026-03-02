/**
 * Type declarations for @vgm9/session-tools
 *
 * @vgm9/session-tools — VS Code chat session parsing and extraction utilities.
 */

// Re-export all parse declarations
export {
  SessionMetadata,
  getSessionMetadata,
  resolveJsonlPath,
  stripBlobStrings,
  parseOldJsonFormat,
  parseJsonlFormat,
} from './parse';

// --- Image extraction ---

export interface ImageData {
  index: number;
  mimeType: string;
  ext: string;
  size: number;
  sizeKB: number;
  base64Data: string;
  context: string;
}

export function extractImagesFromSession(sessionPath: string): ImageData[];
export function extractImagesFromJson(jsonData: string): ImageData[];
export function saveImages(
  images: ImageData[],
  outputDir: string,
  prefix?: string
): string[];

// --- Session parsing (legacy full-replay API) ---

export interface RequestSummary {
  index: number;
  timestamp: Date | null;
  messagePreview: string | undefined;
  responseCount: number;
}

export interface ParsedSession {
  sessionId: string;
  creationDate: Date | null;
  customTitle: string | null;
  requestCount: number;
  rebootCount: number;
  requests: RequestSummary[];
}

export interface UserMessage {
  index: number;
  timestamp: Date | null;
  text: string;
}

export function readSessionData(sessionPath: string): Record<string, unknown>;
export function replayJsonl(content: string): Record<string, unknown>;
export function parseSession(sessionPath: string): ParsedSession;
export function findSessionFiles(
  storageHash: string,
  appDataPath?: string | null
): string[];
export function extractUserMessages(sessionPath: string): UserMessage[];
export function hasImages(sessionPath: string): boolean;

// --- Sanitizer ---

export function sanitizeSession(
  sessionPath: string,
  outputPath?: string | null
): string;
export function sanitizeContent(content: string): string;
