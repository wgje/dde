#!/usr/bin/env node
'use strict';

const { spawnSync } = require('node:child_process');
const { isNodeCommand } = require('./codegraph-codex-config.cjs');

const DEFAULT_WINDOWS_PROCESS_SNAPSHOT_TIMEOUT_MS = 5_000;
const DEFAULT_WINDOWS_PROCESS_TERMINATION_TIMEOUT_MS = 2_000;
const SYNCHRONOUS_SLEEP_BUFFER = new Int32Array(new SharedArrayBuffer(4));
const WINDOWS_WRAPPER_PROCESS_SNAPSHOT_COMMAND = String.raw`
$ErrorActionPreference = "Stop"
$source = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public sealed class NanoFlowDoctorProcessRow {
  public uint pid;
  public uint parentPid;
  public string parentName;
  public string parentCommandLine;
  public string startedAt;
  public string commandLine;
}

public static class NanoFlowDoctorProcessSnapshot {
  const uint SnapshotProcesses = 2;
  const uint QueryLimitedInformation = 0x1000;
  const int ProcessCommandLineInformation = 60;
  static readonly IntPtr InvalidHandle = new IntPtr(-1);

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct ProcessEntry {
    public uint size;
    public uint usage;
    public uint processId;
    public IntPtr defaultHeapId;
    public uint moduleId;
    public uint threads;
    public uint parentProcessId;
    public int basePriority;
    public uint flags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)]
    public string executable;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct UnicodeString {
    public ushort length;
    public ushort maximumLength;
    public IntPtr buffer;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct FileTime {
    public uint low;
    public uint high;
  }

  [DllImport("kernel32.dll", SetLastError = true)]
  static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint processId);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool Process32FirstW(IntPtr snapshot, ref ProcessEntry entry);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool Process32NextW(IntPtr snapshot, ref ProcessEntry entry);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern IntPtr OpenProcess(uint access, bool inheritHandle, uint processId);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool GetProcessTimes(
    IntPtr process,
    out FileTime creation,
    out FileTime exit,
    out FileTime kernel,
    out FileTime user
  );
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool CloseHandle(IntPtr handle);
  [DllImport("ntdll.dll")]
  static extern int NtQueryInformationProcess(
    IntPtr process,
    int informationClass,
    IntPtr information,
    int informationLength,
    out int returnLength
  );

  public static NanoFlowDoctorProcessRow[] WrapperProcesses(string needle) {
    var entries = ReadEntries();
    var namesByPid = new Dictionary<uint, string>();
    foreach (var entry in entries) namesByPid[entry.processId] = entry.executable;

    var rows = new List<NanoFlowDoctorProcessRow>();
    var readableNodeProcesses = 0;
    foreach (var entry in entries) {
      if (!string.Equals(entry.executable, "node.exe", StringComparison.OrdinalIgnoreCase)) continue;
      var commandLine = ReadCommandLine(entry.processId);
      if (commandLine == null) continue;
      readableNodeProcesses++;
      if (commandLine.IndexOf(needle, StringComparison.OrdinalIgnoreCase) < 0) continue;

      string parentName;
      namesByPid.TryGetValue(entry.parentProcessId, out parentName);
      rows.Add(new NanoFlowDoctorProcessRow {
        pid = entry.processId,
        parentPid = entry.parentProcessId,
        parentName = parentName,
        parentCommandLine = ReadCommandLine(entry.parentProcessId),
        startedAt = ReadStartedAt(entry.processId),
        commandLine = commandLine,
      });
    }
    if (readableNodeProcesses == 0) {
      throw new InvalidOperationException("Windows native process snapshot could not read any Node command line.");
    }
    return rows.ToArray();
  }

  static List<ProcessEntry> ReadEntries() {
    var entries = new List<ProcessEntry>();
    var snapshot = CreateToolhelp32Snapshot(SnapshotProcesses, 0);
    if (snapshot == InvalidHandle) {
      throw new InvalidOperationException(
        "CreateToolhelp32Snapshot failed: " + Marshal.GetLastWin32Error()
      );
    }
    try {
      var entry = new ProcessEntry();
      entry.size = (uint)Marshal.SizeOf(typeof(ProcessEntry));
      if (!Process32FirstW(snapshot, ref entry)) return entries;
      do {
        entries.Add(entry);
        entry.size = (uint)Marshal.SizeOf(typeof(ProcessEntry));
      } while (Process32NextW(snapshot, ref entry));
      return entries;
    } finally {
      CloseHandle(snapshot);
    }
  }

  static string ReadCommandLine(uint processId) {
    if (processId == 0) return null;
    var process = OpenProcess(QueryLimitedInformation, false, processId);
    if (process == IntPtr.Zero) return null;
    try {
      int requiredLength;
      NtQueryInformationProcess(
        process,
        ProcessCommandLineInformation,
        IntPtr.Zero,
        0,
        out requiredLength
      );
      if (requiredLength <= 0) return null;
      var buffer = Marshal.AllocHGlobal(requiredLength);
      try {
        int returnedLength;
        var status = NtQueryInformationProcess(
          process,
          ProcessCommandLineInformation,
          buffer,
          requiredLength,
          out returnedLength
        );
        if (status < 0) return null;
        var value = (UnicodeString)Marshal.PtrToStructure(buffer, typeof(UnicodeString));
        if (value.buffer == IntPtr.Zero || value.length == 0) return string.Empty;
        return Marshal.PtrToStringUni(value.buffer, value.length / 2);
      } finally {
        Marshal.FreeHGlobal(buffer);
      }
    } finally {
      CloseHandle(process);
    }
  }

  static string ReadStartedAt(uint processId) {
    var process = OpenProcess(QueryLimitedInformation, false, processId);
    if (process == IntPtr.Zero) return null;
    try {
      FileTime creation;
      FileTime exit;
      FileTime kernel;
      FileTime user;
      if (!GetProcessTimes(process, out creation, out exit, out kernel, out user)) return null;
      var fileTime = ((long)creation.high << 32) | creation.low;
      return fileTime > 0 ? DateTime.FromFileTimeUtc(fileTime).ToString("o") : null;
    } finally {
      CloseHandle(process);
    }
  }
}
'@
Add-Type -TypeDefinition $source
$rows = [NanoFlowDoctorProcessSnapshot]::WrapperProcesses("codegraph-nanoflow-mcp-stdio.cjs")
ConvertTo-Json -InputObject @($rows) -Compress
`;

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
  const timeoutMs = positiveIntegerOrDefault(
    process.env.NANOFLOW_CODEGRAPH_DOCTOR_PROCESS_SNAPSHOT_TIMEOUT_MS,
    DEFAULT_WINDOWS_PROCESS_SNAPSHOT_TIMEOUT_MS,
  );
  const result = spawnSync(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', WINDOWS_WRAPPER_PROCESS_SNAPSHOT_COMMAND],
    {
      encoding: 'utf8',
      windowsHide: true,
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024,
    },
  );
  if (result.error || result.status !== 0) {
    return {
      available: false,
      source: 'powershell-native',
      error: describeWindowsSnapshotFailure(result, timeoutMs),
      processes: [],
    };
  }
  const stdout = result.stdout.trim();
  if (!stdout) {
    return {
      available: true,
      source: 'powershell-native',
      error: null,
      processes: [],
    };
  }
  try {
    const parsed = JSON.parse(stdout);
    return {
      available: true,
      source: 'powershell-native',
      error: null,
      processes: normalizeProcessList(Array.isArray(parsed) ? parsed : [parsed]),
    };
  } catch (error) {
    return {
      available: false,
      source: 'powershell-native',
      error: error.message,
      processes: [],
    };
  }
}

