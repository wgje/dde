import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
const initPath = 'scripts/init-supabase.sql';
const replayPath = 'supabase/migrations/20260428083000_add_task_completed_at.sql';
const migrationsPath = 'supabase/migrations';
const quotaMarker = '-- FINAL CONVERGENCE: 20260730000000 transcription usage quota immutability';
const finalMarker = '-- FINAL CONVERGENCE: 20260428083000 task completed_at trigger init parity';
const target = 'set_task_completed_at';
type SqlToken = { text: string; start: number; end: number; quoted?: true; delimiter?: string };
type FunctionDefinition = { start: number; header: string; body: string; tail: string };
type LifecycleEvent = { kind: 'create' | 'alter' | 'drop'; start: number; statement: string };
type FunctionAclState = {
  globalRoles: Set<string>;
  schemaRoles: Set<string>;
  effectiveRoles: Set<string> | null;
  globalGrantOptions: Set<string>;
  schemaGrantOptions: Set<string>;
  effectiveGrantOptions: Set<string> | null;
};

function read(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');
}

function sqlTokens(sql: string): SqlToken[] {
  const tokens: SqlToken[] = [];
  for (let index = 0; index < sql.length;) {
    const start = index;
    const char = sql[index];
    if (/\s/.test(char)) { index += 1; continue; }
    if (sql.startsWith('--', index)) {
      const newline = sql.indexOf('\n', index + 2);
      index = newline < 0 ? sql.length : newline + 1;
      continue;
    }
    if (sql.startsWith('/*', index)) {
      let depth = 1;
      for (index += 2; index < sql.length && depth > 0;) {
        if (sql.startsWith('/*', index)) { depth += 1; index += 2; }
        else if (sql.startsWith('*/', index)) { depth -= 1; index += 2; }
        else index += 1;
      }
      if (depth > 0) throw new Error(`Unterminated block comment at ${start}`);
      continue;
    }
    const escapeString = (char === 'E' || char === 'e') && sql[index + 1] === "'";
    if (escapeString || char === "'" || char === '"') {
      const quote = escapeString ? "'" : char;
      let closed = false;
      for (index += escapeString ? 2 : 1; index < sql.length;) {
        if (escapeString && sql[index] === '\\') { index += 2; continue; }
        if (sql[index] !== quote) { index += 1; continue; }
        if (sql[index + 1] === quote) { index += 2; continue; }
        index += 1; closed = true; break;
      }
      if (!closed) throw new Error(`Unterminated quote at ${start}`);
      tokens.push({ text: sql.slice(start, index), start, end: index, quoted: true });
      continue;
    }
    const delimiter = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(index))?.[0];
    if (delimiter) {
      const close = sql.indexOf(delimiter, index + delimiter.length);
      if (close < 0) throw new Error(`Unterminated ${delimiter} at ${start}`);
      index = close + delimiter.length;
      tokens.push({ text: sql.slice(start, index), start, end: index, quoted: true, delimiter });
      continue;
    }
    if (/[A-Za-z0-9_]/.test(char)) {
      while (index < sql.length && /[A-Za-z0-9_]/.test(sql[index])) index += 1;
    } else index += 1;
    tokens.push({ text: sql.slice(start, index), start, end: index });
  }
  return tokens;
}

function normalized(sql: string): string {
  return sqlTokens(sql).map(token => token.quoted ? token.text : token.text.toLowerCase()).join(' ');
}

function identifier(token: SqlToken | undefined, expected: string): boolean {
  if (!token) return false;
  if (token.text.startsWith('"')) return token.text.slice(1, -1).replaceAll('""', '"') === expected;
  return !token.quoted && token.text.toLowerCase() === expected;
}

function statements(sql: string): SqlToken[][] {
  const result: SqlToken[][] = [];
  let current: SqlToken[] = [];
  for (const token of sqlTokens(sql)) {
    current.push(token);
    if (token.text === ';') { result.push(current); current = []; }
  }
  if (current.length > 0) result.push(current);
  return result;
}

function word(token: SqlToken | undefined): string {
  return token?.quoted ? token.text : (token?.text.toLowerCase() ?? '');
}

function role(token: SqlToken | undefined): string | null {
  if (!token || token.text === ',' || token.text === ';') return null;
  const value = token.text.startsWith('"')
    ? token.text.slice(1, -1).replaceAll('""', '"')
    : token.text.toLowerCase();
  return value === 'public' ? 'PUBLIC' : value;
}

function sqlStringContent(token: SqlToken | undefined): string | null {
  if (!token?.quoted) return null;
  const escape = /^e'/i.test(token.text);
  if (!escape && !token.text.startsWith("'")) return null;
  let value = token.text.slice(escape ? 2 : 1, -1).replaceAll("''", "'");
  if (escape) value = value.replace(/\\(.)/gs, '$1');
  return value;
}

function routineObjectIndex(tokens: SqlToken[]): number {
  return tokens.findIndex(token => ['function', 'routine'].includes(word(token)));
}

function targetRoutineInList(tokens: SqlToken[], objectIndex: number, boundary = tokens.length): boolean {
  let cursor = objectIndex + 1;
  if (word(tokens[cursor]) === 'if' && word(tokens[cursor + 1]) === 'exists') cursor += 2;
  while (cursor < boundary) {
    let nameIndex = cursor;
    let publicSchema = true;
    if (tokens[cursor + 1]?.text === '.') {
      publicSchema = identifier(tokens[cursor], 'public');
      nameIndex = cursor + 2;
    }
    const matches = publicSchema && identifier(tokens[nameIndex], target);
    cursor = nameIndex + 1;
    let zeroArguments = true;
    if (tokens[cursor]?.text === '(') {
      zeroArguments = tokens[cursor + 1]?.text === ')';
      for (let depth = 1; cursor < boundary && depth > 0; cursor += 1) {
        if (tokens[cursor + 1]?.text === '(') depth += 1;
        else if (tokens[cursor + 1]?.text === ')') depth -= 1;
      }
      cursor += 1;
    }
    if (matches && zeroArguments) return true;
    while (cursor < boundary && tokens[cursor]?.text !== ',') cursor += 1;
    cursor += 1;
  }
  return false;
}

function targetTableTriggerAlter(tokens: SqlToken[]): boolean {
  const alterIndex = tokens.findIndex((token, index) => word(token) === 'alter'
    && word(tokens[index + 1]) === 'table');
  if (alterIndex < 0) return false;
  let cursor = alterIndex + 2;
  if (word(tokens[cursor]) === 'if' && word(tokens[cursor + 1]) === 'exists') cursor += 2;
  if (word(tokens[cursor]) === 'only') cursor += 1;
  const targetTable = identifier(tokens[cursor], 'tasks')
    || (identifier(tokens[cursor], 'public') && tokens[cursor + 1]?.text === '.'
      && identifier(tokens[cursor + 2], 'tasks'));
  if (!targetTable) return false;
  return tokens.some((token, triggerIndex) => {
    if (word(token) !== 'trigger' || (!identifier(tokens[triggerIndex + 1], target)
      && !['all', 'user'].includes(word(tokens[triggerIndex + 1])))) return false;
    let priorComma = -1;
    for (let index = alterIndex; index < triggerIndex; index += 1) {
      if (tokens[index].text === ',') priorComma = index;
    }
    return tokens.slice(Math.max(alterIndex, priorComma) + 1, triggerIndex)
      .some(candidate => ['disable', 'enable'].includes(word(candidate)));
  });
}

