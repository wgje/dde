#!/usr/bin/env node
'use strict';

const { spawnSync } = require('node:child_process');
const { isNodeCommand } = require('./codegraph-codex-config.cjs');

function readLiveProcessList() {
  const override = process.env.NANOFLOW_CODEGRAPH_DOCTOR_PROCESS_LIST_JSON;
  if (override) {
    try {
      const parsed = JSON.parse(override);
      return {
        available: true,
        source: 'env',
        error: null,
        processes: normalizeProcessList(Array.isArray(parsed) ? parsed : [parsed]),
      };
    } catch (error) {
      return {
        available: false,
        source: 'env',
        error: error.message,
        processes: [],
      };
    }
  }

  return process.platform === 'win32' ? readWindowsProcessList() : readPosixProcessList();
}

function readWindowsProcessList() {
  const script = [
    '$ErrorActionPreference = "Stop";',
    'Get-CimInstance Win32_Process |',
    'Where-Object { $_.CommandLine -and $_.CommandLine -like "*codegraph-nanoflow-mcp-stdio.cjs*" -and $_.ProcessId -ne $PID } |',
    'Select-Object @{Name="pid";Expression={$_.ProcessId}}, @{Name="parentPid";Expression={$_.ParentProcessId}}, @{Name="commandLine";Expression={$_.CommandLine}} |',
    'ConvertTo-Json -Compress',
  ].join(' ');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    return {
      available: false,
      source: 'powershell',
      error: result.error?.message ?? result.stderr?.trim() ?? `exit ${result.status}`,
      processes: [],
    };
  }
  const stdout = result.stdout.trim();
  if (!stdout) {
    return {
      available: true,
      source: 'powershell',
      error: null,
      processes: [],
    };
  }
  try {
    const parsed = JSON.parse(stdout);
    return {
      available: true,
      source: 'powershell',
      error: null,
      processes: normalizeProcessList(Array.isArray(parsed) ? parsed : [parsed]),
    };
  } catch (error) {
    return {
      available: false,
      source: 'powershell',
      error: error.message,
      processes: [],
    };
  }
}

function readPosixProcessList() {
  const result = spawnSync('ps', ['-eo', 'pid=,ppid=,args='], {
    encoding: 'utf8',
  });
  if (result.error || result.status !== 0) {
    return {
      available: false,
      source: 'ps',
      error: result.error?.message ?? result.stderr?.trim() ?? `exit ${result.status}`,
      processes: [],
    };
  }
  const processes = result.stdout
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.includes('codegraph-nanoflow-mcp-stdio.cjs'))
    .map(line => {
      const match = /^(\d+)\s+(\d+)\s+(.+)$/.exec(line);
      if (!match) return null;
      return {
        pid: Number(match[1]),
        parentPid: Number(match[2]),
        commandLine: match[3],
      };
    })
    .filter(Boolean);
  return {
    available: true,
    source: 'ps',
    error: null,
    processes,
  };
}

function normalizeProcessList(processes) {
  return processes
    .map(processInfo => ({
      pid: numberOrNull(processInfo.pid ?? processInfo.ProcessId),
      parentPid: numberOrNull(processInfo.parentPid ?? processInfo.ParentProcessId),
      commandLine: String(processInfo.commandLine ?? processInfo.CommandLine ?? ''),
    }))
    .filter(processInfo => processInfo.commandLine.length > 0);
}

function numberOrNull(value) {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
}

function commandLineLooksLikeWrapperProcess(commandLine, expectedWrapperPath) {
  if (!commandLineContainsPath(commandLine, expectedWrapperPath)) {
    return false;
  }
  const token = /^"([^"]+)"|^'([^']+)'|^(\S+)/.exec(String(commandLine ?? '').trim());
  return isNodeCommand(token?.[1] ?? token?.[2] ?? token?.[3] ?? '');
}

function commandLineContainsPath(commandLine, expected) {
  return Boolean(expected) && normalizeCommandLineText(commandLine).includes(normalizeCommandLineText(expected));
}

function normalizeCommandLineText(value) {
  return String(value).replace(/\\/g, '/').toLowerCase();
}

module.exports = {
  commandLineContainsPath,
  commandLineLooksLikeWrapperProcess,
  readLiveProcessList,
};
