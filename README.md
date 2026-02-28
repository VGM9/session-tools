# @vgm9/session-tools

Tools for parsing and extracting data from VS Code Copilot chat session JSON files.

## Installation

```bash
npm install @vgm9/session-tools
```

Or add to your workspace:
```bash
npm link monorepos/session-tools
```

## CLI Usage

### Extract Images

```bash
session-extract-images <session.json> [output-dir]
```

Extract embedded base64 images from a session file:

```bash
session-extract-images ~/.../chatSessions/abc123.json ./images
```

### List Sessions

```bash
session-list <workspace-hash> [options]
```

List sessions in a workspace storage directory:

```bash
session-list fc7deee2819a0e3e3f792481dedcbc98
session-list abc123 --with-images
session-list abc123 --json
```

## Library Usage

```javascript
const {
  extractImagesFromSession,
  saveImages,
  parseSession,
  findSessionFiles,
  hasImages
} = require('@vgm9/session-tools');

// Extract images from a session
const images = extractImagesFromSession('./session.json');
console.log(`Found ${images.length} images`);

// Save them to disk
const paths = saveImages(images, './output');

// Parse session metadata
const session = parseSession('./session.json');
console.log(`Session ${session.sessionId} has ${session.requestCount} requests`);

// Find all sessions for a workspace
const files = findSessionFiles('fc7deee2819a0e3e3f792481dedcbc98');
```

## API

### `extractImagesFromSession(sessionPath)`
Extract all embedded base64 images from a session JSON file.

Returns: `Array<{index, mimeType, ext, sizeKB, base64Data, context}>`

### `extractImagesFromJson(jsonData)`
Extract images from raw JSON string content.

### `saveImages(images, outputDir, prefix?)`
Save extracted images to disk.

Returns: `Array<string>` - paths of saved files

### `parseSession(sessionPath)`
Parse session JSON and extract metadata including reboot count.

Returns: `{sessionId, creationDate, customTitle, requestCount, rebootCount, requests}`

### `findSessionFiles(storageHash, appDataPath?)`
Find all session JSON files in a workspace storage directory.

### `extractUserMessages(sessionPath)`
Extract all user messages from a session.

### `hasImages(sessionPath)`
Quick check if a session contains embedded images.

## Session File Location

VS Code stores chat sessions at:

```
Windows: %APPDATA%\Code[ - Insiders]\User\workspaceStorage\{hash}\chatSessions\
macOS:   ~/Library/Application Support/Code[ - Insiders]/User/workspaceStorage/{hash}/chatSessions/
Linux:   ~/.config/Code[ - Insiders]/User/workspaceStorage/{hash}/chatSessions/
```

The `{hash}` is derived from the workspace folder or workspace file URI.

## Session File Formats

**Legacy (VS Code <1.109):** `.json` — single JSON object with top-level `requests[]` array.

**Current (VS Code >=1.109):** `.jsonl` — newline-delimited mutation log.
- `kind:0` — initial full state snapshot (always first line)
- `kind:1` — set property at key path `k` to value `v`
- `kind:2` — push/splice array at key path `k`, values `v`, optional splice index `i`
- `kind:3` — delete property at key path `k`

All public APIs in this library handle both formats transparently via `readSessionData()`.

## Dependencies

- Optional: `@vgm9/appdata-path` for cross-platform AppData path detection

## Author

ALTAIR 0.0.Q

## License

MIT
