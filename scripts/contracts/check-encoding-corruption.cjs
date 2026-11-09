#!/usr/bin/env node
const path = require('node:path');
const { TextDecoder } = require('node:util');
const {
  getGitVisibleErrorCode,
  listGitVisibleWorktreeFiles,
} = require('./git-visible-worktree.cjs');

const projectRoot = process.cwd();
const decoder = new TextDecoder('utf-8', { fatal: true });

const excludedPaths = new Set([]);
const excludedPathPatterns = [
  /^docs\/archive\/.+\.corrupted-[^/]+\.md$/u,
];
const binaryExtensions = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico',
  '.pdf', '.zip', '.gz', '.7z', '.tar',
  '.woff', '.woff2', '.ttf', '.eot',
  '.mp3', '.mp4', '.webm', '.mov', '.avi', '.wav', '.ogg',
  '.sqlite', '.db', '.bin',
]);

const puaPattern = /[\uE000-\uF8FF]/u;
const cjkPattern = /[\u4E00-\u9FFF]/u;
const suspiciousMojibakeFragments = [
  '\u9354\u3127\u657e',
  '\u93c2\u677f\ue583',
  '\u5a34\u5b2d\u762f',
  '\u93cb\u52ef\u20ac',
  '\u935a\u5c7e\u7c2e',
  '\u7481\u3087\u7161',
  '\u5bee\u509b\ue11e',
  '\u6d60\u8bf2\u59df',
  '\u93b5\u20ac\u93c8',
  '\u9356\u54c4\u7159',
  '\u934a\ufe3d\u20ac',
  '\u922e\u003f',
];
const suspiciousQuestionPatterns = [
  /[\u4E00-\u9FFF]\?(?=[^\s|])/u,
  /\?(?=[A-Za-z<{_])/u,
  /\?\s*\*\//u,
  /\?-->/u,
  /\?[\u4E00-\u9FFF]/u,
];
const allowedQuestionPatterns = [
  /https?:\/\/\S+\?/i,
  /\/reset-password\?access_token=/,
  /`[^`]*\?[^`]*`/,
  /\?\s*\|/,
];

function isExcludedPath(filePath) {
  return excludedPaths.has(filePath)
    || excludedPathPatterns.some((pattern) => pattern.test(filePath));
}

function isLikelyBinary(filePath, buffer) {
  const ext = path.extname(filePath).toLowerCase();
  if (binaryExtensions.has(ext)) {
    return true;
  }

  return buffer.includes(0);
}

function hasUtf8Bom(buffer) {
  return buffer.length >= 3
    && buffer[0] === 0xef
    && buffer[1] === 0xbb
    && buffer[2] === 0xbf;
}

function countCrlfSequences(content) {
  const matches = content.match(/\r\n/g);
  return matches ? matches.length : 0;
}

function validateFile(relativePath, raw) {

  if (isLikelyBinary(relativePath, raw)) {
    return { scannable: false, issues: [] };
  }

  const issues = [];
  const bomDetected = hasUtf8Bom(raw);
  const sourceBuffer = bomDetected ? raw.subarray(3) : raw;

  if (bomDetected) {
    issues.push({
      type: 'utf8_bom',
      line: 1,
    });
  }

  let content;
  try {
    content = decoder.decode(sourceBuffer);
  } catch {
    return {
      scannable: true,
      issues: [{
        type: 'invalid_utf8',
        line: 1,
      }],
    };
  }

  const crlfCount = countCrlfSequences(content);
  if (crlfCount > 0) {
    issues.push({
      type: 'crlf_line_endings',
      line: 1,
    });
  }

  const lines = content.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const line = lines[index];

    if (line.includes('\uFFFD')) {
      issues.push({
        type: 'replacement_char',
        line: lineNumber,
      });
    }

    if (puaPattern.test(line)) {
      issues.push({
        type: 'private_use_char',
        line: lineNumber,
      });
    }

    const matchedFragments = suspiciousMojibakeFragments.filter((fragment) => line.includes(fragment));
    if (matchedFragments.length > 0) {
      issues.push({
        type: 'mojibake_fragment',
        line: lineNumber,
      });
    }

    if (!line.includes('?') || !cjkPattern.test(line)) {
      continue;
    }

    if (allowedQuestionPatterns.some((pattern) => pattern.test(line))) {
      continue;
    }

    if (suspiciousQuestionPatterns.some((pattern) => pattern.test(line))) {
      issues.push({
        type: 'suspicious_question',
        line: lineNumber,
      });
    }
  }

  return { scannable: true, issues };
}

function main() {
  let workspaceFiles;
  try {
    workspaceFiles = listGitVisibleWorktreeFiles(projectRoot);
  } catch (error) {
    console.error(`[encoding-guard] FAIL reason=${getGitVisibleErrorCode(error)}`);
    process.exit(1);
  }

  const allIssues = [];
  let scannedCount = 0;

  try {
    for (const fileRecord of workspaceFiles) {
      const file = fileRecord.relativePath;
      if (isExcludedPath(file)) {
        continue;
      }
      const result = validateFile(file, fileRecord.readBuffer());
      if (!result.scannable) {
        continue;
      }

      scannedCount += 1;
      if (result.issues.length > 0) {
        allIssues.push({ file, issues: result.issues });
      }
    }
  } catch (error) {
    console.error(`[encoding-guard] FAIL reason=${getGitVisibleErrorCode(error)}`);
    process.exit(1);
  }

  if (allIssues.length === 0) {
    console.log(`[encoding-guard] PASS: scanned ${scannedCount} workspace text files, no encoding or line-ending issues found.`);
    return;
  }

  console.error(`[encoding-guard] FAIL: ${allIssues.length} file(s) contain encoding or line-ending issues.`);
  for (const item of allIssues) {
    console.error(`- ${item.file}`);
    for (const issue of item.issues.slice(0, 20)) {
      console.error(`  [${issue.type}] line ${issue.line}`);
    }
    if (item.issues.length > 20) {
      console.error(`  ... ${item.issues.length - 20} more issue(s)`);
    }
  }

  process.exit(1);
}

main();