function allPublicRoutines(tokens: SqlToken[]): boolean {
  const schemaIndex = tokens.findIndex((token, index) => word(token) === 'all'
    && ['functions', 'routines'].includes(word(tokens[index + 1]))
    && word(tokens[index + 2]) === 'in' && word(tokens[index + 3]) === 'schema') + 3;
  if (schemaIndex < 3) return false;
  const boundary = tokens.findIndex((token, index) => index > schemaIndex
    && ['to', 'from'].includes(word(token)));
  return identifierListIncludes(tokens, schemaIndex + 1, boundary < 0 ? tokens.length : boundary, 'public');
}

function identifierListIncludes(
  tokens: SqlToken[],
  start: number,
  end: number,
  expected: string,
): boolean {
  return tokens.slice(start, end).some(token => identifier(token, expected));
}

function publicTable(tokens: SqlToken[], start: number, expected: string): boolean {
  return identifier(tokens[start], expected)
    || (identifier(tokens[start], 'public') && tokens[start + 1]?.text === '.'
      && identifier(tokens[start + 2], expected));
}

function targetTriggerOnTasks(tokens: SqlToken[], triggerIndex: number): boolean {
  let nameIndex = triggerIndex + 1;
  if (word(tokens[nameIndex]) === 'if' && word(tokens[nameIndex + 1]) === 'exists') nameIndex += 2;
  if (!identifier(tokens[nameIndex], target)) return false;
  const onIndex = tokens.findIndex((token, index) => index > nameIndex && word(token) === 'on');
  return onIndex >= 0 && publicTable(tokens, onIndex + 1, 'tasks');
}

function targetTriggerLifecycleDdl(tokens: SqlToken[]): boolean {
  const actionIndex = tokens.findIndex(token => ['create', 'drop'].includes(word(token)));
  if (actionIndex < 0) return false;
  let cursor = actionIndex + 1;
  if (word(tokens[cursor]) === 'or' && word(tokens[cursor + 1]) === 'replace') cursor += 2;
  if (word(tokens[cursor]) === 'constraint') cursor += 1;
  return word(tokens[cursor]) === 'trigger' && targetTriggerOnTasks(tokens, cursor);
}

function lifecycle(sql: string, object: 'function' | 'trigger'): LifecycleEvent[] {
  const events: LifecycleEvent[] = [];
  for (const tokens of statements(sql)) {
    const first = word(tokens[0]);
    if (first !== 'create' && first !== 'alter' && first !== 'drop') continue;
    if (object === 'trigger' && targetTableTriggerAlter(tokens)) {
      events.push({ kind: 'alter', start: tokens[0].start, statement: sql.slice(tokens[0].start, tokens.at(-1)!.end) });
      continue;
    }
    let cursor = 1;
    if (first === 'create' && word(tokens[cursor]) === 'or' && word(tokens[cursor + 1]) === 'replace') cursor += 2;
    if (object === 'trigger' && word(tokens[cursor]) === 'constraint') cursor += 1;
    if (object === 'function' && !['function', 'routine'].includes(word(tokens[cursor]))) continue;
    if (object === 'trigger' && word(tokens[cursor]) !== 'trigger') continue;
    const matches = object === 'function'
      ? targetRoutineInList(tokens, cursor)
      : targetTriggerOnTasks(tokens, cursor);
    if (!matches) continue;
    events.push({
      kind: first,
      start: tokens[0].start,
      statement: sql.slice(tokens[0].start, tokens.at(-1)!.end),
    });
  }
  return events;
}

function functions(sql: string, name: string, zeroArguments = false): FunctionDefinition[] {
  const tokens = sqlTokens(sql);
  const definitions: FunctionDefinition[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index].text.toLowerCase() !== 'create') continue;
    let cursor = index + 1;
    if (tokens[cursor]?.text.toLowerCase() === 'or' && tokens[cursor + 1]?.text.toLowerCase() === 'replace') cursor += 2;
    if (tokens[cursor]?.text.toLowerCase() !== 'function'
      || !identifier(tokens[cursor + 1], 'public') || tokens[cursor + 2]?.text !== '.'
      || !identifier(tokens[cursor + 3], name) || tokens[cursor + 4]?.text !== '(') continue;
    const open = cursor + 4;
    let close = open + 1;
    for (let depth = 1; close < tokens.length && depth > 0; close += 1) {
      if (tokens[close].text === '(') depth += 1;
      else if (tokens[close].text === ')') depth -= 1;
    }
    const closeIndex = close - 1;
    if (zeroArguments && closeIndex !== open + 1) continue;
    const asIndex = tokens.findIndex((token, tokenIndex) => tokenIndex > closeIndex
      && token.text.toLowerCase() === 'as');
    const bodyToken = asIndex < 0 ? undefined : tokens[asIndex + 1];
    if (!bodyToken?.delimiter) throw new Error(`Missing dollar body for public.${name}`);
    const endIndex = tokens.findIndex((token, tokenIndex) => tokenIndex > asIndex + 1 && token.text === ';');
    if (endIndex < 0) throw new Error(`Unterminated public.${name} definition`);
    definitions.push({
      start: tokens[index].start,
      header: sql.slice(tokens[index].start, bodyToken.start),
      body: bodyToken.text.slice(bodyToken.delimiter.length, -bodyToken.delimiter.length),
      tail: sql.slice(bodyToken.end, tokens[endIndex].end),
    });
  }
  return definitions;
}

function explicitTargetGrantRoles(sql: string): string[] {
  const events = targetAclStatements(sql);
  if (events.length !== 1 || word(events[0][0]) !== 'grant') return [];
  const toIndex = events[0].findIndex(token => word(token) === 'to');
  const prefix = events[0].slice(0, toIndex + 1).map(word).join(' ');
  if (prefix !== `grant execute on function public . ${target} ( ) to`) return [];
  return events[0].slice(toIndex + 1).map(role).filter((value): value is string => value !== null).sort();
}

function targetAclStatements(sql: string): SqlToken[][] {
  return statements(sql).filter(tokens => {
    if (!['grant', 'revoke'].includes(word(tokens[0]))) return false;
    const onIndex = tokens.findIndex(token => word(token) === 'on');
    if (onIndex < 0 || !tokens.slice(1, onIndex).some(token => ['all', 'execute'].includes(word(token)))) return false;
    const boundary = tokens.findIndex(token => ['to', 'from'].includes(word(token)));
    const routineIndex = routineObjectIndex(tokens);
    return boundary > onIndex && ((routineIndex > onIndex
      && targetRoutineInList(tokens, routineIndex, boundary)) || allPublicRoutines(tokens));
  });
}