function positiveIntegerOrDefault(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function describeWindowsSnapshotFailure(result, timeoutMs) {
  if (result.error?.code === 'ETIMEDOUT') {
    return `Windows native process snapshot timed out after ${timeoutMs}ms`;
  }
  return result.error?.message ?? result.stderr?.trim() ?? `exit ${result.status}`;
}

function readPosixProcessList() {
  const result = spawnSync('ps', ['-eo', 'pid=,ppid=,etimes=,args='], {
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
  const allProcesses = result.stdout
    .split(/\r?\n/)
    .map(line => line.trim())
    .map(line => {
      const match = /^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/.exec(line);
      if (!match) return null;
      return {
        pid: Number(match[1]),
        parentPid: Number(match[2]),
        startedAt: new Date(Date.now() - (Number(match[3]) * 1000)).toISOString(),
        commandLine: match[4],
      };
    })
    .filter(Boolean);
  const processesByPid = new Map(allProcesses.map(processInfo => [processInfo.pid, processInfo]));
  const processes = allProcesses
    .filter(processInfo => processInfo.commandLine.includes('codegraph-nanoflow-mcp-stdio.cjs'))
    .map(processInfo => ({
      ...processInfo,
      parentName: null,
      parentCommandLine: processesByPid.get(processInfo.parentPid)?.commandLine ?? null,
    }));
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
      parentName: optionalText(processInfo.parentName ?? processInfo.ParentName),
      parentCommandLine: optionalText(
        processInfo.parentCommandLine ?? processInfo.ParentCommandLine,
      ),
      startedAt: timestampOrNull(processInfo.startedAt ?? processInfo.CreationDate),
      commandLine: String(processInfo.commandLine ?? processInfo.CommandLine ?? ''),
    }))
    .filter(processInfo => processInfo.commandLine.length > 0);
}

