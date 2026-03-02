#!/usr/bin/env node
'use strict';
/**
 * session-sanitize — produce a sanitized (commitable) copy of a VS Code
 * chat session file with all message content fuzzed.
 *
 * Usage:
 *   session-sanitize <input>              — prints sanitized content to stdout
 *   session-sanitize <input> <output>     — writes to output file
 *
 * Examples:
 *   session-sanitize e9311698.jsonl test/fixtures/e9311698-sanitized.jsonl
 *   session-sanitize old-session.json   test/fixtures/old-session-sanitized.json
 */

const path = require('path');
const { sanitizeSession } = require('../lib/sanitize');

const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
const flags = process.argv.slice(2).filter(a => a.startsWith('--'));

if (args.length === 0 || flags.includes('--help') || flags.includes('-h')) {
  console.log('Usage: session-sanitize <input.jsonl|json> [output]');
  console.log('       Fuzzes all message content, preserves structural metadata.');
  console.log('       Output is safe to commit as a test fixture.');
  process.exit(args.length === 0 ? 1 : 0);
}

const inputPath = path.resolve(args[0]);
const outputPath = args[1] ? path.resolve(args[1]) : null;

try {
  const result = sanitizeSession(inputPath, outputPath);
  if (!outputPath) {
    process.stdout.write(result);
  } else {
    const inputBytes = require('fs').statSync(inputPath).size;
    const outputBytes = require('fs').statSync(outputPath).size;
    console.error(`Sanitized: ${inputPath}`);
    console.error(`  Input:  ${(inputBytes / 1024).toFixed(1)} KB`);
    console.error(`  Output: ${(outputBytes / 1024).toFixed(1)} KB`);
    console.error(`  Output: ${outputPath}`);
  }
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}