function grantees(tokens: SqlToken[], boundaryIndex: number): string[] {
  const values: string[] = [];
  for (const token of tokens.slice(boundaryIndex + 1)) {
    if (['cascade', 'restrict', 'with'].includes(word(token))) break;
    const value = role(token);
    if (value) values.push(value);
  }
  return values;
}

function proceduralBody(tokens: SqlToken[], afterAs = false): string | null {
  const asIndex = afterAs ? tokens.findIndex(token => word(token) === 'as') : -1;
  const bodyToken = tokens.find((token, index) => index > asIndex
    && (token.delimiter !== undefined || sqlStringContent(token) !== null));
  if (!bodyToken) return null;
  return bodyToken.delimiter
    ? bodyToken.text.slice(bodyToken.delimiter.length, -bodyToken.delimiter.length)
    : sqlStringContent(bodyToken);
}

function routineKey(tokens: SqlToken[], start: number): { key: string; next: number } | null {
  const value = (token: SqlToken | undefined): string | null => {
    if (!token) return null;
    if (token.text.startsWith('"')) return token.text.slice(1, -1).replaceAll('""', '"');
    return token.quoted || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(token.text) ? null : token.text.toLowerCase();
  };
  const first = value(tokens[start]);
  if (!first) return null;
  if (tokens[start + 1]?.text !== '.') return { key: `public.${first}`, next: start + 1 };
  const second = value(tokens[start + 2]);
  return second ? { key: `${first}.${second}`, next: start + 3 } : null;
}

function routineIdentity(
  tokens: SqlToken[],
  start: number,
  kind: 'function' | 'procedure',
): { key: string; next: number; minArity: number; arity: number } | null {
  const reference = routineKey(tokens, start);
  if (!reference || tokens[reference.next]?.text !== '(') return null;
  let depth = 0;
  let bracketDepth = 0;
  let commas = 0;
  let anyArgument = false;
  let hasArgument = false;
  let hasDefault = false;
  let minArity = 0;
  for (let index = reference.next; index < tokens.length; index += 1) {
    if (tokens[index].text === '(') { depth += 1; continue; }
    if (tokens[index].text === ')') {
      depth -= 1;
      if (depth === 0) {
        if (hasArgument && !hasDefault) minArity += 1;
        const arity = anyArgument ? commas + 1 : 0;
        return { key: `${kind}:${reference.key}/${arity}`, next: index + 1, minArity, arity };
      }
      continue;
    }
    if (tokens[index].text === '[') { bracketDepth += 1; continue; }
    if (tokens[index].text === ']') { bracketDepth -= 1; continue; }
    if (depth !== 1 || bracketDepth !== 0) continue;
    if (tokens[index].text === ',') {
      if (hasArgument && !hasDefault) minArity += 1;
      commas += 1; hasArgument = false; hasDefault = false;
    } else {
      anyArgument = true; hasArgument = true;
      if (word(tokens[index]) === 'default' || tokens[index].text === '=') hasDefault = true;
    }
  }
  return null;
}

function helperCallKeys(tokens: SqlToken[]): string[] {
  const keys: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const kind = word(tokens[index - 1]) === 'call' ? 'procedure' : 'function';
    const reference = routineIdentity(tokens, index, kind);
    if (!reference) continue;
    keys.push(reference.key);
  }
  return keys;
}

function assertNoTargetDdlBody(body: string): void {
  const bodyTokens = sqlTokens(body);
  const compactBody = body.toLowerCase().replace(/[^a-z0-9_]+/g, '');
  const literalEvidence = bodyTokens.map(token => token.delimiter
    ? token.text.slice(token.delimiter.length, -token.delimiter.length)
    : (sqlStringContent(token) ?? '')).join('');
  for (const bodyStatement of statements(body)) {
    const routineIndex = routineObjectIndex(bodyStatement);
    const boundary = bodyStatement.findIndex(token => ['to', 'from'].includes(word(token)));
    const routineDdl = routineIndex >= 0
      && targetRoutineInList(bodyStatement, routineIndex, boundary < 0 ? bodyStatement.length : boundary)
      && bodyStatement.some(token => ['create', 'alter', 'drop', 'grant', 'revoke'].includes(word(token)));
    const triggerDdl = targetTableTriggerAlter(bodyStatement) || targetTriggerLifecycleDdl(bodyStatement);
    const allRoutineDdl = allPublicRoutines(bodyStatement)
      && bodyStatement.some(token => ['grant', 'revoke'].includes(word(token)));
    if (routineDdl || triggerDdl || allRoutineDdl) throw new Error('Procedural target DDL is indeterminate');
  }
  for (let index = 0; index < bodyTokens.length; index += 1) {
    if (word(bodyTokens[index]) !== 'execute') continue;
    if (['function', 'procedure'].includes(word(bodyTokens[index + 1]))) continue;
    const end = bodyTokens.findIndex((token, tokenIndex) => tokenIndex > index && token.text === ';');
    const statement = body.slice(bodyTokens[index].start, end < 0 ? body.length : bodyTokens[end].end);
    const compactEvidence = `${statement}\n${literalEvidence}`.toLowerCase().replace(/[^a-z0-9_]+/g, '');
    const targetsRoutine = compactEvidence.includes(target) || compactBody.includes(target);
    const targetsAllRoutines = (compactEvidence.includes('allfunctionsinschema')
      || compactEvidence.includes('allroutinesinschema')) && compactEvidence.includes('public');
    const targetsTrigger = (compactEvidence.includes('altertablepublictasks')
      || compactEvidence.includes('altertabletasks')) && compactEvidence.includes('trigger')
      && (compactEvidence.includes(target) || compactEvidence.includes('triggerall')
        || compactEvidence.includes('triggeruser'));
    const hasLifecycleVerb = ['create', 'alter', 'drop', 'grant', 'revoke']
      .some(verb => compactEvidence.includes(verb));
    if ((targetsRoutine || targetsAllRoutines || targetsTrigger) && hasLifecycleVerb) {
      throw new Error('Procedural target DDL is indeterminate');
    }
  }
}