function numberOrNull(value) {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
}

function timestampOrNull(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function optionalText(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text.length > 0 ? text : null;
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

function terminateWrapperProcessTree(processInfo, expectedWrapperPath, expectedCodegraphTarget) {
  const pid = numberOrNull(processInfo?.pid);
  const commandLine = String(processInfo?.commandLine ?? '');
  if (!pid || pid === process.pid) {
    return { ok: false, pid, reason: 'invalid-or-current-pid' };
  }
  if (!commandLineLooksLikeWrapperProcess(commandLine, expectedWrapperPath)) {
    return { ok: false, pid, reason: 'command-line-no-longer-matches-wrapper' };
  }
  if (expectedCodegraphTarget && !commandLine.includes(expectedCodegraphTarget)) {
    return { ok: false, pid, reason: 'codegraph-target-no-longer-matches' };
  }

  if (process.platform === 'win32') {
    return terminateWindowsWrapperProcess(pid);
  }

  try {
    process.kill(pid, 'SIGTERM');
    return { ok: true, pid, reason: 'sent-sigterm' };
  } catch (error) {
    return {
      ok: false,
      pid,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

function terminateWindowsWrapperProcess(pid, dependencies = {}) {
  const timeoutMs = positiveIntegerOrDefault(
    process.env.NANOFLOW_CODEGRAPH_DOCTOR_PROCESS_TERMINATION_TIMEOUT_MS,
    DEFAULT_WINDOWS_PROCESS_TERMINATION_TIMEOUT_MS,
  );
  const runTaskkill = dependencies.runTaskkill ?? ((targetPid, timeout) => spawnSync(
    'taskkill.exe',
    ['/PID', String(targetPid), '/T', '/F'],
    { encoding: 'utf8', windowsHide: true, timeout },
  ));
  const terminateProcess = dependencies.terminateProcess ?? process.kill.bind(process);
  const waitForExit = dependencies.waitForExit ?? waitForProcessExit;
  const taskkillResult = runTaskkill(pid, timeoutMs);
  const taskkillFailure = taskkillFailureReason(taskkillResult);
  if (!taskkillFailure) {
    return windowsTerminationResult(true, pid, 'terminated-process-tree', null, taskkillResult);
  }

  try {
    terminateProcess(pid, 'SIGTERM');
  } catch (error) {
    if (error?.code === 'ESRCH') {
      return windowsTerminationResult(true, pid, 'already-exited-after-taskkill', taskkillFailure, taskkillResult);
    }
    return windowsTerminationResult(
      false,
      pid,
      `direct-termination-failed:${error instanceof Error ? error.message : String(error)}`,
      taskkillFailure,
      taskkillResult,
    );
  }

  const exited = waitForExit(pid, Math.min(timeoutMs, 1_000));
  return windowsTerminationResult(
    exited,
    pid,
    exited ? 'terminated-wrapper-after-taskkill-failed' : 'direct-termination-did-not-exit',
    taskkillFailure,
    taskkillResult,
  );
}

function taskkillFailureReason(result) {
  if (!result?.error && result?.status === 0) return null;
  if (result?.error?.code === 'ETIMEDOUT') return 'timeout';
  if (result?.error?.code) return `spawn-${result.error.code}`;
  if (result?.signal) return `signal-${result.signal}`;
  return `exit-${result?.status ?? 'unknown'}`;
}

function windowsTerminationResult(ok, pid, reason, taskkillFailure, taskkillResult) {
  return {
    ok,
    pid,
    reason,
    ...(taskkillFailure ? { taskkillFailure } : {}),
    stdout: taskkillResult?.stdout?.trim() ?? '',
    stderr: taskkillResult?.stderr?.trim() ?? '',
  };
}

function waitForProcessExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processIsAlive(pid)) return true;
    Atomics.wait(SYNCHRONOUS_SLEEP_BUFFER, 0, 0, 25);
  }
  return !processIsAlive(pid);
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== 'ESRCH';
  }
}

function normalizeCommandLineText(value) {
  return String(value).replace(/\\/g, '/').toLowerCase();
}

module.exports = {
  commandLineContainsPath,
  commandLineLooksLikeWrapperProcess,
  readLiveProcessList,
  terminateWindowsWrapperProcess,
  terminateWrapperProcessTree,
};
