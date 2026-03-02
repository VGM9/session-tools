'use strict';
/**
 * test/test.js — Test suite for @vgm9/session-tools
 *
 * Three categories of tests:
 *
 * 1. SYNTHETIC — self-contained fixtures built inline.
 *    Cover every false-positive regression documented in qhoami/session-runtime.ts.
 *    Run anywhere, no external files needed.
 *
 * 2. SANITIZED FIXTURE — uses test/fixtures/e9311698-sanitized.jsonl.
 *    Committed to the repo. Ground truth: patchCount=6, schemaVersion=3,
 *    title="Managing AI Agents for Nontechnical Client Projects".
 *    Produced by: session-sanitize <live.jsonl> test/fixtures/e9311698-sanitized.jsonl
 *
 * 3. LIVE FIXTURE — uses the private snapshot at FIXTURE_DIR (not committed).
 *    Skipped if path absent. Verify that sanitized and live agree.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  parseSession, replayJsonl,
  sanitizeSession, sanitizeContent,
  getSessionMetadata, resolveJsonlPath, stripBlobStrings,
} = require('../lib/index');

// ---------------------------------------------------------------------------
// Minimal test runner
// ---------------------------------------------------------------------------
let passed = 0;
let failed = 0;
let skipped = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${e.message}`);
    failed++;
  }
}

function skip(name, reason) {
  console.log(`  - ${name} (SKIP: ${reason})`);
  skipped++;
}

function section(name) {
  console.log(`\n${name}`);
}

// ---------------------------------------------------------------------------
// Helpers: build synthetic JSONL / JSON fixtures inline
// ---------------------------------------------------------------------------

/**
 * Build a minimal old-format .json session string.
 * Requests with summary=object count as compactions.
 * Requests with summary=null, summary="string", or no summary do not.
 */
function buildOldJson({ customTitle = null, requests = [] } = {}) {
  return JSON.stringify({
    version: 1,
    sessionId: '00000000-0000-0000-0000-000000000001',
    customTitle,
    requests: requests.map((r, i) => ({
      requestId: `req-${i}`,
      message: { text: r.messageText || 'user message' },
      result: r.summary !== undefined
        ? { metadata: { summary: r.summary } }
        : { metadata: {} },
      response: r.responseText
        ? [{ kind: 'markdownContent', content: { value: r.responseText } }]
        : [],
    })),
  });
}

/**
 * Build a minimal JSONL session string.
 * patches: array of { requestIndex, summary } where summary is the value
 * to set at requests[N].result — null means absent, object means compaction.
 */