function assertNoProceduralTargetDdl(sql: string): void {
  const helpers = new Map<string, string[]>();
  const assertHelper = (key: string, active: Set<string>): void => {
    if (active.has(key)) return;
    const bodies = helpers.get(key);
    if (bodies === undefined) return;
    active.add(key);
    for (const body of bodies) {
      assertNoTargetDdlBody(body);
      for (const bodyStatement of statements(body)) {
        for (const child of helperCallKeys(bodyStatement)) assertHelper(child, active);
      }
    }
    active.delete(key);
  };
  for (const tokens of statements(sql)) {
    if (word(tokens[0]) === 'do') {
      const body = proceduralBody(tokens);
      if (body !== null) {
        assertNoTargetDdlBody(body);
        for (const bodyStatement of statements(body)) {
          for (const key of helperCallKeys(bodyStatement)) assertHelper(key, new Set());
        }
      }
      continue;
    }
    let cursor = 1;
    if (word(tokens[0]) === 'create' && word(tokens[cursor]) === 'or'
      && word(tokens[cursor + 1]) === 'replace') cursor += 2;
    if (word(tokens[0]) === 'create' && ['function', 'procedure'].includes(word(tokens[cursor]))) {
      const kind = word(tokens[cursor]) as 'function' | 'procedure';
      const reference = routineIdentity(tokens, cursor + 1, kind);
      const body = proceduralBody(tokens, true);
      if (reference && body !== null) {
        for (let arity = reference.minArity; arity <= reference.arity; arity += 1) {
          const key = reference.key.replace(/\/\d+$/, `/${arity}`);
          helpers.set(key, [...(helpers.get(key) ?? []), body]);
        }
      }
      continue;
    }
    if (!['call', 'delete', 'insert', 'merge', 'select', 'update', 'values', 'with'].includes(word(tokens[0]))) continue;
    for (const key of helperCallKeys(tokens)) assertHelper(key, new Set());
  }
}

function applyAclChange(
  roles: Set<string>,
  grantOptions: Set<string>,
  action: string,
  values: string[],
  withGrantOption: boolean,
  revokeGrantOption: boolean,
): void {
  for (const value of values) {
    if (action === 'grant') {
      roles.add(value);
      if (withGrantOption) grantOptions.add(value);
    } else if (revokeGrantOption) grantOptions.delete(value);
    else {
      roles.delete(value);
      grantOptions.delete(value);
    }
  }
}

function applyAclSql(sql: string, state: FunctionAclState): void {
  for (const tokens of statements(sql)) {
    const actionIndex = tokens.findIndex(token => ['grant', 'revoke'].includes(word(token)));
    const action = word(tokens[actionIndex]);
    const functionsIndex = tokens.findIndex(token => ['functions', 'routines'].includes(word(token)));
    const boundaryIndex = tokens.findIndex(token => ['to', 'from'].includes(word(token)));
    const routineIndex = routineObjectIndex(tokens);
    const affectsTarget = boundaryIndex >= 0 && ((routineIndex >= 0
      && targetRoutineInList(tokens, routineIndex, boundaryIndex)) || allPublicRoutines(tokens));
    const withGrantOption = tokens.some((token, index) => word(token) === 'with'
      && word(tokens[index + 1]) === 'grant' && word(tokens[index + 2]) === 'option');
    const revokeGrantOption = action === 'revoke' && word(tokens[actionIndex + 1]) === 'grant'
      && word(tokens[actionIndex + 2]) === 'option' && word(tokens[actionIndex + 3]) === 'for';
    if (word(tokens[0]) === 'alter' && word(tokens[1]) === 'default'
      && word(tokens[2]) === 'privileges' && functionsIndex > actionIndex && boundaryIndex > functionsIndex) {
      const forIndex = tokens.findIndex((token, index) => word(token) === 'for'
        && ['role', 'user'].includes(word(tokens[index + 1])));
      const schemaIndex = tokens.findIndex(token => word(token) === 'schema');
      const creatorEnd = schemaIndex >= 0 ? schemaIndex - 1 : actionIndex;
      if (forIndex >= 0 && (!['role', 'user'].includes(word(tokens[forIndex + 1]))
        || !identifierListIncludes(tokens, forIndex + 2, creatorEnd, 'postgres'))) continue;
      if (schemaIndex >= 0
        && !identifierListIncludes(tokens, schemaIndex + 1, actionIndex, 'public')) continue;
      const defaults = schemaIndex >= 0 ? state.schemaRoles : state.globalRoles;
      const defaultOptions = schemaIndex >= 0 ? state.schemaGrantOptions : state.globalGrantOptions;
      applyAclChange(defaults, defaultOptions, action, grantees(tokens, boundaryIndex), withGrantOption, revokeGrantOption);
      continue;
    }
    const functionIndex = routineIndex;
    if (state.effectiveRoles && ['grant', 'revoke'].includes(word(tokens[0]))
      && boundaryIndex >= 0 && allPublicRoutines(tokens)) {
      applyAclChange(state.effectiveRoles, state.effectiveGrantOptions!, word(tokens[0]),
        grantees(tokens, boundaryIndex), withGrantOption, revokeGrantOption);
      continue;
    }
    const createsTarget = word(tokens[0]) === 'create' && functionIndex >= 0
      && targetRoutineInList(tokens, functionIndex, boundaryIndex < 0 ? tokens.length : boundaryIndex);
    if (createsTarget && state.effectiveRoles === null) {
      state.effectiveRoles = new Set([...state.globalRoles, ...state.schemaRoles]);
      state.effectiveGrantOptions = new Set([...state.globalGrantOptions, ...state.schemaGrantOptions]);
      continue;
    }
    if (word(tokens[0]) === 'drop' && functionIndex >= 0
      && targetRoutineInList(tokens, functionIndex, boundaryIndex < 0 ? tokens.length : boundaryIndex)) {
      state.effectiveRoles = null;
      state.effectiveGrantOptions = null;
      continue;
    }
    if (!state.effectiveRoles || !['grant', 'revoke'].includes(word(tokens[0]))
      || functionIndex < 0 || boundaryIndex < 0
      || !targetRoutineInList(tokens, functionIndex, boundaryIndex)) continue;
    applyAclChange(state.effectiveRoles, state.effectiveGrantOptions!, word(tokens[0]),
      grantees(tokens, boundaryIndex), withGrantOption, revokeGrantOption);
  }
}

function replayExecuteRoles(sqlFiles: string[]): string[] {
  const state: FunctionAclState = {
    globalRoles: new Set(['PUBLIC', 'postgres']),
    schemaRoles: new Set(),
    effectiveRoles: null,
    globalGrantOptions: new Set(),
    schemaGrantOptions: new Set(),
    effectiveGrantOptions: null,
  };
  for (const sql of sqlFiles) {
    assertNoProceduralTargetDdl(sql);
    applyAclSql(sql, state);
  }
  if (!state.effectiveRoles) throw new Error(`Missing public.${target}() during ACL replay`);
  if (state.effectiveGrantOptions?.size) throw new Error('EXECUTE grant option drift');
  return [...state.effectiveRoles].sort();
}

function migrationReplaySql(): string[] {
  return fs.readdirSync(path.join(process.cwd(), migrationsPath))
    .filter(file => /^\d+_.+\.sql$/.test(file))
    .sort()
    .map(file => read(`${migrationsPath}/${file}`));
}

