#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function getCodexConfigPath() {
  if (process.env.NANOFLOW_CODEGRAPH_CODEX_CONFIG) {
    return path.resolve(process.env.NANOFLOW_CODEGRAPH_CODEX_CONFIG);
  }
  const codexHome = process.env.CODEX_HOME
    ? path.resolve(process.env.CODEX_HOME)
    : path.join(os.homedir(), '.codex');
  return path.join(codexHome, 'config.toml');
}

function readCodexCodegraphMcpConfig(root) {
  const configPath = getCodexConfigPath();
  const result = {
    source: 'codex',
    path: configPath,
    exists: fs.existsSync(configPath),
    parseError: null,
    server: null,
    appliesToRoot: false,
  };

  if (!result.exists) {
    return result;
  }

  try {
    result.server = parseCodegraphServer(fs.readFileSync(configPath, 'utf8'));
    result.appliesToRoot = Boolean(result.server) && serverAppliesToRoot(result.server, root);
  } catch (error) {
    result.parseError = error.message;
  }

  return result;
}

function parseCodegraphServer(text) {
  const server = {};
  const env = {};
  let section = null;
  const statements = collectTomlStatements(text);

  for (const statement of statements) {
    const trimmed = statement.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }
    const sectionMatch = trimmed.match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      section = sectionMatch[1];
      continue;
    }
    const assignment = trimmed.match(/^([A-Za-z0-9_.-]+)\s*=\s*([\s\S]+)$/);
    if (!assignment) {
      continue;
    }

    const [, key, rawValue] = assignment;
    if (section === 'mcp_servers.codegraph') {
      if (key === 'args') {
        server.args = parseTomlStringArray(rawValue);
      } else if (key === 'command' || key === 'url') {
        server[key] = parseTomlString(rawValue);
      }
    } else if (section === 'mcp_servers.codegraph.env') {
      env[key] = parseTomlString(rawValue);
    }
  }

  if (!server.command && !server.url && !Array.isArray(server.args)) {
    return null;
  }
  server.env = env;
  return server;
}

function collectTomlStatements(text) {
  const statements = [];
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    let line = lines[index];
    if (/^\s*[A-Za-z0-9_.-]+\s*=\s*\[/.test(line) && !line.includes(']')) {
      while (index + 1 < lines.length) {
        index += 1;
        line += `\n${lines[index]}`;
        if (lines[index].includes(']')) {
          break;
        }
      }
    }
    statements.push(line);
  }
  return statements;
}

function parseTomlStringArray(rawValue) {
  const values = [];
  const matches = rawValue.matchAll(/"(?:\\.|[^"\\])*"|'[^']*'/g);
  for (const match of matches) {
    values.push(parseTomlString(match[0]));
  }
  return values;
}

function parseTomlString(rawValue) {
  const value = String(rawValue).trim().replace(/,$/, '').trim();
  if (value.startsWith('"')) {
    return JSON.parse(value);
  }
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1);
  }
  return value;
}

function isNodeCommand(command) {
  const executable = path.basename(String(command ?? '')).toLowerCase();
  return executable === 'node' || executable === 'node.exe';
}

function serverAppliesToRoot(server, root) {
  const resolvedRoot = path.resolve(root);
  const args = Array.isArray(server?.args) ? server.args : [];
  const pathArgIndex = args.indexOf('--path');
  if (pathArgIndex >= 0 && args[pathArgIndex + 1]) {
    const configuredRoot = replaceWorkspaceFolder(args[pathArgIndex + 1], resolvedRoot);
    if (samePath(configuredRoot, resolvedRoot)) {
      return true;
    }
  }

  const wrapperScriptPath = args[0] ? replaceWorkspaceFolder(args[0], resolvedRoot) : null;
  return Boolean(wrapperScriptPath) && isPathInside(wrapperScriptPath, resolvedRoot);
}

function replaceWorkspaceFolder(value, root) {
  return String(value).replaceAll('${workspaceFolder}', root);
}

function samePath(left, right) {
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
}

function isPathInside(candidate, root) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

module.exports = {
  getCodexConfigPath,
  isNodeCommand,
  readCodexCodegraphMcpConfig,
};
