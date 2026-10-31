#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function getCodexConfigPath() {
  if (process.env.NANOFLOW_CODEGRAPH_CODEX_CONFIG) {
    return path.resolve(process.env.NANOFLOW_CODEGRAPH_CODEX_CONFIG);
  }
  return getUserCodexConfigPath();
}

function getUserCodexConfigPath() {
  const codexHome = process.env.CODEX_HOME
    ? path.resolve(process.env.CODEX_HOME)
    : path.join(os.homedir(), '.codex');
  return path.join(codexHome, 'config.toml');
}

function readCodexCodegraphMcpConfig(root) {
  const resolvedRoot = path.resolve(root);
  const explicitConfigPath = process.env.NANOFLOW_CODEGRAPH_CODEX_CONFIG
    ? path.resolve(process.env.NANOFLOW_CODEGRAPH_CODEX_CONFIG)
    : null;
  const userConfigPath = getUserCodexConfigPath();
  const projectConfigPath = path.join(resolvedRoot, '.codex', 'config.toml');
  if (explicitConfigPath) {
    return {
      ...readCodexConfigCandidate(explicitConfigPath, resolvedRoot),
      scope: 'override',
      userConfigPath,
      projectConfigPath,
      candidateConfigs: [
        summarizeConfigCandidate('override', explicitConfigPath, resolvedRoot),
      ],
    };
  }

  const projectConfig = readCodexConfigCandidate(projectConfigPath, resolvedRoot);
  const userConfig = readCodexConfigCandidate(userConfigPath, resolvedRoot);
  const projectOverridesUser = projectConfig.parseError
    || (projectConfig.exists && projectConfig.serverDeclared);
  const activeConfig = projectOverridesUser ? projectConfig : userConfig;
  return {
    ...activeConfig,
    scope: projectOverridesUser ? 'project' : 'user',
    userConfigPath,
    projectConfigPath,
    candidateConfigs: [
      summarizeConfigCandidate('project', projectConfigPath, resolvedRoot, projectConfig),
      summarizeConfigCandidate('user', userConfigPath, resolvedRoot, userConfig),
    ],
  };
}

function repairCodexCodegraphMcpConfig(root, contract) {
  const config = readCodexCodegraphMcpConfig(root);
  if (!config.exists) {
    throw new Error(`Codex config does not exist: ${config.path}`);
  }
  if (config.parseError) {
    throw new Error(`Codex config cannot be repaired because it did not parse: ${config.parseError}`);
  }
  if (!config.server || !config.appliesToRoot) {
    throw new Error(`Codex config does not contain a CodeGraph server for ${path.resolve(root)}: ${config.path}`);
  }
  if (!Array.isArray(config.server.args) || config.server.args.length < 2) {
    throw new Error(`Codex CodeGraph server args cannot be repaired: ${config.path}`);
  }

  const before = fs.readFileSync(config.path, 'utf8');
  const repairedArgs = [...config.server.args];
  repairedArgs[1] = contract.codegraphTarget;
  let after = setTomlAssignment(
    before,
    'mcp_servers.codegraph',
    'args',
    `[${repairedArgs.map((value) => JSON.stringify(value)).join(', ')}]`,
  );
  for (const [key, value] of Object.entries(contract.requiredEnv ?? {})) {
    after = setTomlAssignment(
      after,
      'mcp_servers.codegraph.env',
      key,
      JSON.stringify(String(value)),
    );
  }

  const changed = after !== before;
  if (changed) {
    fs.writeFileSync(config.path, after, 'utf8');
  }
  return {
    changed,
    path: config.path,
    scope: config.scope,
    codegraphTarget: contract.codegraphTarget,
    requiredEnv: { ...(contract.requiredEnv ?? {}) },
  };
}

function setTomlAssignment(text, sectionName, key, rawValue) {
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const section = findTomlSection(text, sectionName);
  if (!section) {
    const separator = text.length === 0 || text.endsWith(newline) ? '' : newline;
    return `${text}${separator}${newline}[${sectionName}]${newline}${key} = ${rawValue}${newline}`;
  }

  const body = text.slice(section.bodyStart, section.bodyEnd);
  const assignmentPattern = new RegExp(`^([ \\t]*)${escapeRegExp(key)}\\s*=`, 'm');
  const assignment = assignmentPattern.exec(body);
  if (!assignment) {
    const insertion = `${key} = ${rawValue}${newline}`;
    return `${text.slice(0, section.bodyEnd)}${insertion}${text.slice(section.bodyEnd)}`;
  }

  const assignmentStart = section.bodyStart + assignment.index;
  const valueStart = assignmentStart + assignment[0].length;
  const assignmentEnd = findTomlAssignmentEnd(text, valueStart);
  const replacement = `${assignment[1]}${key} = ${rawValue}`;
  return `${text.slice(0, assignmentStart)}${replacement}${text.slice(assignmentEnd)}`;
}

function findTomlSection(text, sectionName) {
  const sectionPattern = new RegExp(`^\\s*\\[${escapeRegExp(sectionName)}\\]\\s*$`, 'm');
  const match = sectionPattern.exec(text);
  if (!match) return null;
  const bodyStart = match.index + match[0].length;
  const remaining = text.slice(bodyStart);
  const nextSection = /^\s*\[[^\]]+\]\s*$/m.exec(remaining);
  return {
    bodyStart,
    bodyEnd: nextSection ? bodyStart + nextSection.index : text.length,
  };
}

function findTomlAssignmentEnd(text, valueStart) {
  let cursor = valueStart;
  while (cursor < text.length && /[ \t]/.test(text[cursor])) cursor += 1;
  if (text[cursor] !== '[') {
    const newlineIndex = text.indexOf('\n', cursor);
    return newlineIndex < 0 ? text.length : newlineIndex;
  }

  let quote = null;
  let escaped = false;
  let depth = 0;
  for (; cursor < text.length; cursor += 1) {
    const char = text[cursor];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\' && quote === '"') {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
    } else if (char === '[') {
      depth += 1;
    } else if (char === ']') {
      depth -= 1;
      if (depth === 0) return cursor + 1;
    }
  }
  throw new Error('unterminated TOML array assignment');
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function readCodexConfigCandidate(configPath, root) {
  const result = {
    source: 'codex',
    path: configPath,
    exists: fs.existsSync(configPath),
    parseError: null,
    server: null,
    serverDeclared: false,
    appliesToRoot: false,
  };

  if (!result.exists) {
    return result;
  }

  try {
    const text = fs.readFileSync(configPath, 'utf8');
    result.serverDeclared = Boolean(findTomlSection(text, 'mcp_servers.codegraph'));
    result.server = parseCodegraphServer(text);
    result.appliesToRoot = Boolean(result.server) && serverAppliesToRoot(result.server, root);
  } catch (error) {
    result.parseError = error.message;
  }

  return result;
}

function summarizeConfigCandidate(scope, configPath, root, candidate = null) {
  const inspected = candidate ?? readCodexConfigCandidate(configPath, root);
  return {
    scope,
    path: configPath,
    exists: inspected.exists,
    parseError: inspected.parseError,
    codegraphServerDeclared: inspected.serverDeclared,
    codegraphServerConfigured: Boolean(inspected.server),
    appliesToRoot: inspected.appliesToRoot,
    codegraphTarget: Array.isArray(inspected.server?.args)
      ? inspected.server.args[1] ?? null
      : null,
  };
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
    return samePath(configuredRoot, resolvedRoot);
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
  repairCodexCodegraphMcpConfig,
};