function assertParity(init: string): void {
  const suffix = finalSuffix(init);
  const replay = read(replayPath);
  assertNoProceduralTargetDdl(init);
  const actualFunction = one(functions(init, target, true), `${initPath} function`);
  const replayFunction = one(functions(replay, target, true), `${replayPath} function`);
  if (actualFunction.start <= init.indexOf(finalMarker)) throw new Error('Function precedes final marker');
  if (lifecycle(init, 'function').map(event => event.kind).join() !== 'create') throw new Error('Conflicting function lifecycle');
  if (normalized(actualFunction.header) !== normalized(replayFunction.header)) throw new Error('Function header drift');
  if (normalized(actualFunction.body) !== normalized(replayFunction.body)) throw new Error('Function body drift');
  if (normalized(actualFunction.tail) !== normalized(replayFunction.tail)) throw new Error('Function definition tail drift');
  const actualTriggers = lifecycle(init, 'trigger');
  const replayTriggers = lifecycle(replay, 'trigger');
  if (actualTriggers.map(event => event.kind).join() !== 'drop,create') throw new Error('Trigger lifecycle drift');
  if (actualTriggers.map(event => normalized(event.statement)).join('\n')
    !== replayTriggers.map(event => normalized(event.statement)).join('\n')) throw new Error('Trigger definition drift');
  const canonicalRoles = replayExecuteRoles(migrationReplaySql());
  if (replayExecuteRoles([init]).join() !== canonicalRoles.join()) throw new Error('Effective EXECUTE role drift');
  const requiredGrant = ['PUBLIC', 'anon', 'authenticated', 'service_role'];
  if (explicitTargetGrantRoles(suffix).join() !== requiredGrant.sort().join()) throw new Error('Explicit EXECUTE grant drift');
}

function one<T>(values: T[], label: string): T {
  if (values.length !== 1) throw new Error(`${label} must have exactly one executable definition; found ${values.length}`);
  return values[0];
}

function finalSuffix(init: string): string {
  const quota = init.indexOf(quotaMarker);
  if (quota < 0 || init.indexOf(quotaMarker, quota + 1) >= 0) throw new Error('Non-unique quota marker');
  return init.slice(quota + quotaMarker.length);
}

function replaceAfterFinalMarker(sql: string, from: string, to: string): string {
  const marker = sql.indexOf(finalMarker);
  const match = sql.indexOf(from, marker + finalMarker.length);
  if (marker < 0 || match < 0) throw new Error(`Missing completed_at mutation target: ${from}`);
  return `${sql.slice(0, match)}${to}${sql.slice(match + from.length)}`;
}

function synthetic(body = 'BEGIN NULL; END;'): string {
  return `CREATE OR REPLACE FUNCTION public.${target}() RETURNS trigger AS $body$${body}$body$ LANGUAGE plpgsql;`;
}

