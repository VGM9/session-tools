#!/usr/bin/env node

/**
 * Read a single message from a chat session by index
 * 
 * Usage:
 *   node read-message.js --index=5                    # Read message 5 from current session
 *   node read-message.js --index=-1                   # Read last message
 *   node read-message.js --index=5 --session=abc123   # Read from specific session
 *   node read-message.js --index=5 --response         # Include response summary
 * 
 * This is the ETHICAL alternative to qopilot_get_session(includeHistory=true)
 * which dumps ALL messages and kills agent context.
 */

const fs = require('fs');
const path = require('path');
const { readSessionData } = require('../lib/index.js');

function getAppDataPath() {
  const platform = process.platform;
  if (platform === 'win32') {
    const appData = process.env.APPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Roaming');
    // Check for Insiders first
    const insidersPath = path.join(appData, 'Code - Insiders', 'User');
    if (fs.existsSync(insidersPath)) {
      return insidersPath;
    }
    return path.join(appData, 'Code', 'User');
  } else if (platform === 'darwin') {
    return path.join(process.env.HOME || '', 'Library', 'Application Support', 'Code', 'User');
  } else {
    return path.join(process.env.HOME || '', '.config', 'Code', 'User');
  }
}

function findCurrentSession() {
  const appData = getAppDataPath();
  const storageBase = path.join(appData, 'workspaceStorage');
  
  if (!fs.existsSync(storageBase)) {
    return null;
  }
  
  let latestSession = null;
  let latestTime = 0;
  
  for (const hash of fs.readdirSync(storageBase)) {
    const sessionsDir = path.join(storageBase, hash, 'chatSessions');
    if (!fs.existsSync(sessionsDir)) continue;
    
    for (const file of fs.readdirSync(sessionsDir)) {
      if (!file.endsWith('.json') && !file.endsWith('.jsonl')) continue;

      const filePath = path.join(sessionsDir, file);
      const stat = fs.statSync(filePath);

      if (stat.mtimeMs > latestTime) {
        latestTime = stat.mtimeMs;
        latestSession = {
          path: filePath,
          id: file.replace(/\.jsonl?$/, ''),
          hash,
        };
      }
    }
  }

  return latestSession;
}

function findSessionById(sessionId) {
  const appData = getAppDataPath();
  const storageBase = path.join(appData, 'workspaceStorage');
  
  if (!fs.existsSync(storageBase)) {
    return null;
  }
  
  for (const hash of fs.readdirSync(storageBase)) {
    const sessionsDir = path.join(storageBase, hash, 'chatSessions');
    // Try .jsonl first (VS Code >=1.109), fall back to .json
    for (const ext of ['.jsonl', '.json']) {
      const sessionFile = path.join(sessionsDir, `${sessionId}${ext}`);
      if (fs.existsSync(sessionFile)) {
        return {
          path: sessionFile,
          id: sessionId,
          hash,
        };
      }
    }
  }
  
  return null;
}

function readMessage(sessionPath, index, includeResponse) {
  const data = readSessionData(sessionPath);
  const requests = data.requests || [];
  const total = requests.length;
  
  if (total === 0) {
    return { error: 'Session has no messages' };
  }
  
  // Handle negative index
  let actualIndex = index;
  if (index < 0) {
    actualIndex = total + index;
  }
  
  if (actualIndex < 0 || actualIndex >= total) {
    return { 
      error: `Index ${index} out of range. Session has ${total} messages (0-${total-1})`,
      totalMessages: total,
    };
  }
  
  const req = requests[actualIndex];
  
  const output = {
    index: actualIndex,
    totalMessages: total,
    navigation: {
      hasPrev: actualIndex > 0,
      hasNext: actualIndex < total - 1,
      prevIndex: actualIndex > 0 ? actualIndex - 1 : null,
      nextIndex: actualIndex < total - 1 ? actualIndex + 1 : null,
    },
    timestamp: req.timestamp ? new Date(req.timestamp).toISOString() : null,
    message: req.message?.text || '',
  };
  
  if (includeResponse) {
    const responses = req.response || [];
    output.responseSummary = {
      partCount: responses.length,
      types: [...new Set(responses.map(r => r.kind))],
      hasThinking: responses.some(r => r.kind === 'thinking'),
      hasToolCalls: responses.some(r => r.kind === 'toolInvocationSerialized'),
      firstTextPart: responses.find(r => r.kind === null)?.content?.slice(0, 300) || null,
    };
  }
  
  return output;
}

function main() {
  const args = process.argv.slice(2);
  const params = {};
  
  for (const arg of args) {
    if (arg.startsWith('--')) {
      const [key, value] = arg.slice(2).split('=');
      params[key] = value === undefined ? true : value;
    }
  }
  
  if (params.help || args.length === 0) {
    console.log(`
Read a single message from a chat session.

Usage:
  node read-message.js --index=<N>              Read message at index N
  node read-message.js --index=-1               Read last message
  node read-message.js --session=<ID>           Specify session ID
  node read-message.js --response               Include response summary

Examples:
  node read-message.js --index=0                First message of most recent session
  node read-message.js --index=-1 --response    Last message with response info
  node read-message.js --index=82 --session=abc123

Output: JSON with message content and navigation hints.
`);
    process.exit(0);
  }
  
  if (params.index === undefined) {
    console.error('Error: --index is required');
    process.exit(1);
  }
  
  const index = parseInt(params.index, 10);
  if (isNaN(index)) {
    console.error('Error: --index must be a number');
    process.exit(1);
  }
  
  // Find session
  let session;
  if (params.session) {
    session = findSessionById(params.session);
    if (!session) {
      console.error(`Error: Session not found: ${params.session}`);
      process.exit(1);
    }
  } else {
    session = findCurrentSession();
    if (!session) {
      console.error('Error: Could not find any sessions');
      process.exit(1);
    }
  }
  
  const result = readMessage(session.path, index, params.response);
  result.sessionId = session.id;
  result.workspaceHash = session.hash;
  
  console.log(JSON.stringify(result, null, 2));
}

main();