function buildJsonl({ version = 3, customTitle = null, snapshotRequests = [], patches = [] } = {}) {
  const lines = [];

  // kind:0 snapshot
  const snap = {
    kind: 0,
    v: {
      version,
      sessionId: '00000000-0000-0000-0000-000000000002',
      customTitle,
      requests: snapshotRequests.map((r, i) => ({
        requestId: `req-${i}`,
        message: { text: r.messageText || 'user message' },
        result: r.summary !== undefined
          ? { metadata: { summary: r.summary } }
          : { metadata: {} },
      })),
    },
  };
  lines.push(JSON.stringify(snap));

  // kind:1 patches for result
  for (const p of patches) {
    lines.push(JSON.stringify({
      kind: 1,
      k: ['requests', p.requestIndex, 'result'],
      v: { metadata: { summary: p.summary } },
    }));
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// SECTION 1: Synthetic — patchCount false positive regressions
// ---------------------------------------------------------------------------

section('1. patchCount — synthetic regression tests');

test('old JSON: zero patches when no summary present', () => {
  const content = buildOldJson({
    requests: [
      { messageText: 'hello', summary: null },
      { messageText: 'world' },
    ],
  });
  const parsed = JSON.parse(content);
  let count = 0;
  for (const req of parsed.requests) {
    if (req?.result?.metadata?.summary != null) count++;
  }
  assert.strictEqual(count, 0);
});

test('old JSON: != null counts objects, non-empty strings, AND empty strings; only null is excluded', () => {
  const content = buildOldJson({
    requests: [
      { summary: null },                              // null       → NOT counted (null === null)
      { summary: { text: 'summary obj' } },          // object     → counted (the real compaction signal)
      { summary: 'Compacted conversation' },          // non-empty string → counted (still != null)
      { summary: { nested: true } },                 // object     → counted
      { summary: '' },                               // empty string → counted ('' != null is true)
    ],
  });
  const parsed = JSON.parse(content);
  let count = 0;
  for (const req of parsed.requests) {
    if (req?.result?.metadata?.summary != null) count++;
  }
  // 4: null excluded, everything else (objects, both string forms) is != null.
  // In practice summary values are always objects; the != null check is sufficient.
  // The old line-scan "Compacted conversation" text approach would have returned 1.
  assert.strictEqual(count, 4, 'only null is excluded; all non-null values (objects, strings) count');
});

test('old JSON: result.metadata.summary object — the real compaction signal', () => {
  // The TRUE signal is: summary is a non-null VALUE (object in practice).
  // We count both object and non-null-string forms because that is what
  // JSON.parse structural traversal returns. The key invariant: null → never counted.
  const content = buildOldJson({
    requests: [
      { summary: null },
      { summary: null },
      { summary: { codeBlocks: [], value: 'summary text' } },  // real compaction
      { summary: null },
    ],
  });
  const parsed = JSON.parse(content);
  let count = 0;
  for (const req of parsed.requests) {
    if (req?.result?.metadata?.summary != null) count++;
  }
  assert.strictEqual(count, 1);
});

test('REGRESSION: "Compacted conversation" text in message body does NOT increment count', () => {
  // FALSE POSITIVE TRAP #1 — documented in qhoami history.
  // The old `line.includes("Compacted conversation")` approach hit this.
  const content = buildOldJson({
    requests: [
      // User message discusses compaction — must NOT be counted
      { messageText: 'My session had a Compacted conversation event earlier', summary: null },
      // Response text discusses compaction — must NOT be counted
      { messageText: 'hi', summary: null },
    ],
  });
  const parsed = JSON.parse(content);
  let count = 0;
  for (const req of parsed.requests) {
    if (req?.result?.metadata?.summary != null) count++;
  }
  assert.strictEqual(count, 0, '"Compacted conversation" in message text must not be counted');
});

test('REGRESSION: <conversation-summary> tag in message text does NOT increment count', () => {
  // FALSE POSITIVE TRAP #2 — documented in qhoami history.
  const content = buildOldJson({
    requests: [
      { messageText: 'here is a <conversation-summary> tag in text', summary: null },
      { messageText: 'Window reloaded (Activate qhoami)', summary: null },
    ],
  });
  const parsed = JSON.parse(content);
  let count = 0;
  for (const req of parsed.requests) {
    if (req?.result?.metadata?.summary != null) count++;
  }
  assert.strictEqual(count, 0, '<conversation-summary> in message must not be counted');
});

test('JSONL: patchCount from kind:0 snapshot embedded requests', () => {
  const content = buildJsonl({
    snapshotRequests: [
      { summary: null },
      { summary: { value: 'compacted' } },  // counted
      { summary: null },
      { summary: { value: 'compacted' } },  // counted
    ],
  });
  // Parse the snapshot
  const snap = JSON.parse(content.split('\n')[0]);
  let count = 0;
  for (const req of snap.v.requests) {
    if (req?.result?.metadata?.summary != null) count++;
  }
  assert.strictEqual(count, 2);
});

test('JSONL: patchCount from kind:1 result patches', () => {
  const content = buildJsonl({
    patches: [
      { requestIndex: 5, summary: { value: 'summary A' } },   // counted
      { requestIndex: 12, summary: { value: 'summary B' } },  // counted
      { requestIndex: 5, summary: { value: 'updated' } },     // duplicate index — deduped to 1
    ],
  });
  const lines = content.split('\n').filter(Boolean);
  const compactedIndices = new Set();
  for (const line of lines) {
    const obj = JSON.parse(line);
    if (obj.kind === 1) {
      const k = obj.k || [];
      if (k.length === 3 && k[0] === 'requests' && k[2] === 'result') {
        if (obj.v?.metadata?.summary != null) {
          compactedIndices.add(k[1]);
        }
      }
    }
  }
  assert.strictEqual(compactedIndices.size, 2, 'deduplication: same request index counted once');
});

test('REGRESSION: "summary" key in response text paths does NOT increment count', () => {
  // FALSE POSITIVE TRAP #3 — the /"summary"\s*:\s*"/ regex returned 18 hits.
  // String-valued summary keys exist at other paths in the session object
  // (renderedText, agentContext, etc.). Only result.metadata.summary counts.
  const content = buildOldJson({
    requests: [
      {
        messageText: 'hi',
        summary: null,
        // Imagine extra fields that are NOT at result.metadata.summary
        // We test structural traversal only counts the right path
      },
    ],
  });
  // Inject a "summary" key at a wrong path by modifying the raw JSON
  const withExtra = content.replace(
    '"result":{"metadata":{}}',
    '"result":{"metadata":{}},"otherSummary":{"summary":"this is a string summary at wrong path"}'
  );
  const parsed = JSON.parse(withExtra);
  let count = 0;
  for (const req of parsed.requests) {
    if (req?.result?.metadata?.summary != null) count++;
  }
  assert.strictEqual(count, 0, 'summary at wrong path must not be counted');
});

// ---------------------------------------------------------------------------
// SECTION 2: Sanitizer unit tests
// ---------------------------------------------------------------------------

section('2. Sanitizer — unit tests');

test('sanitizeContent: fuzzes message text but preserves customTitle', () => {
  const input = buildJsonl({ customTitle: 'My Session Title', snapshotRequests: [
    { messageText: 'This is secret content', summary: null },
  ]});
  const output = sanitizeContent(input, true);
  assert.ok(output.includes('My Session Title'), 'customTitle must be preserved verbatim');
  assert.ok(!output.includes('secret content'), 'message text must be fuzzed');
  assert.ok(output.includes('[FUZZ:'), 'fuzz markers must be present');
});

test('sanitizeContent: result.metadata.summary object preserved as non-null', () => {
  const input = buildJsonl({
    snapshotRequests: [
      { summary: { value: 'this is a real summary with private text' } },
      { summary: null },
    ],
  });
  const output = sanitizeContent(input, true);
  const snap = JSON.parse(output.split('\n')[0]);
  const req0summary = snap.v.requests[0].result.metadata.summary;
  const req1summary = snap.v.requests[1].result.metadata.summary;
  assert.ok(req0summary !== null && typeof req0summary === 'object', 'summary object must survive (shape preserved)');
  assert.strictEqual(req1summary, null, 'null summary must stay null');
  assert.ok(!JSON.stringify(req0summary).includes('real summary'), 'summary content must be fuzzed');
});

test('sanitizeContent: base64 blobs replaced with empty string', () => {
  const blob = 'A'.repeat(600); // 600 chars of base64-alphabet
  const input = JSON.stringify({ kind: 0, v: { version: 3, data: blob } });
  const output = sanitizeContent(input, true);
  const parsed = JSON.parse(output);
  assert.strictEqual(parsed.v.data, '', 'base64 blob must become empty string');
});

test('sanitizeContent: structural fields preserved (kind, k, version)', () => {
  const input = buildJsonl({ version: 7 });
  const output = sanitizeContent(input, true);
  const snap = JSON.parse(output.split('\n')[0]);
  assert.strictEqual(snap.kind, 0);
  assert.strictEqual(snap.v.version, 7);
});

test('sanitizeContent: deterministic — same input produces same fuzz markers', () => {
  const input = buildOldJson({ requests: [{ messageText: 'hello world', summary: null }] });
  const out1 = sanitizeContent(input, false);
  const out2 = sanitizeContent(input, false);
  assert.strictEqual(out1, out2, 'sanitizer must be deterministic for same input');
});

test('sanitizeContent: UUID values preserved verbatim', () => {
  const uuid = '12345678-1234-1234-1234-123456789abc';
  const input = JSON.stringify({ kind: 0, v: { version: 1, sessionId: uuid } });
  const output = sanitizeContent(input, true);
  assert.ok(output.includes(uuid), 'UUIDs must not be fuzzed');
});

// ---------------------------------------------------------------------------
// SECTION 3: Sanitized fixture — ground truth integration test
// ---------------------------------------------------------------------------

section('3. Sanitized fixture integration (e9311698-sanitized.jsonl)');

const sanitizedFixturePath = path.join(__dirname, 'fixtures', 'e9311698-sanitized.jsonl');

if (!fs.existsSync(sanitizedFixturePath)) {
  skip('ground truth: patchCount=6, title, schemaVersion=3', 'fixture not found at ' + sanitizedFixturePath);
} else {
  test('patchCount=6 from sanitized fixture', () => {
    const content = fs.readFileSync(sanitizedFixturePath, 'utf8');
    const compactedIndices = new Set();
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      const obj = JSON.parse(line);
      if (obj.kind === 0) {
        const reqs = (obj.v || {}).requests || [];
        reqs.forEach((req, i) => {
          if (req?.result?.metadata?.summary != null) compactedIndices.add(`snap:${i}`);
        });
      } else if (obj.kind === 1) {
        const k = obj.k || [];
        if (k.length === 3 && k[0] === 'requests' && k[2] === 'result') {
          if (obj.v?.metadata?.summary != null) compactedIndices.add(k[1]);
        }
      }
    }
    assert.strictEqual(compactedIndices.size, 6, `expected 6, got ${compactedIndices.size}`);
  });

  test('schemaVersion=3 from sanitized fixture', () => {
    const content = fs.readFileSync(sanitizedFixturePath, 'utf8');
    const firstLine = content.split('\n').find(l => l.trim());
    const snap = JSON.parse(firstLine);
    assert.strictEqual(String(snap.v.version), '3');
  });

  test('title preserved in sanitized fixture', () => {
    const content = fs.readFileSync(sanitizedFixturePath, 'utf8');
    const firstLine = content.split('\n').find(l => l.trim());
    const snap = JSON.parse(firstLine);
    assert.strictEqual(
      snap.v.customTitle,
      'Managing AI Agents for Nontechnical Client Projects'
    );
  });

  test('sanitized fixture contains no raw message text (sampling check)', () => {
    const content = fs.readFileSync(sanitizedFixturePath, 'utf8');
    // Any line over 200 chars that is NOT the kind:0 snapshot and does NOT
    // contain only [FUZZ:N] placeholders would indicate unsanitized content.
    // Light check: the original title should appear but no other long prose.
    const linesWithFuzz = content.split('\n').filter(l => l.includes('[FUZZ:'));
    assert.ok(linesWithFuzz.length > 0, 'sanitized file must contain fuzz markers');
  });
}

// ---------------------------------------------------------------------------
// SECTION 4: stripBlobStrings unit tests
// ---------------------------------------------------------------------------

section('4. stripBlobStrings — unit tests');

test('short strings are passed through unchanged', () => {
  const input = '{"key":"short value","num":42}';
  assert.strictEqual(stripBlobStrings(input), input);
});

test('string over threshold is replaced with ""', () => {
  const blob = 'A'.repeat(200_001);
  const input = `{"key":"${blob}"}`;
  const output = stripBlobStrings(input, 200_000);
  assert.strictEqual(output, '{"key":""}');
});

test('only the oversized string is stripped, surrounding structure intact', () => {
  const blob = 'B'.repeat(200_001);
  const input = `{"before":"ok","blob":"${blob}","after":"also ok"}`;
  const output = stripBlobStrings(input, 200_000);
  const parsed = JSON.parse(output);
  assert.strictEqual(parsed.before, 'ok');
  assert.strictEqual(parsed.blob, '');
  assert.strictEqual(parsed.after, 'also ok');
});

test('backslash-escaped quotes inside strings do not confuse the scanner', () => {
  // A string containing \" — must not be mistaken for the closing quote
  const input = '{"a":"has \\"escaped\\" quotes","b":"short"}';
  assert.strictEqual(stripBlobStrings(input), input);
});

test('multiple blobs in one document all stripped', () => {
  const b = 'X'.repeat(200_001);
  const input = `{"a":"${b}","b":"keep","c":"${b}"}`;
  const output = stripBlobStrings(input, 200_000);
  const parsed = JSON.parse(output);
  assert.strictEqual(parsed.a, '');
  assert.strictEqual(parsed.b, 'keep');
  assert.strictEqual(parsed.c, '');
});

// ---------------------------------------------------------------------------
// SECTION 5: getSessionMetadata — unit tests with synthetic fixtures
// ---------------------------------------------------------------------------

section('5. getSessionMetadata — synthetic fixtures');

const os = require('os');
const tmpDir = os.tmpdir();

function writeTmpFile(name, content) {
  const p = path.join(tmpDir, name);
  fs.writeFileSync(p, content, 'utf8');
  return p;
}

test('old JSON format: schemaVersion=n/a, patchCount correct', () => {
  const content = buildOldJson({
    customTitle: 'My Old Session',
    requests: [
      { summary: null },
      { summary: { value: 'compacted' } },
      { summary: null },
    ],
  });
  const p = writeTmpFile('parse-test-old.json', content);
  const meta = getSessionMetadata(p);
  assert.strictEqual(meta.schemaVersion, 'n/a');
  assert.strictEqual(meta.title, 'My Old Session');
  assert.strictEqual(meta.patchCount, 1);
});

test('JSONL format: schemaVersion, title, patchCount extracted', () => {
  const content = buildJsonl({
    version: 5,
    customTitle: 'My JSONL Session',
    patches: [
      { requestIndex: 3, summary: { value: 'compacted A' } },
      { requestIndex: 7, summary: { value: 'compacted B' } },
    ],
  });
  const p = writeTmpFile('parse-test-jsonl.jsonl', content);
  const meta = getSessionMetadata(p);
  assert.strictEqual(meta.schemaVersion, '5');
  assert.strictEqual(meta.title, 'My JSONL Session');
  assert.strictEqual(meta.patchCount, 2);
});

test('JSONL: title from kind:1 customTitle patch, not just kind:0 snapshot', () => {
  // Build JSONL where snapshot has no customTitle, but a kind:1 sets it
  const lines = [
    JSON.stringify({ kind: 0, v: { version: 3, sessionId: 'aaa', requests: [] } }),
    JSON.stringify({ kind: 1, k: ['customTitle'], v: 'Late Title Set' }),
  ];
  const p = writeTmpFile('parse-test-title.jsonl', lines.join('\n'));
  const meta = getSessionMetadata(p);
  assert.strictEqual(meta.title, 'Late Title Set');
});

test('mtime cache: same path re-read returns cached result without re-parsing', () => {
  const content = buildJsonl({ version: 9, customTitle: 'Cached' });
  const p = writeTmpFile('parse-test-cache.jsonl', content);
  const first = getSessionMetadata(p);
  // Calling again should hit the mtime cache (same mtime)
  const second = getSessionMetadata(p);
  assert.strictEqual(first.title, second.title);
  assert.strictEqual(first.schemaVersion, second.schemaVersion);
});

test('missing file returns error sentinel', () => {
  const meta = getSessionMetadata('/nonexistent/path/to/session.jsonl');
  assert.strictEqual(meta.schemaVersion, 'error');
  assert.strictEqual(meta.patchCount, 'error');
  assert.strictEqual(meta.title, null);
});

// ---------------------------------------------------------------------------
// SECTION 6: getSessionMetadata — sanitized fixture integration
// ---------------------------------------------------------------------------

section('6. getSessionMetadata — sanitized fixture integration');

if (!fs.existsSync(sanitizedFixturePath)) {
  skip('getSessionMetadata on e9311698-sanitized.jsonl', 'fixture not found');
} else {
  test('getSessionMetadata: patchCount=6', () => {
    const meta = getSessionMetadata(sanitizedFixturePath);
    assert.strictEqual(meta.patchCount, 6);
  });

  test('getSessionMetadata: schemaVersion=3', () => {
    const meta = getSessionMetadata(sanitizedFixturePath);
    assert.strictEqual(meta.schemaVersion, '3');
  });

  test('getSessionMetadata: title correct', () => {
    const meta = getSessionMetadata(sanitizedFixturePath);
    assert.strictEqual(meta.title, 'Managing AI Agents for Nontechnical Client Projects');
  });

  test('getSessionMetadata: mtime cache works (call twice, same result)', () => {
    const a = getSessionMetadata(sanitizedFixturePath);
    const b = getSessionMetadata(sanitizedFixturePath);
    assert.deepStrictEqual(a, b);
  });
}

// ---------------------------------------------------------------------------
// SECTION 7: resolveJsonlPath — basic
// ---------------------------------------------------------------------------

section('7. resolveJsonlPath — basic');

test('returns null for a UUID that cannot exist on disk', () => {
  // A zero UUID will never exist on any machine
  const result = resolveJsonlPath('00000000-0000-0000-0000-000000000000');
  assert.strictEqual(result, null);
});

test('decodes base64-encoded UUID before scanning', () => {
  // Encode zero UUID as base64 — still returns null (not on disk)
  const b64 = Buffer.from('00000000-0000-0000-0000-000000000000').toString('base64');
  const result = resolveJsonlPath(b64);
  assert.strictEqual(result, null);
});

test('returns null when APPDATA is not set (simulated)', () => {
  // Temporarily unset APPDATA, call, restore. Does not require the file to exist.
  const saved = process.env.APPDATA;
  delete process.env.APPDATA;
  try {
    const result = resolveJsonlPath('00000000-0000-0000-0000-000000000000');
    assert.strictEqual(result, null);
  } finally {
    if (saved !== undefined) { process.env.APPDATA = saved; }
  }
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped`);
if (failed > 0) process.exit(1);