describe('task completed_at SQL scanner', () => {
  it('ignores comment, string, and dollar-body decoys but counts executable duplicates', () => {
    const decoy = synthetic();
    const hidden = `-- ${decoy}\n/* ${decoy} */\nSELECT '${decoy.replaceAll("'", "''")}';\nCREATE FUNCTION public.wrapper() RETURNS void AS $outer$${decoy}$outer$ LANGUAGE sql;`;
    expect(functions(`${hidden}\n${decoy}`, target, true)).toHaveLength(1);
    expect(() => one(functions(`${decoy}\n${decoy}`, target, true), target)).toThrow(/exactly one/i);
  });
  it('rejects a later CREATE OR REPLACE TRIGGER definition', () => {
    const trigger = 'CREATE TRIGGER set_task_completed_at BEFORE INSERT ON public.tasks FOR EACH ROW EXECUTE FUNCTION public.set_task_completed_at();';
    expect(lifecycle(`${trigger}\n${trigger.replace('CREATE TRIGGER', 'CREATE OR REPLACE TRIGGER')}`, 'trigger').map(event => event.kind)).toEqual(['create', 'create']);
  });
  it('keeps an escaped quote inside an E string from exposing lifecycle decoys', () => {
    const decoy = synthetic();
    const escaped = String.raw`SELECT E'escaped \' quote; ${decoy}';`;
    expect(functions(`${escaped}\n${decoy}`, target, true)).toHaveLength(1);
  });
  it('models global and schema-local default EXECUTE privileges separately', () => {
    const schemaRevoke = 'ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;';
    const globalRevoke = 'ALTER DEFAULT PRIVILEGES FOR ROLE postgres REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;';
    expect(replayExecuteRoles([`${schemaRevoke}\n${synthetic()}`])).toEqual(['PUBLIC', 'postgres']);
    expect(replayExecuteRoles([`${globalRevoke}\n${synthetic()}`])).toEqual(['postgres']);
  });
  it('scopes defaults to the creator and replays owner revoke plus drop/recreate', () => {
    const otherCreator = 'ALTER DEFAULT PRIVILEGES FOR ROLE decoy IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO rogue;';
    expect(replayExecuteRoles([`${otherCreator}\n${synthetic()}`])).toEqual(['PUBLIC', 'postgres']);
    expect(replayExecuteRoles([`${synthetic()}\nREVOKE EXECUTE ON FUNCTION public.${target}() FROM postgres;`])).toEqual(['PUBLIC']);
    const recreated = `${synthetic()}\nDROP FUNCTION public.${target}();\nALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon;\n${synthetic()}`;
    expect(replayExecuteRoles([recreated])).toEqual(['PUBLIC', 'anon', 'postgres']);
  });
  it('applies USER defaults when postgres and public are later list entries', () => {
    const laterEntries = 'ALTER DEFAULT PRIVILEGES FOR USER decoy, postgres IN SCHEMA private, public GRANT EXECUTE ON FUNCTIONS TO anon;';
    expect(replayExecuteRoles([`${laterEntries}\n${synthetic()}`])).toEqual(['PUBLIC', 'anon', 'postgres']);
  });
  it('applies ROUTINE and multi-target ACLs only to the zero-argument target', () => {
    const created = synthetic();
    expect(replayExecuteRoles([`${created}\nREVOKE EXECUTE ON ROUTINE public.${target}() FROM PUBLIC;`])).toEqual(['postgres']);
    expect(replayExecuteRoles([`${created}\nREVOKE EXECUTE ON FUNCTION public.decoy(), public.${target}() FROM PUBLIC;`])).toEqual(['postgres']);
    expect(replayExecuteRoles([`${created}\nREVOKE EXECUTE ON FUNCTION public.${target}(integer) FROM PUBLIC;`])).toEqual(['PUBLIC', 'postgres']);
  });
  it('preserves base EXECUTE after revoking only its grant option', () => {
    const revokeOption = `REVOKE GRANT OPTION FOR EXECUTE ON FUNCTION public.${target}() FROM PUBLIC;`;
    expect(replayExecuteRoles([`${synthetic()}\n${revokeOption}`])).toEqual(['PUBLIC', 'postgres']);
  });
  it('distinguishes grant-option FOR from a default-privilege creator clause', () => {
    const grant = 'ALTER DEFAULT PRIVILEGES GRANT EXECUTE ON FUNCTIONS TO authenticated WITH GRANT OPTION;';
    const revokeOption = 'ALTER DEFAULT PRIVILEGES REVOKE GRANT OPTION FOR EXECUTE ON FUNCTIONS FROM authenticated;';
    expect(replayExecuteRoles([`${grant}\n${revokeOption}\n${synthetic()}`]))
      .toEqual(['PUBLIC', 'authenticated', 'postgres']);
  });
  it('ignores same-named trigger DDL that belongs to another table', () => {
    const trigger = 'CREATE TRIGGER set_task_completed_at BEFORE INSERT ON public.other_tasks FOR EACH ROW EXECUTE FUNCTION public.decoy();';
    expect(lifecycle(trigger, 'trigger')).toEqual([]);
    expect(() => assertNoProceduralTargetDdl(`DO $review$ BEGIN ${trigger} END $review$;`)).not.toThrow();
  });
  it('does not execute an uncalled helper routine while scanning init SQL', () => {
    const helper = `CREATE FUNCTION public.completed_at_parity_helper() RETURNS void LANGUAGE plpgsql AS $helper$ BEGIN EXECUTE 'DROP FUNCTION public.${target}()'; END $helper$;`;
    expect(() => assertNoProceduralTargetDdl(helper)).not.toThrow();
  });
  it('terminates helper traversal cycles without inventing target DDL', () => {
    const first = 'CREATE FUNCTION public.parity_a() RETURNS void LANGUAGE plpgsql AS $a$ BEGIN PERFORM public.parity_b(); END $a$;';
    const second = 'CREATE FUNCTION public.parity_b() RETURNS void LANGUAGE plpgsql AS $b$ BEGIN PERFORM public.parity_a(); END $b$;';
    expect(() => assertNoProceduralTargetDdl(`${first}\n${second}\nSELECT public.parity_a();`)).not.toThrow();
  });
});
describe('task completed_at fresh-init parity', () => {
  it('accepts the unmodified global postimage', () => {
    expect(() => assertParity(read(initPath))).not.toThrow();
  });
  it('copies the exact zero-argument trigger function after the final marker', () => {
    const suffix = finalSuffix(read(initPath));
    const actual = one(functions(suffix, target, true), `${initPath} final suffix function`);
    const replay = one(functions(read(replayPath), target, true), `${replayPath} function`);
    expect(suffix.split(finalMarker)).toHaveLength(2);
    expect(actual.start).toBeGreaterThan(suffix.indexOf(finalMarker));
    expect(normalized(actual.header)).toBe(normalized(replay.header));
    expect(normalized(actual.body)).toBe(normalized(replay.body));
  });

  it('copies the exact trigger after the function with no later definition', () => {
    const suffix = finalSuffix(read(initPath));
    const actual = lifecycle(suffix, 'trigger');
    const replay = lifecycle(read(replayPath), 'trigger');
    const fn = one(functions(suffix, target, true), `${initPath} final suffix function`);
    expect(actual.map(event => event.kind)).toEqual(['drop', 'create']);
    expect(actual[0].start).toBeGreaterThan(fn.start);
    expect(actual.map(event => normalized(event.statement))).toEqual(replay.map(event => normalized(event.statement)));
    expect(normalized(actual[1].statement)).toBe(normalized('CREATE TRIGGER set_task_completed_at BEFORE INSERT OR UPDATE OF status, completed_at ON public.tasks FOR EACH ROW EXECUTE FUNCTION public.set_task_completed_at();'));
  });

  it('replays the canonical effective EXECUTE roles and requires an explicit fresh-init grant', () => {
    const canonicalRoles = replayExecuteRoles(migrationReplaySql());
    expect(canonicalRoles).toEqual(['PUBLIC', 'anon', 'authenticated', 'postgres', 'service_role']);
    expect(replayExecuteRoles([read(initPath)])).toEqual(canonicalRoles);
    expect(explicitTargetGrantRoles(finalSuffix(read(initPath)))).toEqual(['PUBLIC', 'anon', 'authenticated', 'service_role']);
  });

  it.each([
    ['body drift', (sql: string) => replaceAfterFinalMarker(sql, '  RETURN NEW;\nEND;\n$$;', '  RETURN OLD;\nEND;\n$$;'), /Function body drift/],
    ['SECURITY DEFINER', (sql: string) => replaceAfterFinalMarker(sql, 'LANGUAGE plpgsql\nSET search_path = public', 'LANGUAGE plpgsql\nSECURITY DEFINER\nSET search_path = public'), /Function header drift/],
    ['post-body SECURITY DEFINER', (sql: string) => replaceAfterFinalMarker(sql, '$$;\n\nGRANT EXECUTE ON FUNCTION public.set_task_completed_at()', '$$\nSECURITY DEFINER;\n\nGRANT EXECUTE ON FUNCTION public.set_task_completed_at()'), /Function definition tail drift/],
    ['search_path drift', (sql: string) => replaceAfterFinalMarker(sql, 'SET search_path = public\nAS $$', 'SET search_path = pg_catalog\nAS $$'), /Function header drift/],
    ['trigger event drift', (sql: string) => replaceAfterFinalMarker(sql, 'BEFORE INSERT OR UPDATE OF status, completed_at ON public.tasks', 'BEFORE INSERT ON public.tasks'), /Trigger definition drift/],
    ['missing trigger drop', (sql: string) => replaceAfterFinalMarker(sql, 'DROP TRIGGER IF EXISTS set_task_completed_at ON public.tasks;\n', ''), /Trigger lifecycle drift/],
    ['earlier duplicate function DDL', (sql: string) => sql.replace(quotaMarker, `${synthetic()}\n${quotaMarker}`), /exactly one/],
    ['unqualified later function DDL', (sql: string) => `${sql}\nDROP FUNCTION ${target}();`, /Conflicting function lifecycle/],
    ['procedural dynamic function DDL', (sql: string) => `${sql}\nDO $review$ BEGIN EXECUTE 'DROP FUNCTION ${target}()'; END $review$;`, /Procedural target DDL/],
    ['procedural concatenated function DDL', (sql: string) => `${sql}\nDO $review$ BEGIN EXECUTE 'DROP FUNCTION public.set_task_' || 'completed_at()'; END $review$;`, /Procedural target DDL/],
    ['procedural variable-built function DDL', (sql: string) => `${sql}\nDO $review$ DECLARE routine_name text := 'set_task_' || 'completed_at'; BEGIN EXECUTE format('DROP FUNCTION public.%I()', routine_name); END $review$;`, /Procedural target DDL/],
    ['procedural variable-only EXECUTE', (sql: string) => `${sql}\nDO $review$ DECLARE ddl text := 'DROP FUNCTION public.set_task_' || 'completed_at()'; BEGIN EXECUTE ddl; END $review$;`, /Procedural target DDL/],
    ['procedural separately-built function DDL', (sql: string) => `${sql}\nDO $review$ DECLARE prefix text := 'set_task_'; suffix text := 'completed_at'; ddl text; BEGIN ddl := 'DROP FUNCTION public.' || prefix || suffix || '()'; EXECUTE ddl; END $review$;`, /Procedural target DDL/],
    ['procedural split-verb function DDL', (sql: string) => `${sql}\nDO $review$ BEGIN EXECUTE 'AL' || 'TER FUNCTION public.set_task_completed_at() SECURITY DEFINER'; END $review$;`, /Procedural target DDL/],
    ['procedural dynamic trigger ALL disable', (sql: string) => `${sql}\nDO $review$ BEGIN EXECUTE 'ALTER TABLE public.tasks DISABLE TRIGGER ALL'; END $review$;`, /Procedural target DDL/],
    ['invoked helper function DDL', (sql: string) => `${sql}\nCREATE FUNCTION public.completed_at_parity_helper() RETURNS void LANGUAGE plpgsql AS $helper$ BEGIN EXECUTE 'DROP FUNCTION public.${target}()'; END $helper$;\nSELECT public.completed_at_parity_helper();`, /Procedural target DDL/],
    ['invoked helper procedure DDL', (sql: string) => `${sql}\nCREATE PROCEDURE public.completed_at_parity_helper() LANGUAGE plpgsql AS $helper$ BEGIN EXECUTE 'DROP FUNCTION public.${target}()'; END $helper$;\nCALL public.completed_at_parity_helper();`, /Procedural target DDL/],
    ['DO-invoked helper function DDL', (sql: string) => `${sql}\nCREATE FUNCTION public.completed_at_parity_helper() RETURNS void LANGUAGE plpgsql AS $helper$ BEGIN EXECUTE 'DROP FUNCTION public.${target}()'; END $helper$;\nDO $review$ BEGIN PERFORM public.completed_at_parity_helper(); END $review$;`, /Procedural target DDL/],
    ['invoked zero-argument helper before a safe overload', (sql: string) => `${sql}\nCREATE FUNCTION public.completed_at_parity_helper() RETURNS void LANGUAGE plpgsql AS $bad$ BEGIN EXECUTE 'DROP FUNCTION public.${target}()'; END $bad$;\nCREATE FUNCTION public.completed_at_parity_helper(value text) RETURNS void LANGUAGE plpgsql AS $safe$ BEGIN NULL; END $safe$;\nSELECT public.completed_at_parity_helper();`, /Procedural target DDL/],
    ['invoked helper before a safe same-arity overload', (sql: string) => `${sql}\nCREATE FUNCTION public.completed_at_parity_helper(value integer) RETURNS void LANGUAGE plpgsql AS $bad$ BEGIN EXECUTE 'DROP FUNCTION public.${target}()'; END $bad$;\nCREATE FUNCTION public.completed_at_parity_helper(value text) RETURNS void LANGUAGE plpgsql AS $safe$ BEGIN NULL; END $safe$;\nSELECT public.completed_at_parity_helper(1);`, /Procedural target DDL/],
    ['invoked helper through a default argument', (sql: string) => `${sql}\nCREATE FUNCTION public.completed_at_parity_helper(value text DEFAULT NULL) RETURNS void LANGUAGE plpgsql AS $bad$ BEGIN EXECUTE 'DROP FUNCTION public.${target}()'; END $bad$;\nSELECT public.completed_at_parity_helper();`, /Procedural target DDL/],
    ['invoked helper with an array argument', (sql: string) => `${sql}\nCREATE FUNCTION public.completed_at_parity_helper(value integer[]) RETURNS void LANGUAGE plpgsql AS $bad$ BEGIN EXECUTE 'DROP FUNCTION public.${target}()'; END $bad$;\nSELECT public.completed_at_parity_helper(ARRAY[1,2]);`, /Procedural target DDL/],
    ['invoked helper through a default array', (sql: string) => `${sql}\nCREATE FUNCTION public.completed_at_parity_helper(value integer[] DEFAULT ARRAY[1,2]) RETURNS void LANGUAGE plpgsql AS $bad$ BEGIN EXECUTE 'DROP FUNCTION public.${target}()'; END $bad$;\nSELECT public.completed_at_parity_helper();`, /Procedural target DDL/],
    ['invoked function sharing a name with a safe procedure', (sql: string) => `${sql}\nCREATE FUNCTION public.completed_at_parity_helper() RETURNS void LANGUAGE plpgsql AS $bad$ BEGIN EXECUTE 'DROP FUNCTION public.${target}()'; END $bad$;\nCREATE PROCEDURE public.completed_at_parity_helper() LANGUAGE plpgsql AS $safe$ BEGIN NULL; END $safe$;\nSELECT public.completed_at_parity_helper();`, /Procedural target DDL/],
    ['transitively invoked helper DDL', (sql: string) => `${sql}\nCREATE FUNCTION public.completed_at_inner() RETURNS void LANGUAGE plpgsql AS $inner$ BEGIN EXECUTE 'DROP FUNCTION public.${target}()'; END $inner$;\nCREATE FUNCTION public.completed_at_outer() RETURNS void LANGUAGE plpgsql AS $outer$ BEGIN PERFORM public.completed_at_inner(); END $outer$;\nSELECT public.completed_at_outer();`, /Procedural target DDL/],
    ['CTE-invoked helper DDL', (sql: string) => `${sql}\nCREATE FUNCTION public.completed_at_parity_helper() RETURNS integer LANGUAGE plpgsql AS $bad$ BEGIN EXECUTE 'DROP FUNCTION public.${target}()'; RETURN 1; END $bad$;\nWITH invoked AS (SELECT public.completed_at_parity_helper()) SELECT * FROM invoked;`, /Procedural target DDL/],
    ['VALUES-invoked helper DDL', (sql: string) => `${sql}\nCREATE FUNCTION public.completed_at_parity_helper() RETURNS integer LANGUAGE plpgsql AS $bad$ BEGIN EXECUTE 'DROP FUNCTION public.${target}()'; RETURN 1; END $bad$;\nVALUES (public.completed_at_parity_helper());`, /Procedural target DDL/],
    ['INSERT-SELECT-invoked helper DDL', (sql: string) => `${sql}\nCREATE FUNCTION public.completed_at_parity_helper() RETURNS integer LANGUAGE plpgsql AS $bad$ BEGIN EXECUTE 'DROP FUNCTION public.${target}()'; RETURN 1; END $bad$;\nINSERT INTO public.decoy(value) SELECT public.completed_at_parity_helper();`, /Procedural target DDL/],
    ['single-quoted procedural DDL', (sql: string) => `${sql}\nDO 'BEGIN ALTER FUNCTION public.${target}() SECURITY DEFINER; END';`, /Procedural target DDL/],
    ['E-quoted procedural DDL', (sql: string) => `${sql}\nDO E'BEGIN ALTER FUNCTION public.${target}() SECURITY DEFINER; END';`, /Procedural target DDL/],
    ['procedural direct function DDL', (sql: string) => `${sql}\nDO $review$ BEGIN ALTER FUNCTION public.${target}() SECURITY DEFINER; END $review$;`, /Procedural target DDL/],
    ['procedural direct ACL DDL', (sql: string) => `${sql}\nDO $review$ BEGIN REVOKE EXECUTE ON FUNCTION public.${target}() FROM authenticated; END $review$;`, /Procedural target DDL/],
    ['procedural all-functions ACL DDL', (sql: string) => `${sql}\nDO $review$ BEGIN REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM authenticated; END $review$;`, /Procedural target DDL/],
    ['procedural trigger ALL disable', (sql: string) => `${sql}\nDO $review$ BEGIN ALTER TABLE public.tasks DISABLE TRIGGER ALL; END $review$;`, /Procedural target DDL/],
    ['disabled trigger', (sql: string) => `${sql}\nALTER TABLE public.tasks DISABLE TRIGGER ${target};`, /Trigger lifecycle drift/],
    ['disabled trigger through IF EXISTS', (sql: string) => `${sql}\nALTER TABLE IF EXISTS public.tasks DISABLE TRIGGER ${target};`, /Trigger lifecycle drift/],
    ['disabled ALL triggers', (sql: string) => `${sql}\nALTER TABLE public.tasks DISABLE TRIGGER ALL;`, /Trigger lifecycle drift/],
    ['disabled USER triggers', (sql: string) => `${sql}\nALTER TABLE public.tasks DISABLE TRIGGER USER;`, /Trigger lifecycle drift/],
    ['replica-only trigger', (sql: string) => `${sql}\nALTER TABLE public.tasks ENABLE REPLICA TRIGGER ${target};`, /Trigger lifecycle drift/],
    ['always trigger', (sql: string) => `${sql}\nALTER TABLE public.tasks ENABLE ALWAYS TRIGGER ${target};`, /Trigger lifecycle drift/],
    ['later multi-action trigger disable', (sql: string) => `${sql}\nALTER TABLE public.tasks ENABLE TRIGGER set_updated_at, DISABLE TRIGGER ${target};`, /Trigger lifecycle drift/],
    ['all-functions ACL drift', (sql: string) => `${sql}\nREVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM authenticated;`, /Effective EXECUTE role drift/],
    ['later-listed all-functions ACL drift', (sql: string) => `${sql}\nREVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA private, public FROM authenticated;`, /Effective EXECUTE role drift/],
    ['all-routines ACL drift', (sql: string) => `${sql}\nGRANT EXECUTE ON ALL ROUTINES IN SCHEMA public TO rogue;`, /Effective EXECUTE role drift/],
    ['target EXECUTE grant option', (sql: string) => `${sql}\nGRANT EXECUTE ON FUNCTION public.${target}() TO authenticated WITH GRANT OPTION;`, /EXECUTE grant option drift/],
    ['default EXECUTE grant option', (sql: string) => replaceAfterFinalMarker(sql, 'CREATE OR REPLACE FUNCTION public.set_task_completed_at()', 'ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO authenticated WITH GRANT OPTION;\n\nCREATE OR REPLACE FUNCTION public.set_task_completed_at()'), /EXECUTE grant option drift/],
    ['duplicate target EXECUTE grant', (sql: string) => `${sql}\nGRANT EXECUTE ON FUNCTION public.${target}() TO PUBLIC, anon, authenticated, service_role;`, /Explicit EXECUTE grant drift/],
    ['net-zero later target ACL DDL', (sql: string) => `${sql}\nREVOKE EXECUTE ON FUNCTION public.${target}() FROM authenticated;\nGRANT EXECUTE ON FUNCTION public.${target}() TO authenticated;`, /Explicit EXECUTE grant drift/],
    ['net-zero later target ALL ACL DDL', (sql: string) => `${sql}\nREVOKE ALL ON FUNCTION public.${target}() FROM authenticated;\nGRANT ALL PRIVILEGES ON FUNCTION public.${target}() TO authenticated;`, /Explicit EXECUTE grant drift/],
    ['broad grant replacing the explicit target grant', (sql: string) => replaceAfterFinalMarker(sql, 'GRANT EXECUTE ON FUNCTION public.set_task_completed_at()\n  TO PUBLIC, anon, authenticated, service_role;', 'GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public\n  TO PUBLIC, anon, authenticated, service_role;'), /Explicit EXECUTE grant drift/],
    ['later conflicting function DDL', (sql: string) => `${sql}\nDROP FUNCTION public.set_task_completed_at();`, /Conflicting function lifecycle/],
    ['later conflicting trigger DDL', (sql: string) => `${sql}\nDROP TRIGGER set_task_completed_at ON public.tasks;`, /Trigger lifecycle drift/],
    ['later constraint trigger DDL', (sql: string) => `${sql}\nCREATE CONSTRAINT TRIGGER set_task_completed_at AFTER INSERT ON public.tasks FOR EACH ROW EXECUTE FUNCTION public.decoy();`, /Trigger lifecycle drift/],
    ['wrong EXECUTE role set', (sql: string) => replaceAfterFinalMarker(sql, 'TO PUBLIC, anon, authenticated, service_role;', 'TO PUBLIC, anon, authenticated;'), /Effective EXECUTE role drift/],
  ])('rejects %s', (_label, mutate, reason) => {
    expect(() => assertParity(mutate(read(initPath)))).toThrow(reason);
  });

  it('ties nullable completed_at to the active guarded sync call chain', () => {
    const init = read(initPath);
    const sync = functions(init, 'sync_upsert_task');
    const wrapper = sync.at(-1);
    const delegated = sync.at(-2);
    const batch = functions(init, 'batch_upsert_tasks').at(-1);
    expect(normalized(wrapper?.body ?? '')).toContain(normalized('public.sync_upsert_task__unguarded_20260628(payload)'));
    expect(sqlTokens(init).filter(token => token.delimiter).some(token => normalized(token.text.slice(token.delimiter!.length, -token.delimiter!.length)).includes(normalized('ALTER FUNCTION public.sync_upsert_task(JSONB) RENAME TO sync_upsert_task__unguarded_20260628;')))).toBe(true);
    expect(normalized(delegated?.body ?? '')).toContain(normalized('PERFORM public.batch_upsert_tasks(ARRAY[v_task_for_write], v_project_id);'));
    expect(normalized(batch?.body ?? '')).toContain(normalized("v_completed_at := NULLIF(COALESCE(v_task->>'completedAt', v_task->>'completed_at'), '')::timestamptz;"));
    expect(normalized(batch?.body ?? '')).toContain(normalized('v_priority, v_due_date, v_completed_at, v_expected'));
  });
});
