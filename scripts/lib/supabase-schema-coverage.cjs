'use strict';

const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const RUNTIME_SOURCE_ROOTS = [
  ['src'],
  ['supabase', 'functions'],
];

const NON_DATABASE_FROM_RECEIVERS = new Set([
  'Array',
  'Buffer',
  'Object',
  'Reflect',
]);

function getPropertyName(node) {
  const name = node?.name;
  if (
    ts.isIdentifier(name)
    || ts.isStringLiteral(name)
    || ts.isNumericLiteral(name)
  ) {
    return name.text;
  }
  return null;
}

function findTypeLiteralProperty(typeNode, propertyName) {
  if (!typeNode || !ts.isTypeLiteralNode(typeNode)) return null;
  return typeNode.members.find(member =>
    ts.isPropertySignature(member) && getPropertyName(member) === propertyName
  ) ?? null;
}

function extractGeneratedPublicSchemaMembers(source, collectionName, filePath) {
  const sourceFile = ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );

  for (const statement of sourceFile.statements) {
    if (
      !ts.isTypeAliasDeclaration(statement)
      || statement.name.text !== 'Database'
      || !ts.isTypeLiteralNode(statement.type)
    ) {
      continue;
    }

    const publicProperty = findTypeLiteralProperty(statement.type, 'public');
    const collectionProperty = publicProperty
      ? findTypeLiteralProperty(publicProperty.type, collectionName)
      : null;

    if (!collectionProperty || !ts.isTypeLiteralNode(collectionProperty.type)) {
      throw new Error(`Database.public.${collectionName} is missing from ${filePath}`);
    }

    return [...new Set(collectionProperty.type.members.map(getPropertyName).filter(Boolean))].sort();
  }

  throw new Error(`Database type alias is missing from ${filePath}`);
}

function extractGeneratedPublicTables(source, filePath = 'supabase.ts') {
  return extractGeneratedPublicSchemaMembers(source, 'Tables', filePath);
}

function extractGeneratedPublicTableShapes(source, filePath) {
  const sourceFile = ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );

  for (const statement of sourceFile.statements) {
    if (
      !ts.isTypeAliasDeclaration(statement)
      || statement.name.text !== 'Database'
      || !ts.isTypeLiteralNode(statement.type)
    ) {
      continue;
    }

    const publicProperty = findTypeLiteralProperty(statement.type, 'public');
    const tablesProperty = publicProperty
      ? findTypeLiteralProperty(publicProperty.type, 'Tables')
      : null;
    if (!tablesProperty || !ts.isTypeLiteralNode(tablesProperty.type)) {
      throw new Error(`Database.public.Tables is missing from ${filePath}`);
    }

    const tables = [];
    for (const tableProperty of tablesProperty.type.members) {
      if (!ts.isPropertySignature(tableProperty) || !ts.isTypeLiteralNode(tableProperty.type)) {
        continue;
      }
      const table = getPropertyName(tableProperty);
      const rowProperty = findTypeLiteralProperty(tableProperty.type, 'Row');
      const insertProperty = findTypeLiteralProperty(tableProperty.type, 'Insert');
      if (!table || !rowProperty || !ts.isTypeLiteralNode(rowProperty.type)) continue;
      tables.push([table, {
        row: rowProperty.type,
        insert: insertProperty && ts.isTypeLiteralNode(insertProperty.type)
          ? insertProperty.type
          : null,
      }]);
    }
    return tables.sort(([left], [right]) => left.localeCompare(right));
  }

  throw new Error(`Database type alias is missing from ${filePath}`);
}

function extractGeneratedPublicTableRows(source, filePath) {
  return extractGeneratedPublicTableShapes(source, filePath)
    .map(([table, shape]) => [table, shape.row]);
}

function extractGeneratedPublicTableColumns(source, filePath = 'supabase.ts') {
  return Object.fromEntries(
    extractGeneratedPublicTableRows(source, filePath).map(([table, rowType]) => [
      table,
      [...new Set(rowType.members.map(getPropertyName).filter(Boolean))].sort(),
    ]),
  );
}

function typeIncludesNull(typeNode) {
  if (!typeNode) return false;
  if (typeNode.kind === ts.SyntaxKind.NullKeyword) return true;
  if (ts.isLiteralTypeNode(typeNode) && typeNode.literal.kind === ts.SyntaxKind.NullKeyword) {
    return true;
  }
  if (ts.isUnionTypeNode(typeNode)) return typeNode.types.some(typeIncludesNull);
  if (ts.isParenthesizedTypeNode(typeNode)) return typeIncludesNull(typeNode.type);
  return false;
}

function extractGeneratedPublicNotNullColumns(source, filePath = 'supabase.ts') {
  return Object.fromEntries(
    extractGeneratedPublicTableRows(source, filePath).map(([table, rowType]) => [
      table,
      rowType.members
        .filter(member => (
          ts.isPropertySignature(member)
          && !member.questionToken
          && !typeIncludesNull(member.type)
        ))
        .map(getPropertyName)
        .filter(Boolean)
        .sort(),
    ]),
  );
}

function extractGeneratedPublicRequiredInsertColumns(source, filePath = 'supabase.ts') {
  return Object.fromEntries(
    extractGeneratedPublicTableShapes(source, filePath).map(([table, shape]) => [
      table,
      shape.insert
        ? shape.insert.members
          .filter(member => ts.isPropertySignature(member) && !member.questionToken)
          .map(getPropertyName)
          .filter(Boolean)
          .sort()
        : [],
    ]),
  );
}

function extractGeneratedPublicViews(source, filePath = 'supabase.ts') {
  return extractGeneratedPublicSchemaMembers(source, 'Views', filePath);
}

function literalText(node) {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)
    ? node.text
    : null;
}

function propertyAccessName(node) {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isElementAccessExpression(node) && node.argumentExpression) {
    return literalText(node.argumentExpression);
  }
  return null;
}

function schemaNameFromReceiver(receiver) {
  if (
    !ts.isCallExpression(receiver)
    || receiver.arguments.length === 0
    || propertyAccessName(receiver.expression) !== 'schema'
  ) {
    return null;
  }
  return literalText(receiver.arguments[0]);
}

function isStorageReceiver(receiver) {
  return propertyAccessName(receiver) === 'storage';
}

function extractDatabaseTableReferences(source, filePath = 'source.ts') {
  const sourceFile = ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    filePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const tables = new Set();

  function visit(node) {
    if (
      ts.isCallExpression(node)
      && node.arguments.length > 0
      && propertyAccessName(node.expression) === 'from'
    ) {
      const receiver = node.expression.expression;
      const table = literalText(node.arguments[0]);
      const schema = schemaNameFromReceiver(receiver);
      const receiverText = receiver.getText(sourceFile);

      if (
        table
        && !isStorageReceiver(receiver)
        && (!schema || schema === 'public')
        && !NON_DATABASE_FROM_RECEIVERS.has(receiverText)
      ) {
        tables.add(table);
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return [...tables].sort();
}

function tokenizeSql(source, baseOffset = 0, tokens = [], options = {}) {
  let index = 0;
  const captureExpressions = options.captureExpressions === true;

  while (index < source.length) {
    if (source.startsWith('--', index)) {
      index += 2;
      while (index < source.length && source[index] !== '\n') index += 1;
      continue;
    }

    if (source.startsWith('/*', index)) {
      index += 2;
      let depth = 1;
      while (index < source.length && depth > 0) {
        if (source.startsWith('/*', index)) {
          depth += 1;
          index += 2;
        } else if (source.startsWith('*/', index)) {
          depth -= 1;
          index += 2;
        } else {
          index += 1;
        }
      }
      continue;
    }

    if (source[index] === "'") {
      const start = index;
      let value = '';
      index += 1;
      while (index < source.length) {
        if (source[index] === "'" && source[index + 1] === "'") {
          value += "'";
          index += 2;
        } else if (source[index] === "'") {
          index += 1;
          break;
        } else {
          value += source[index];
          index += 1;
        }
      }
      if (captureExpressions) {
        tokens.push({
          kind: 'literal',
          value: `string:${value}`,
          index: baseOffset + start,
        });
      }
      continue;
    }

    if (source[index] === '$') {
      const tagMatch = source.slice(index).match(/^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/);
      if (tagMatch) {
        const tag = tagMatch[0];
        const bodyStart = index + tag.length;
        const bodyEnd = source.indexOf(tag, bodyStart);
        if (bodyEnd < 0) {
          index += tag.length;
          continue;
        }
        tokenizeSql(source.slice(bodyStart, bodyEnd), baseOffset + bodyStart, tokens, options);
        index = bodyEnd + tag.length;
        continue;
      }
    }

    if (source[index] === '"') {
      const start = index;
      let value = '';
      index += 1;
      while (index < source.length) {
        if (source[index] === '"' && source[index + 1] === '"') {
          value += '"';
          index += 2;
        } else if (source[index] === '"') {
          index += 1;
          break;
        } else {
          value += source[index];
          index += 1;
        }
      }
      tokens.push({ kind: 'identifier', value: value.toLowerCase(), index: baseOffset + start });
      continue;
    }

    const identifierMatch = source.slice(index).match(/^[A-Za-z_][A-Za-z0-9_$]*/);
    if (identifierMatch) {
      tokens.push({
        kind: 'identifier',
        value: identifierMatch[0].toLowerCase(),
        index: baseOffset + index,
      });
      index += identifierMatch[0].length;
      continue;
    }

    if (captureExpressions) {
      const numberMatch = source.slice(index).match(/^\d+(?:\.\d+)?/);
      if (numberMatch) {
        tokens.push({
          kind: 'literal',
          value: `number:${numberMatch[0]}`,
          index: baseOffset + index,
        });
        index += numberMatch[0].length;
        continue;
      }

      const operatorMatch = source.slice(index).match(
        /^(?:#>>|->>|::|#>|->|@>|<@|>=|<=|<>|!=|\|\||&&|[-+*/%=<>@\[\]])/,
      );
      if (operatorMatch) {
        tokens.push({
          kind: 'operator',
          value: operatorMatch[0],
          index: baseOffset + index,
        });
        index += operatorMatch[0].length;
        continue;
      }
    }

    if (['.', ',', ';', '(', ')'].includes(source[index])) {
      tokens.push({ kind: 'symbol', value: source[index], index: baseOffset + index });
    }
    index += 1;
  }

  return tokens;
}

function tokenValue(tokens, index) {
  return tokens[index]?.value ?? null;
}

function skipTokenSequence(tokens, start, sequence) {
  for (let offset = 0; offset < sequence.length; offset += 1) {
    if (tokenValue(tokens, start + offset) !== sequence[offset]) return start;
  }
  return start + sequence.length;
}

function readQualifiedTable(tokens, start) {
  const first = tokens[start];
  if (!first || first.kind !== 'identifier') return null;

  if (tokenValue(tokens, start + 1) === '.' && tokens[start + 2]?.kind === 'identifier') {
    return {
      schema: first.value,
      table: tokens[start + 2].value,
      next: start + 3,
    };
  }

  return { schema: null, table: first.value, next: start + 1 };
}

function isPublicTable(tableRef) {
  return tableRef && (!tableRef.schema || tableRef.schema === 'public');
}

function extractPublicTableEvents(source) {
  const tokens = tokenizeSql(source).sort((left, right) => left.index - right.index);
  const events = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const value = tokenValue(tokens, index);

    if (value === 'create') {
      let cursor = index + 1;
      let temporary = false;
      while (['global', 'local', 'temporary', 'temp', 'unlogged'].includes(tokenValue(tokens, cursor))) {
        temporary ||= ['temporary', 'temp'].includes(tokenValue(tokens, cursor));
        cursor += 1;
      }
      if (temporary || tokenValue(tokens, cursor) !== 'table') continue;
      cursor += 1;
      cursor = skipTokenSequence(tokens, cursor, ['if', 'not', 'exists']);
      if (tokenValue(tokens, cursor) === 'only') cursor += 1;
      const tableRef = readQualifiedTable(tokens, cursor);
      if (isPublicTable(tableRef)) {
        events.push({ action: 'create', table: tableRef.table });
      }
      continue;
    }

    if (value === 'drop' && tokenValue(tokens, index + 1) === 'table') {
      let cursor = index + 2;
      cursor = skipTokenSequence(tokens, cursor, ['if', 'exists']);
      if (tokenValue(tokens, cursor) === 'only') cursor += 1;

      while (cursor < tokens.length) {
        const tableRef = readQualifiedTable(tokens, cursor);
        if (!tableRef) break;
        if (isPublicTable(tableRef)) {
          events.push({ action: 'drop', table: tableRef.table });
        }
        cursor = tableRef.next;
        if (tokenValue(tokens, cursor) !== ',') break;
        cursor += 1;
      }
      continue;
    }

    if (value === 'alter' && tokenValue(tokens, index + 1) === 'table') {
      let cursor = index + 2;
      cursor = skipTokenSequence(tokens, cursor, ['if', 'exists']);
      if (tokenValue(tokens, cursor) === 'only') cursor += 1;
      const tableRef = readQualifiedTable(tokens, cursor);
      if (!isPublicTable(tableRef)) continue;
      cursor = tableRef.next;

      if (
        tokenValue(tokens, cursor) === 'rename'
        && tokenValue(tokens, cursor + 1) === 'to'
        && tokens[cursor + 2]?.kind === 'identifier'
      ) {
        events.push({
          action: 'rename',
          table: tableRef.table,
          targetTable: tokens[cursor + 2].value,
        });
      }
    }
  }

  return events;
}

function applyEventsToSet(tableSet, events) {
  for (const event of events) {
    if (event.action === 'create') {
      tableSet.add(event.table);
    } else if (event.action === 'drop') {
      tableSet.delete(event.table);
    } else if (event.action === 'rename') {
      tableSet.delete(event.table);
      tableSet.add(event.targetTable);
    }
  }
  return tableSet;
}

function applyPublicTableEvents(events, initialTables = []) {
  return [...applyEventsToSet(new Set(initialTables), events)].sort();
}

function readSecurityInvokerOption(tokens, start, end) {
  for (let index = start; index < end; index += 1) {
    if (tokenValue(tokens, index) !== 'security_invoker') continue;
    let cursor = index + 1;
    if (tokenValue(tokens, cursor) === '=') cursor += 1;
    const value = tokenValue(tokens, cursor);
    if (['true', 'on', 'string:true', 'string:on'].includes(value)) return true;
    if (['false', 'off', 'string:false', 'string:off'].includes(value)) return false;
  }
  return null;
}

function extractPublicViewState(source) {
  const tokens = tokenizeSql(source, 0, [], { captureExpressions: true })
    .sort((left, right) => left.index - right.index);
  const views = new Map();

  for (let index = 0; index < tokens.length; index += 1) {
    const value = tokenValue(tokens, index);

    if (value === 'create') {
      let cursor = index + 1;
      if (tokenValue(tokens, cursor) === 'or' && tokenValue(tokens, cursor + 1) === 'replace') {
        cursor += 2;
      }
      let temporary = false;
      while (['global', 'local', 'temporary', 'temp', 'recursive'].includes(tokenValue(tokens, cursor))) {
        temporary ||= ['temporary', 'temp'].includes(tokenValue(tokens, cursor));
        cursor += 1;
      }
      if (temporary || tokenValue(tokens, cursor) !== 'view') continue;
      cursor += 1;
      cursor = skipTokenSequence(tokens, cursor, ['if', 'not', 'exists']);
      const viewRef = readQualifiedTable(tokens, cursor);
      if (!isPublicTable(viewRef)) continue;

      const statementEnd = findStatementEnd(tokens, viewRef.next);
      views.set(
        viewRef.table,
        readSecurityInvokerOption(tokens, viewRef.next, statementEnd) === true,
      );
      continue;
    }

    if (value === 'drop' && tokenValue(tokens, index + 1) === 'view') {
      let cursor = index + 2;
      cursor = skipTokenSequence(tokens, cursor, ['if', 'exists']);
      while (cursor < tokens.length) {
        const viewRef = readQualifiedTable(tokens, cursor);
        if (!viewRef) break;
        if (isPublicTable(viewRef)) views.delete(viewRef.table);
        cursor = viewRef.next;
        if (tokenValue(tokens, cursor) !== ',') break;
        cursor += 1;
      }
      continue;
    }

    if (value !== 'alter' || tokenValue(tokens, index + 1) !== 'view') continue;
    let cursor = index + 2;
    cursor = skipTokenSequence(tokens, cursor, ['if', 'exists']);
    const viewRef = readQualifiedTable(tokens, cursor);
    if (!isPublicTable(viewRef) || !views.has(viewRef.table)) continue;
    cursor = viewRef.next;

    if (
      tokenValue(tokens, cursor) === 'rename'
      && tokenValue(tokens, cursor + 1) === 'to'
      && tokens[cursor + 2]?.kind === 'identifier'
    ) {
      const securityInvoker = views.get(viewRef.table);
      views.delete(viewRef.table);
      views.set(tokens[cursor + 2].value, securityInvoker);
      continue;
    }

    const statementEnd = findStatementEnd(tokens, cursor);
    if (tokenValue(tokens, cursor) === 'reset') {
      for (let optionIndex = cursor + 1; optionIndex < statementEnd; optionIndex += 1) {
        if (tokenValue(tokens, optionIndex) === 'security_invoker') {
          views.set(viewRef.table, false);
          break;
        }
      }
      continue;
    }

    const securityInvoker = readSecurityInvokerOption(tokens, cursor, statementEnd);
    if (securityInvoker !== null) views.set(viewRef.table, securityInvoker);
  }

  return [...views.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([view, securityInvoker]) => ({ view, securityInvoker }));
}

const ALL_VIEW_PRIVILEGES = [
  'delete',
  'insert',
  'maintain',
  'references',
  'select',
  'trigger',
  'truncate',
  'update',
];
const TRACKED_VIEW_PRIVILEGE_ROLES = ['public', 'anon', 'authenticated'];

function createViewPrivilegeState() {
  return Object.fromEntries(
    TRACKED_VIEW_PRIVILEGE_ROLES.map(role => [role, new Set()]),
  );
}

function readViewPrivilegeStatement(tokens, start, action) {
  let cursor = start + 1;
  if (
    action === 'revoke'
    && tokenValue(tokens, cursor) === 'grant'
    && tokenValue(tokens, cursor + 1) === 'option'
    && tokenValue(tokens, cursor + 2) === 'for'
  ) {
    return null;
  }

  const privileges = new Set();
  while (cursor < tokens.length && tokenValue(tokens, cursor) !== 'on') {
    const value = tokenValue(tokens, cursor);
    if (value === 'all') {
      for (const privilege of ALL_VIEW_PRIVILEGES) privileges.add(privilege);
    } else if (ALL_VIEW_PRIVILEGES.includes(value)) {
      privileges.add(value);
    }
    cursor += 1;
  }
  if (tokenValue(tokens, cursor) !== 'on' || privileges.size === 0) return null;
  cursor += 1;
  if (tokenValue(tokens, cursor) === 'table') cursor += 1;
  if (tokenValue(tokens, cursor) === 'all' && tokenValue(tokens, cursor + 1) === 'tables') {
    return null;
  }

  const views = [];
  while (cursor < tokens.length) {
    const boundary = action === 'grant' ? 'to' : 'from';
    if (tokenValue(tokens, cursor) === boundary) break;
    const viewRef = readQualifiedTable(tokens, cursor);
    if (!viewRef) return null;
    if (isPublicTable(viewRef)) views.push(viewRef.table);
    cursor = viewRef.next;
    if (tokenValue(tokens, cursor) === ',') cursor += 1;
  }

  const roleBoundary = action === 'grant' ? 'to' : 'from';
  if (tokenValue(tokens, cursor) !== roleBoundary) return null;
  cursor += 1;
  const roles = new Set();
  while (cursor < tokens.length) {
    const value = tokenValue(tokens, cursor);
    if (value === ';' || value === 'with' || value === 'granted') break;
    if (TRACKED_VIEW_PRIVILEGE_ROLES.includes(value)) roles.add(value);
    cursor += 1;
  }

  return { privileges, roles, views };
}

function extractPublicViewPrivilegeState(source) {
  const tokens = tokenizeSql(source).sort((left, right) => left.index - right.index);
  const views = new Map();

  for (let index = 0; index < tokens.length; index += 1) {
    const value = tokenValue(tokens, index);

    if (value === 'create') {
      let cursor = index + 1;
      let orReplace = false;
      if (tokenValue(tokens, cursor) === 'or' && tokenValue(tokens, cursor + 1) === 'replace') {
        orReplace = true;
        cursor += 2;
      }
      let temporary = false;
      while (['global', 'local', 'temporary', 'temp', 'recursive'].includes(tokenValue(tokens, cursor))) {
        temporary ||= ['temporary', 'temp'].includes(tokenValue(tokens, cursor));
        cursor += 1;
      }
      if (temporary || tokenValue(tokens, cursor) !== 'view') continue;
      cursor += 1;
      const ifNotExistsCursor = skipTokenSequence(tokens, cursor, ['if', 'not', 'exists']);
      const ifNotExists = ifNotExistsCursor !== cursor;
      cursor = ifNotExistsCursor;
      const viewRef = readQualifiedTable(tokens, cursor);
      if (!isPublicTable(viewRef)) continue;
      if (!views.has(viewRef.table) || (!orReplace && !ifNotExists)) {
        views.set(viewRef.table, createViewPrivilegeState());
      }
      continue;
    }

    if (value === 'drop' && tokenValue(tokens, index + 1) === 'view') {
      let cursor = index + 2;
      cursor = skipTokenSequence(tokens, cursor, ['if', 'exists']);
      while (cursor < tokens.length) {
        const viewRef = readQualifiedTable(tokens, cursor);
        if (!viewRef) break;
        if (isPublicTable(viewRef)) views.delete(viewRef.table);
        cursor = viewRef.next;
        if (tokenValue(tokens, cursor) !== ',') break;
        cursor += 1;
      }
      continue;
    }

    if (value === 'alter' && tokenValue(tokens, index + 1) === 'view') {
      let cursor = index + 2;
      cursor = skipTokenSequence(tokens, cursor, ['if', 'exists']);
      const viewRef = readQualifiedTable(tokens, cursor);
      if (!isPublicTable(viewRef) || !views.has(viewRef.table)) continue;
      cursor = viewRef.next;
      if (
        tokenValue(tokens, cursor) === 'rename'
        && tokenValue(tokens, cursor + 1) === 'to'
        && tokens[cursor + 2]?.kind === 'identifier'
      ) {
        const privileges = views.get(viewRef.table);
        views.delete(viewRef.table);
        views.set(tokens[cursor + 2].value, privileges);
      }
      continue;
    }

    if (value !== 'grant' && value !== 'revoke') continue;
    const statement = readViewPrivilegeStatement(tokens, index, value);
    if (!statement) continue;
    for (const view of statement.views) {
      const viewPrivileges = views.get(view);
      if (!viewPrivileges) continue;
      for (const role of statement.roles) {
        const rolePrivileges = viewPrivileges[role];
        if (value === 'grant') {
          for (const privilege of statement.privileges) rolePrivileges.add(privilege);
        } else {
          for (const privilege of statement.privileges) rolePrivileges.delete(privilege);
        }
      }
    }
  }

  return [...views.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([view, privileges]) => ({
      view,
      public: [...privileges.public].sort(),
      anon: [...privileges.anon].sort(),
      authenticated: [...privileges.authenticated].sort(),
    }));
}

function extractUnforcedPublicRlsTables(source) {
  const tokens = tokenizeSql(source).sort((left, right) => left.index - right.index);
  const tables = new Map();

  function dropTable(table) {
    tables.delete(table);
  }

  for (let index = 0; index < tokens.length; index += 1) {
    const value = tokenValue(tokens, index);

    if (value === 'create') {
      let cursor = index + 1;
      let temporary = false;
      while (['global', 'local', 'temporary', 'temp', 'unlogged'].includes(tokenValue(tokens, cursor))) {
        temporary ||= ['temporary', 'temp'].includes(tokenValue(tokens, cursor));
        cursor += 1;
      }
      if (temporary || tokenValue(tokens, cursor) !== 'table') continue;
      cursor += 1;
      cursor = skipTokenSequence(tokens, cursor, ['if', 'not', 'exists']);
      if (tokenValue(tokens, cursor) === 'only') cursor += 1;
      const tableRef = readQualifiedTable(tokens, cursor);
      if (isPublicTable(tableRef) && !tables.has(tableRef.table)) {
        tables.set(tableRef.table, { enabled: false, forced: false });
      }
      continue;
    }

    if (value === 'drop' && tokenValue(tokens, index + 1) === 'table') {
      let cursor = index + 2;
      cursor = skipTokenSequence(tokens, cursor, ['if', 'exists']);
      if (tokenValue(tokens, cursor) === 'only') cursor += 1;
      while (cursor < tokens.length) {
        const tableRef = readQualifiedTable(tokens, cursor);
        if (!tableRef) break;
        if (isPublicTable(tableRef)) dropTable(tableRef.table);
        cursor = tableRef.next;
        if (tokenValue(tokens, cursor) !== ',') break;
        cursor += 1;
      }
      continue;
    }

    if (value !== 'alter' || tokenValue(tokens, index + 1) !== 'table') continue;

    let cursor = index + 2;
    cursor = skipTokenSequence(tokens, cursor, ['if', 'exists']);
    if (tokenValue(tokens, cursor) === 'only') cursor += 1;
    const tableRef = readQualifiedTable(tokens, cursor);
    if (!isPublicTable(tableRef) || !tables.has(tableRef.table)) continue;
    cursor = tableRef.next;
    const statementEnd = findStatementEnd(tokens, cursor);

    if (
      tokenValue(tokens, cursor) === 'rename'
      && tokenValue(tokens, cursor + 1) === 'to'
      && tokens[cursor + 2]?.kind === 'identifier'
    ) {
      const targetTable = tokens[cursor + 2].value;
      const state = tables.get(tableRef.table);
      tables.delete(tableRef.table);
      tables.set(targetTable, state);
    } else {
      const state = tables.get(tableRef.table);
      for (const [start] of splitTopLevelSegments(tokens, cursor, statementEnd)) {
        if (
          tokenValue(tokens, start) === 'enable'
          && tokenValue(tokens, start + 1) === 'row'
          && tokenValue(tokens, start + 2) === 'level'
          && tokenValue(tokens, start + 3) === 'security'
        ) {
          state.enabled = true;
        } else if (
          tokenValue(tokens, start) === 'disable'
          && tokenValue(tokens, start + 1) === 'row'
          && tokenValue(tokens, start + 2) === 'level'
          && tokenValue(tokens, start + 3) === 'security'
        ) {
          state.enabled = false;
        } else if (
          tokenValue(tokens, start) === 'force'
          && tokenValue(tokens, start + 1) === 'row'
          && tokenValue(tokens, start + 2) === 'level'
          && tokenValue(tokens, start + 3) === 'security'
        ) {
          state.forced = true;
        } else if (
          tokenValue(tokens, start) === 'no'
          && tokenValue(tokens, start + 1) === 'force'
          && tokenValue(tokens, start + 2) === 'row'
          && tokenValue(tokens, start + 3) === 'level'
          && tokenValue(tokens, start + 4) === 'security'
        ) {
          state.forced = false;
        }
      }
    }

    index = statementEnd;
  }

  return [...tables.entries()]
    .filter(([, state]) => state.enabled && !state.forced)
    .map(([table]) => table)
    .sort();
}

function findMatchingParen(tokens, openIndex) {
  if (tokenValue(tokens, openIndex) !== '(') return -1;
  let depth = 0;
  for (let index = openIndex; index < tokens.length; index += 1) {
    if (tokenValue(tokens, index) === '(') depth += 1;
    if (tokenValue(tokens, index) === ')') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function findStatementEnd(tokens, start) {
  let depth = 0;
  for (let index = start; index < tokens.length; index += 1) {
    if (tokenValue(tokens, index) === '(') depth += 1;
    if (tokenValue(tokens, index) === ')') depth = Math.max(0, depth - 1);
    if (depth === 0 && tokenValue(tokens, index) === ';') return index;
  }
  return tokens.length;
}

function splitTopLevelSegments(tokens, start, end) {
  const segments = [];
  let depth = 0;
  let segmentStart = start;
  for (let index = start; index < end; index += 1) {
    if (tokenValue(tokens, index) === '(') depth += 1;
    if (tokenValue(tokens, index) === ')') depth = Math.max(0, depth - 1);
    if (depth === 0 && tokenValue(tokens, index) === ',') {
      segments.push([segmentStart, index]);
      segmentStart = index + 1;
    }
  }
  if (segmentStart < end) segments.push([segmentStart, end]);
  return segments;
}

function readSimpleColumnList(tokens, openIndex) {
  const closeIndex = findMatchingParen(tokens, openIndex);
  if (closeIndex < 0) return { columns: [], next: openIndex };
  const columns = [];
  for (const [start, end] of splitTopLevelSegments(tokens, openIndex + 1, closeIndex)) {
    const first = tokens[start];
    if (!first || first.kind !== 'identifier') return { columns: [], next: closeIndex + 1 };
    if (tokenValue(tokens, start + 1) === '(') return { columns: [], next: closeIndex + 1 };
    columns.push(
      tokenValue(tokens, start + 1) === '.' && tokens[start + 2]?.kind === 'identifier'
        ? tokens[start + 2].value
        : first.value,
    );
  }
  return { columns, next: closeIndex + 1 };
}

function normalizeIndexTokenRange(tokens, start, end) {
  return tokens
    .slice(start, end)
    .map(token => `${token.kind}:${token.value}`)
    .join('|');
}

function stripWrappingParentheses(tokens, start, end) {
  let rangeStart = start;
  let rangeEnd = end;
  while (
    tokenValue(tokens, rangeStart) === '('
    && findMatchingParen(tokens, rangeStart) === rangeEnd - 1
  ) {
    rangeStart += 1;
    rangeEnd -= 1;
  }
  return [rangeStart, rangeEnd];
}

function readPlainIndexColumns(tokens, openIndex, closeIndex) {
  const columns = [];
  for (const [start, end] of splitTopLevelSegments(tokens, openIndex + 1, closeIndex)) {
    if (end - start === 1 && tokens[start]?.kind === 'identifier') {
      columns.push(tokens[start].value);
      continue;
    }
    if (
      end - start === 3
      && tokens[start]?.kind === 'identifier'
      && tokenValue(tokens, start + 1) === '.'
      && tokens[start + 2]?.kind === 'identifier'
    ) {
      columns.push(tokens[start + 2].value);
      continue;
    }
    return [];
  }
  return columns;
}

function buildExactIndexSignature(index) {
  return [
    index.unique ? 'unique' : 'nonunique',
    index.method,
    index.keySignature,
    index.includeSignature,
    index.predicateSignature,
    index.otherTailSignature,
  ].join('||');
}

function readCreatePublicIndex(tokens, start) {
  if (tokenValue(tokens, start) !== 'create') return null;
  let cursor = start + 1;
  const unique = tokenValue(tokens, cursor) === 'unique';
  if (unique) cursor += 1;
  if (tokenValue(tokens, cursor) !== 'index') return null;
  cursor += 1;
  if (tokenValue(tokens, cursor) === 'concurrently') cursor += 1;
  const ifNotExistsCursor = skipTokenSequence(tokens, cursor, ['if', 'not', 'exists']);
  const ifNotExists = ifNotExistsCursor !== cursor;
  cursor = ifNotExistsCursor;

  const indexRef = readQualifiedTable(tokens, cursor);
  if (!indexRef) return null;
  const indexName = indexRef.table;
  cursor = indexRef.next;
  if (tokenValue(tokens, cursor) !== 'on') return null;
  cursor += 1;
  if (tokenValue(tokens, cursor) === 'only') cursor += 1;

  const tableRef = readQualifiedTable(tokens, cursor);
  if (!isPublicTable(tableRef)) return null;
  cursor = tableRef.next;

  let method = 'btree';
  if (tokenValue(tokens, cursor) === 'using' && tokens[cursor + 1]?.kind === 'identifier') {
    method = tokens[cursor + 1].value;
    cursor += 2;
  }
  while (cursor < tokens.length && tokenValue(tokens, cursor) !== '(' && tokenValue(tokens, cursor) !== ';') {
    cursor += 1;
  }
  if (tokenValue(tokens, cursor) !== '(') return null;

  const keyOpen = cursor;
  const keyClose = findMatchingParen(tokens, keyOpen);
  if (keyClose < 0) return null;
  const statementEnd = findStatementEnd(tokens, keyClose + 1);
  const plainColumns = readPlainIndexColumns(tokens, keyOpen, keyClose);
  const keySignature = normalizeIndexTokenRange(tokens, keyOpen + 1, keyClose);
  let includeSignature = '';
  let predicateSignature = '';
  const otherTailTokens = [];

  cursor = keyClose + 1;
  while (cursor < statementEnd) {
    if (tokenValue(tokens, cursor) === 'include' && tokenValue(tokens, cursor + 1) === '(') {
      const includeClose = findMatchingParen(tokens, cursor + 1);
      if (includeClose < 0 || includeClose >= statementEnd) return null;
      includeSignature = normalizeIndexTokenRange(tokens, cursor + 2, includeClose);
      cursor = includeClose + 1;
      continue;
    }
    if (tokenValue(tokens, cursor) === 'where') {
      const [predicateStart, predicateEnd] = stripWrappingParentheses(
        tokens,
        cursor + 1,
        statementEnd,
      );
      predicateSignature = normalizeIndexTokenRange(tokens, predicateStart, predicateEnd);
      break;
    }
    otherTailTokens.push(tokens[cursor]);
    cursor += 1;
  }

  const result = {
    table: tableRef.table,
    unique,
    method,
    keySignature,
    includeSignature,
    predicateSignature,
    otherTailSignature: otherTailTokens
      .map(token => `${token.kind}:${token.value}`)
      .join('|'),
    plainColumns,
    ifNotExists,
    next: statementEnd,
  };
  result.signature = buildExactIndexSignature(result);
  return { name: indexName, ...result };
}

function analyzePublicExactIndexState(source) {
  const tokens = tokenizeSql(source, 0, [], { captureExpressions: true })
    .sort((left, right) => left.index - right.index);
  const indexes = new Map();

  function dropTable(table) {
    for (const [name, index] of indexes) {
      if (index.table === table) indexes.delete(name);
    }
  }

  for (let index = 0; index < tokens.length; index += 1) {
    const value = tokenValue(tokens, index);

    if (value === 'create') {
      const definition = readCreatePublicIndex(tokens, index);
      if (definition) {
        if (!definition.ifNotExists || !indexes.has(definition.name)) {
          indexes.set(definition.name, definition);
        }
        index = Math.max(index, definition.next);
      }
      continue;
    }

    if (value === 'drop' && tokenValue(tokens, index + 1) === 'index') {
      let cursor = index + 2;
      if (tokenValue(tokens, cursor) === 'concurrently') cursor += 1;
      cursor = skipTokenSequence(tokens, cursor, ['if', 'exists']);
      while (cursor < tokens.length) {
        const indexRef = readQualifiedTable(tokens, cursor);
        if (!indexRef) break;
        indexes.delete(indexRef.table);
        cursor = indexRef.next;
        if (tokenValue(tokens, cursor) !== ',') break;
        cursor += 1;
      }
      continue;
    }

    if (value === 'drop' && tokenValue(tokens, index + 1) === 'table') {
      let cursor = index + 2;
      cursor = skipTokenSequence(tokens, cursor, ['if', 'exists']);
      if (tokenValue(tokens, cursor) === 'only') cursor += 1;
      while (cursor < tokens.length) {
        const tableRef = readQualifiedTable(tokens, cursor);
        if (!tableRef) break;
        if (isPublicTable(tableRef)) dropTable(tableRef.table);
        cursor = tableRef.next;
        if (tokenValue(tokens, cursor) !== ',') break;
        cursor += 1;
      }
      continue;
    }

    if (value === 'alter' && tokenValue(tokens, index + 1) === 'table') {
      let cursor = index + 2;
      cursor = skipTokenSequence(tokens, cursor, ['if', 'exists']);
      if (tokenValue(tokens, cursor) === 'only') cursor += 1;
      const tableRef = readQualifiedTable(tokens, cursor);
      if (!isPublicTable(tableRef)) continue;
      cursor = tableRef.next;
      if (
        tokenValue(tokens, cursor) === 'rename'
        && tokenValue(tokens, cursor + 1) === 'to'
        && tokens[cursor + 2]?.kind === 'identifier'
      ) {
        const targetTable = tokens[cursor + 2].value;
        for (const indexState of indexes.values()) {
          if (indexState.table === tableRef.table) indexState.table = targetTable;
        }
      } else if (
        tokenValue(tokens, cursor) === 'drop'
        && tokenValue(tokens, cursor + 1) === 'column'
      ) {
        cursor += 2;
        cursor = skipTokenSequence(tokens, cursor, ['if', 'exists']);
        const column = tokens[cursor]?.kind === 'identifier' ? tokens[cursor].value : null;
        if (column) {
          for (const [name, indexState] of indexes) {
            if (indexState.table === tableRef.table && indexState.plainColumns.includes(column)) {
              indexes.delete(name);
            }
          }
        }
      }
      continue;
    }

    if (value === 'alter' && tokenValue(tokens, index + 1) === 'index') {
      const indexRef = readQualifiedTable(tokens, index + 2);
      if (
        indexRef
        && tokenValue(tokens, indexRef.next) === 'rename'
        && tokenValue(tokens, indexRef.next + 1) === 'to'
        && tokens[indexRef.next + 2]?.kind === 'identifier'
      ) {
        const state = indexes.get(indexRef.table);
        if (state) {
          indexes.delete(indexRef.table);
          indexes.set(tokens[indexRef.next + 2].value, state);
        }
      }
    }
  }

  return indexes;
}

function addRedundantIndexGroup(groups, table, names) {
  const mergedNames = new Set(names);
  for (let index = groups.length - 1; index >= 0; index -= 1) {
    const group = groups[index];
    if (group.table !== table || !group.indexes.some(name => mergedNames.has(name))) continue;
    for (const name of group.indexes) mergedNames.add(name);
    groups.splice(index, 1);
  }
  groups.push({ table, indexes: [...mergedNames].sort() });
}

function extractRedundantPublicIndexes(source) {
  const exactIndexes = analyzePublicExactIndexState(source);
  const { tables } = analyzePublicSchemaIndexState(source);
  const groups = [];
  const indexesBySignature = new Map();

  for (const [name, index] of exactIndexes) {
    const key = `${index.table}||${index.signature}`;
    const names = indexesBySignature.get(key) ?? [];
    names.push(name);
    indexesBySignature.set(key, names);
  }
  for (const [key, names] of indexesBySignature) {
    if (names.length < 2) continue;
    addRedundantIndexGroup(groups, key.split('||', 1)[0], names);
  }

  for (const [indexName, index] of exactIndexes) {
    if (
      index.method !== 'btree'
      || index.plainColumns.length === 0
      || index.includeSignature
      || index.predicateSignature
      || index.otherTailSignature
    ) {
      continue;
    }
    const table = tables.get(index.table);
    if (!table) continue;
    for (const [constraintName, columns] of table.constraintIndexes) {
      if (
        columns.length === index.plainColumns.length
        && columns.every((column, columnIndex) => column === index.plainColumns[columnIndex])
      ) {
        addRedundantIndexGroup(groups, index.table, [indexName, constraintName]);
      }
    }
  }

  return groups.sort((left, right) =>
    left.table.localeCompare(right.table)
    || left.indexes.join(',').localeCompare(right.indexes.join(','))
  );
}

function createForeignKeyTableState() {
  return {
    columns: new Set(),
    notNullColumns: new Set(),
    defaultColumns: new Set(),
    generatedColumns: new Set(),
    foreignKeys: new Map(),
    constraintIndexes: new Map(),
  };
}

function inferConstraintName(table, columns, suffix) {
  return `${table}_${columns.join('_')}_${suffix}`;
}

function addForeignKey(state, table, name, columns) {
  if (columns.length === 0) return;
  state.foreignKeys.set(name || inferConstraintName(table, columns, 'fkey'), columns);
}

function addConstraintIndex(state, table, name, columns, suffix = 'key') {
  if (columns.length === 0) return;
  state.constraintIndexes.set(name || inferConstraintName(table, columns, suffix), columns);
}

function parseTableDefinitionSegment(tokens, start, end, table, state, tables) {
  let cursor = start;
  let constraintName = null;
  if (tokenValue(tokens, cursor) === 'constraint' && tokens[cursor + 1]?.kind === 'identifier') {
    constraintName = tokens[cursor + 1].value;
    cursor += 2;
  }

  if (tokenValue(tokens, cursor) === 'foreign' && tokenValue(tokens, cursor + 1) === 'key') {
    const { columns } = readSimpleColumnList(tokens, cursor + 2);
    addForeignKey(state, table, constraintName, columns);
    return;
  }

  if (tokenValue(tokens, cursor) === 'primary' && tokenValue(tokens, cursor + 1) === 'key') {
    const { columns } = readSimpleColumnList(tokens, cursor + 2);
    addConstraintIndex(state, table, constraintName, columns, 'pkey');
    for (const column of columns) state.notNullColumns.add(column);
    return;
  }

  if (tokenValue(tokens, cursor) === 'unique') {
    const { columns } = readSimpleColumnList(tokens, cursor + 1);
    addConstraintIndex(state, table, constraintName, columns);
    return;
  }

  if (tokenValue(tokens, cursor) === 'like') {
    const sourceTableRef = readQualifiedTable(tokens, cursor + 1);
    if (isPublicTable(sourceTableRef)) {
      const sourceState = tables.get(sourceTableRef.table);
      if (sourceState) {
        for (const column of sourceState.columns) state.columns.add(column);
        for (const column of sourceState.notNullColumns) state.notNullColumns.add(column);
        let includeDefaults = false;
        let includeGenerated = false;
        for (let index = sourceTableRef.next; index < end; index += 1) {
          if (tokenValue(tokens, index) !== 'including') continue;
          const option = tokenValue(tokens, index + 1);
          includeDefaults ||= option === 'defaults' || option === 'all';
          includeGenerated ||= ['generated', 'identity', 'all'].includes(option);
        }
        if (includeDefaults) {
          for (const column of sourceState.defaultColumns) state.defaultColumns.add(column);
        }
        if (includeGenerated) {
          for (const column of sourceState.generatedColumns) state.generatedColumns.add(column);
        }
      }
    }
    return;
  }

  if (['check', 'exclude'].includes(tokenValue(tokens, cursor))) return;

  const columnToken = tokens[cursor];
  if (!columnToken || columnToken.kind !== 'identifier') return;
  const column = columnToken.value;
  state.columns.add(column);
  if (['serial', 'smallserial', 'bigserial'].includes(tokenValue(tokens, cursor + 1))) {
    state.defaultColumns.add(column);
  }
  let inlineConstraintName = constraintName;

  for (let index = cursor + 1; index < end; index += 1) {
    const value = tokenValue(tokens, index);
    if (value === 'constraint' && tokens[index + 1]?.kind === 'identifier') {
      inlineConstraintName = tokens[index + 1].value;
    }
    if (value === 'references') {
      addForeignKey(state, table, inlineConstraintName, [column]);
    }
    if (value === 'primary' && tokenValue(tokens, index + 1) === 'key') {
      addConstraintIndex(state, table, inlineConstraintName, [column], 'pkey');
      state.notNullColumns.add(column);
    }
    if (value === 'unique') {
      addConstraintIndex(state, table, inlineConstraintName, [column]);
    }
    if (value === 'not' && tokenValue(tokens, index + 1) === 'null') {
      state.notNullColumns.add(column);
    }
    if (value === 'default') state.defaultColumns.add(column);
    if (value === 'generated' || value === 'identity') state.generatedColumns.add(column);
  }
}

function renameConstraintColumn(columns, oldName, newName) {
  return columns.map(column => column === oldName ? newName : column);
}

function removeColumnConstraints(state, column) {
  for (const [name, columns] of state.foreignKeys) {
    if (columns.includes(column)) state.foreignKeys.delete(name);
  }
  for (const [name, columns] of state.constraintIndexes) {
    if (columns.includes(column)) state.constraintIndexes.delete(name);
  }
}

function applyAlterTableSegment(tokens, start, end, table, state, indexes, tables) {
  let cursor = start;
  const action = tokenValue(tokens, cursor);

  if (action === 'add') {
    cursor += 1;
    cursor = skipTokenSequence(tokens, cursor, ['column']);
    cursor = skipTokenSequence(tokens, cursor, ['if', 'not', 'exists']);
    parseTableDefinitionSegment(tokens, cursor, end, table, state, tables);
    return;
  }

  if (action === 'drop') {
    cursor += 1;
    if (tokenValue(tokens, cursor) === 'constraint') {
      cursor += 1;
      cursor = skipTokenSequence(tokens, cursor, ['if', 'exists']);
      const name = tokens[cursor]?.kind === 'identifier' ? tokens[cursor].value : null;
      if (name) {
        state.foreignKeys.delete(name);
        state.constraintIndexes.delete(name);
      }
      return;
    }
    if (tokenValue(tokens, cursor) === 'column') {
      cursor += 1;
      cursor = skipTokenSequence(tokens, cursor, ['if', 'exists']);
      const column = tokens[cursor]?.kind === 'identifier' ? tokens[cursor].value : null;
      if (column) {
        state.columns.delete(column);
        state.notNullColumns.delete(column);
        state.defaultColumns.delete(column);
        state.generatedColumns.delete(column);
        removeColumnConstraints(state, column);
        for (const [name, index] of indexes) {
          if (index.table === table && index.columns.includes(column)) indexes.delete(name);
        }
      }
    }
    return;
  }

  if (
    action === 'alter'
    && tokenValue(tokens, cursor + 1) === 'column'
    && tokens[cursor + 2]?.kind === 'identifier'
  ) {
    const column = tokens[cursor + 2].value;
    for (let index = cursor + 3; index < end; index += 1) {
      if (tokenValue(tokens, index) === 'set' && tokenValue(tokens, index + 1) === 'not'
        && tokenValue(tokens, index + 2) === 'null') {
        state.notNullColumns.add(column);
      }
      if (tokenValue(tokens, index) === 'drop' && tokenValue(tokens, index + 1) === 'not'
        && tokenValue(tokens, index + 2) === 'null') {
        state.notNullColumns.delete(column);
      }
      if (tokenValue(tokens, index) === 'set' && tokenValue(tokens, index + 1) === 'default') {
        state.defaultColumns.add(column);
      }
      if (tokenValue(tokens, index) === 'drop' && tokenValue(tokens, index + 1) === 'default') {
        state.defaultColumns.delete(column);
      }
      if (
        tokenValue(tokens, index) === 'add'
        && tokenValue(tokens, index + 1) === 'generated'
      ) {
        state.generatedColumns.add(column);
      }
      if (
        tokenValue(tokens, index) === 'drop'
        && ['identity', 'expression'].includes(tokenValue(tokens, index + 1))
      ) {
        state.generatedColumns.delete(column);
      }
    }
    return;
  }

  if (
    action === 'rename'
    && tokenValue(tokens, cursor + 1) === 'column'
    && tokens[cursor + 2]?.kind === 'identifier'
    && tokenValue(tokens, cursor + 3) === 'to'
    && tokens[cursor + 4]?.kind === 'identifier'
  ) {
    const oldName = tokens[cursor + 2].value;
    const newName = tokens[cursor + 4].value;
    if (state.columns.delete(oldName)) state.columns.add(newName);
    if (state.notNullColumns.delete(oldName)) state.notNullColumns.add(newName);
    if (state.defaultColumns.delete(oldName)) state.defaultColumns.add(newName);
    if (state.generatedColumns.delete(oldName)) state.generatedColumns.add(newName);
    for (const [name, columns] of state.foreignKeys) {
      state.foreignKeys.set(name, renameConstraintColumn(columns, oldName, newName));
    }
    for (const [name, columns] of state.constraintIndexes) {
      state.constraintIndexes.set(name, renameConstraintColumn(columns, oldName, newName));
    }
    for (const index of indexes.values()) {
      if (index.table === table) {
        index.columns = renameConstraintColumn(index.columns, oldName, newName);
      }
    }
  }
}

function hasColumnPrefix(indexColumns, foreignKeyColumns) {
  return foreignKeyColumns.length > 0
    && foreignKeyColumns.every((column, index) => indexColumns[index] === column);
}

function formatForeignKey(table, columns) {
  return columns.length === 1
    ? `${table}.${columns[0]}`
    : `${table}.(${columns.join(',')})`;
}

const FOCUS_SESSIONS_STARTED_AT_V2_CUTOVER_BLOCK = /DO\s+\$\$\s*BEGIN\s*IF\s+EXISTS\s*\(\s*SELECT\s+1\s+FROM\s+information_schema\.columns\s+WHERE\s+table_schema\s*=\s*'public'\s+AND\s+table_name\s*=\s*'focus_sessions'\s+AND\s+column_name\s*=\s*'started_at_v2'\s*\)\s*THEN\s*(ALTER\s+TABLE\s+public\.focus_sessions\s+DROP\s+COLUMN\s+IF\s+EXISTS\s+started_at\s*;\s*ALTER\s+TABLE\s+public\.focus_sessions\s+RENAME\s+COLUMN\s+started_at_v2\s+TO\s+started_at\s*;\s*ALTER\s+TABLE\s+public\.focus_sessions\s+ALTER\s+COLUMN\s+started_at\s+SET\s+NOT\s+NULL\s*;\s*ALTER\s+TABLE\s+public\.focus_sessions\s+ALTER\s+COLUMN\s+started_at\s+SET\s+DEFAULT\s+now\s*\(\s*\)\s*;)\s*END\s+IF\s*;\s*END\s+\$\$\s*;/gi;

// This is intentionally narrow: schema coverage replays DDL, not arbitrary
// PL/pgSQL. The legacy focus_sessions.started_at_v2 cutover should only run
// when the shadow column exists at that point in the replay stream.
function rewriteRecognizedFocusSessionsStartedAtCutover(source) {
  let rewritten = '';
  let cursor = 0;
  let matched = false;

  for (const match of source.matchAll(FOCUS_SESSIONS_STARTED_AT_V2_CUTOVER_BLOCK)) {
    const start = match.index ?? -1;
    if (start < 0) continue;

    matched = true;
    rewritten += source.slice(cursor, start);

    const prefixState = analyzePublicSchemaIndexState(rewritten, {
      skipRecognizedFocusSessionsStartedAtCutover: true,
    });
    if (prefixState.tables.get('focus_sessions')?.columns.has('started_at_v2')) {
      rewritten += match[1];
    }

    cursor = start + match[0].length;
  }

  if (!matched) return source;
  rewritten += source.slice(cursor);
  return rewritten;
}

function analyzePublicSchemaIndexState(source, options = {}) {
  const normalizedSource = options.skipRecognizedFocusSessionsStartedAtCutover === true
    ? source
    : rewriteRecognizedFocusSessionsStartedAtCutover(source);
  const tokens = tokenizeSql(normalizedSource).sort((left, right) => left.index - right.index);
  const tables = new Map();
  const indexes = new Map();

  function dropTable(table) {
    tables.delete(table);
    for (const [name, index] of indexes) {
      if (index.table === table) indexes.delete(name);
    }
  }

  for (let index = 0; index < tokens.length; index += 1) {
    const value = tokenValue(tokens, index);

    if (value === 'create') {
      let cursor = index + 1;
      let temporary = false;
      while (['global', 'local', 'temporary', 'temp', 'unlogged'].includes(tokenValue(tokens, cursor))) {
        temporary ||= ['temporary', 'temp'].includes(tokenValue(tokens, cursor));
        cursor += 1;
      }

      if (!temporary && tokenValue(tokens, cursor) === 'table') {
        cursor += 1;
        cursor = skipTokenSequence(tokens, cursor, ['if', 'not', 'exists']);
        if (tokenValue(tokens, cursor) === 'only') cursor += 1;
        const tableRef = readQualifiedTable(tokens, cursor);
        if (!isPublicTable(tableRef)) continue;
        cursor = tableRef.next;
        if (tokenValue(tokens, cursor) !== '(') continue;
        const closeIndex = findMatchingParen(tokens, cursor);
        if (closeIndex < 0) continue;
        if (!tables.has(tableRef.table)) {
          const state = createForeignKeyTableState();
          for (const [start, end] of splitTopLevelSegments(tokens, cursor + 1, closeIndex)) {
            parseTableDefinitionSegment(tokens, start, end, tableRef.table, state, tables);
          }
          tables.set(tableRef.table, state);
        }
        index = closeIndex;
        continue;
      }

      cursor = index + 1;
      if (tokenValue(tokens, cursor) === 'unique') cursor += 1;
      if (tokenValue(tokens, cursor) === 'index') {
        cursor += 1;
        if (tokenValue(tokens, cursor) === 'concurrently') cursor += 1;
        const ifNotExistsCursor = skipTokenSequence(tokens, cursor, ['if', 'not', 'exists']);
        const ifNotExists = ifNotExistsCursor !== cursor;
        cursor = ifNotExistsCursor;
        const indexRef = readQualifiedTable(tokens, cursor);
        if (!indexRef) continue;
        const indexName = indexRef.table;
        cursor = indexRef.next;
        if (tokenValue(tokens, cursor) !== 'on') continue;
        cursor += 1;
        if (tokenValue(tokens, cursor) === 'only') cursor += 1;
        const tableRef = readQualifiedTable(tokens, cursor);
        if (!isPublicTable(tableRef)) continue;
        cursor = tableRef.next;
        if (tokenValue(tokens, cursor) === 'using') cursor += 2;
        while (cursor < tokens.length && tokenValue(tokens, cursor) !== '(' && tokenValue(tokens, cursor) !== ';') {
          cursor += 1;
        }
        const { columns, next } = readSimpleColumnList(tokens, cursor);
        if (columns.length > 0 && (!ifNotExists || !indexes.has(indexName))) {
          indexes.set(indexName, { table: tableRef.table, columns });
        }
        index = Math.max(index, next - 1);
      }
      continue;
    }

    if (value === 'drop' && tokenValue(tokens, index + 1) === 'table') {
      let cursor = index + 2;
      cursor = skipTokenSequence(tokens, cursor, ['if', 'exists']);
      if (tokenValue(tokens, cursor) === 'only') cursor += 1;
      while (cursor < tokens.length) {
        const tableRef = readQualifiedTable(tokens, cursor);
        if (!tableRef) break;
        if (isPublicTable(tableRef)) dropTable(tableRef.table);
        cursor = tableRef.next;
        if (tokenValue(tokens, cursor) !== ',') break;
        cursor += 1;
      }
      continue;
    }

    if (value === 'drop' && tokenValue(tokens, index + 1) === 'index') {
      let cursor = index + 2;
      if (tokenValue(tokens, cursor) === 'concurrently') cursor += 1;
      cursor = skipTokenSequence(tokens, cursor, ['if', 'exists']);
      while (cursor < tokens.length) {
        const indexRef = readQualifiedTable(tokens, cursor);
        if (!indexRef) break;
        indexes.delete(indexRef.table);
        cursor = indexRef.next;
        if (tokenValue(tokens, cursor) !== ',') break;
        cursor += 1;
      }
      continue;
    }

    if (value === 'alter' && tokenValue(tokens, index + 1) === 'table') {
      let cursor = index + 2;
      cursor = skipTokenSequence(tokens, cursor, ['if', 'exists']);
      if (tokenValue(tokens, cursor) === 'only') cursor += 1;
      const tableRef = readQualifiedTable(tokens, cursor);
      if (!isPublicTable(tableRef) || !tables.has(tableRef.table)) continue;
      cursor = tableRef.next;
      const statementEnd = findStatementEnd(tokens, cursor);

      if (
        tokenValue(tokens, cursor) === 'rename'
        && tokenValue(tokens, cursor + 1) === 'to'
        && tokens[cursor + 2]?.kind === 'identifier'
      ) {
        const targetTable = tokens[cursor + 2].value;
        const state = tables.get(tableRef.table);
        tables.delete(tableRef.table);
        tables.set(targetTable, state);
        for (const indexState of indexes.values()) {
          if (indexState.table === tableRef.table) indexState.table = targetTable;
        }
      } else {
        const state = tables.get(tableRef.table);
        for (const [start, end] of splitTopLevelSegments(tokens, cursor, statementEnd)) {
          applyAlterTableSegment(tokens, start, end, tableRef.table, state, indexes, tables);
        }
      }
      index = statementEnd;
      continue;
    }

    if (
      value === 'alter'
      && tokenValue(tokens, index + 1) === 'index'
      && tokens[index + 2]?.kind === 'identifier'
      && tokenValue(tokens, index + 3) === 'rename'
      && tokenValue(tokens, index + 4) === 'to'
      && tokens[index + 5]?.kind === 'identifier'
    ) {
      const currentName = tokens[index + 2].value;
      const targetName = tokens[index + 5].value;
      const state = indexes.get(currentName);
      if (state) {
        indexes.delete(currentName);
        indexes.set(targetName, state);
      }
    }
  }

  return { tables, indexes };
}

function extractPublicTableColumns(source) {
  const { tables } = analyzePublicSchemaIndexState(source);
  return Object.fromEntries(
    [...tables.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([table, state]) => [table, [...state.columns].sort()]),
  );
}

function extractPublicNotNullColumns(source) {
  const { tables } = analyzePublicSchemaIndexState(source);
  return Object.fromEntries(
    [...tables.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([table, state]) => [table, [...state.notNullColumns].sort()]),
  );
}

function extractPublicRequiredInsertColumns(source) {
  const { tables } = analyzePublicSchemaIndexState(source);
  return Object.fromEntries(
    [...tables.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([table, state]) => [
        table,
        [...state.notNullColumns]
          .filter(column => (
            !state.defaultColumns.has(column)
            && !state.generatedColumns.has(column)
          ))
          .sort(),
      ]),
  );
}

function tableIndexCoverage(table, state, indexes) {
  return [
    ...state.constraintIndexes.values(),
    ...[...indexes.values()].filter(index => index.table === table).map(index => index.columns),
  ];
}

function extractUnindexedPublicForeignKeys(source) {
  const { tables, indexes } = analyzePublicSchemaIndexState(source);
  const results = [];
  for (const [table, state] of tables) {
    const coverage = tableIndexCoverage(table, state, indexes);
    for (const columns of state.foreignKeys.values()) {
      if (!coverage.some(indexColumns => hasColumnPrefix(indexColumns, columns))) {
        results.push(formatForeignKey(table, columns));
      }
    }
  }
  return [...new Set(results)].sort();
}

function extractFinalPublicPolicies(source) {
  const tokens = tokenizeSql(source).sort((left, right) => left.index - right.index);
  const policies = new Map();

  function removeTablePolicies(table) {
    for (const [key, policy] of policies) {
      if (policy.table === table) policies.delete(key);
    }
  }

  for (let index = 0; index < tokens.length; index += 1) {
    const value = tokenValue(tokens, index);

    if (
      value === 'create'
      && tokenValue(tokens, index + 1) === 'policy'
      && tokens[index + 2]?.kind === 'identifier'
      && tokenValue(tokens, index + 3) === 'on'
    ) {
      const name = tokens[index + 2].value;
      const tableRef = readQualifiedTable(tokens, index + 4);
      if (!isPublicTable(tableRef)) continue;
      const statementEnd = findStatementEnd(tokens, tableRef.next);
      const endOffset = tokens[statementEnd]?.index ?? source.length;
      const key = `${tableRef.table}:${name}`;
      if (!policies.has(key)) {
        policies.set(key, {
          name,
          table: tableRef.table,
          statement: source.slice(tokens[index].index, endOffset + 1),
        });
      }
      index = statementEnd;
      continue;
    }

    if (value === 'drop' && tokenValue(tokens, index + 1) === 'policy') {
      let cursor = index + 2;
      cursor = skipTokenSequence(tokens, cursor, ['if', 'exists']);
      const name = tokens[cursor]?.kind === 'identifier' ? tokens[cursor].value : null;
      if (!name || tokenValue(tokens, cursor + 1) !== 'on') continue;
      const tableRef = readQualifiedTable(tokens, cursor + 2);
      if (isPublicTable(tableRef)) policies.delete(`${tableRef.table}:${name}`);
      continue;
    }

    if (value === 'drop' && tokenValue(tokens, index + 1) === 'table') {
      let cursor = index + 2;
      cursor = skipTokenSequence(tokens, cursor, ['if', 'exists']);
      if (tokenValue(tokens, cursor) === 'only') cursor += 1;
      while (cursor < tokens.length) {
        const tableRef = readQualifiedTable(tokens, cursor);
        if (!tableRef) break;
        if (isPublicTable(tableRef)) removeTablePolicies(tableRef.table);
        cursor = tableRef.next;
        if (tokenValue(tokens, cursor) !== ',') break;
        cursor += 1;
      }
      continue;
    }

    if (value === 'alter' && tokenValue(tokens, index + 1) === 'table') {
      let cursor = index + 2;
      cursor = skipTokenSequence(tokens, cursor, ['if', 'exists']);
      if (tokenValue(tokens, cursor) === 'only') cursor += 1;
      const tableRef = readQualifiedTable(tokens, cursor);
      if (!isPublicTable(tableRef)) continue;
      cursor = tableRef.next;
      if (
        tokenValue(tokens, cursor) === 'rename'
        && tokenValue(tokens, cursor + 1) === 'to'
        && tokens[cursor + 2]?.kind === 'identifier'
      ) {
        const targetTable = tokens[cursor + 2].value;
        for (const [key, policy] of [...policies]) {
          if (policy.table !== tableRef.table) continue;
          policies.delete(key);
          policy.table = targetTable;
          policies.set(`${targetTable}:${policy.name}`, policy);
        }
      }
    }
  }

  return [...policies.values()];
}

function extractDirectAuthUidPolicyColumns(statement, tableColumns) {
  const normalized = statement.replaceAll('"', '').replace(/\s+/g, ' ').toLowerCase();
  const columns = new Set();
  const patterns = [
    /(?:\(\s*select\s+)?auth\.uid\(\)(?:\s+as\s+[a-z_][a-z0-9_]*)?\s*\)?\s*=\s*([a-z_][a-z0-9_]*)\b(?!\s*\.)/g,
    /(?<!\.)\b([a-z_][a-z0-9_]*)\s*=\s*\(\s*select\s+auth\.uid\(\)(?:\s+as\s+[a-z_][a-z0-9_]*)?\s*\)/g,
    /(?<!\.)\b([a-z_][a-z0-9_]*)\s*=\s*auth\.uid\(\)/g,
  ];

  for (const pattern of patterns) {
    for (const match of normalized.matchAll(pattern)) {
      const column = match[1];
      if (tableColumns.has(column)) columns.add(column);
    }
  }
  return columns;
}

function extractUnindexedPublicRlsPolicyColumns(source) {
  const { tables, indexes } = analyzePublicSchemaIndexState(source);
  const results = [];

  for (const policy of extractFinalPublicPolicies(source)) {
    const state = tables.get(policy.table);
    if (!state) continue;
    const coverage = tableIndexCoverage(policy.table, state, indexes);
    for (const column of extractDirectAuthUidPolicyColumns(policy.statement, state.columns)) {
      if (!coverage.some(indexColumns => hasColumnPrefix(indexColumns, [column]))) {
        results.push(`${policy.table}.${column}`);
      }
    }
  }

  return [...new Set(results)].sort();
}

function collectFiles(directory, predicate, files = []) {
  if (!fs.existsSync(directory)) return files;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      collectFiles(fullPath, predicate, files);
    } else if (predicate(fullPath)) {
      files.push(fullPath);
    }
  }
  return files;
}

function isRuntimeTypeScriptFile(filePath) {
  const normalized = filePath.replaceAll('\\', '/');
  const baseName = path.basename(normalized);
  if (!/\.tsx?$/.test(baseName)) return false;
  if (/(?:^|\/)(?:tests?|__tests__)(?:\/|$)/.test(normalized)) return false;
  if (/\.(?:spec|test)(?:-helpers?)?\.tsx?$/.test(baseName)) return false;
  if (/(?:spec|test)-(?:helpers?|fixtures?|harness)\.tsx?$/.test(baseName)) return false;
  return true;
}

function difference(left, right) {
  return [...left].filter(value => !right.has(value)).sort();
}

function columnDifference(left, right) {
  const results = [];
  for (const [table, columns] of Object.entries(left)) {
    const targetColumns = right[table];
    if (!targetColumns) continue;
    const targetSet = new Set(targetColumns);
    for (const column of columns) {
      if (!targetSet.has(column)) results.push(`${table}.${column}`);
    }
  }
  return results.sort();
}

function notNullDifference(left, right, leftColumns, rightColumns) {
  const results = [];
  for (const [table, notNullColumns] of Object.entries(left)) {
    if (!right[table] || !leftColumns[table] || !rightColumns[table]) continue;
    const sharedColumns = new Set(
      leftColumns[table].filter(column => rightColumns[table].includes(column)),
    );
    const targetNotNull = new Set(right[table]);
    for (const column of notNullColumns) {
      if (sharedColumns.has(column) && !targetNotNull.has(column)) {
        results.push(`${table}.${column}`);
      }
    }
  }
  return results.sort();
}

function requiredInsertDifference(left, right, leftColumns, rightColumns) {
  return notNullDifference(left, right, leftColumns, rightColumns);
}

function extractUnsafeViewPrivileges(states) {
  return states
    .filter(state => (
      state.public.length > 0
      || state.anon.length > 0
      || state.authenticated.length !== 1
      || state.authenticated[0] !== 'select'
    ))
    .map(state => (
      `${state.view}(public=${state.public.join('|') || 'none'},`
      + `anon=${state.anon.join('|') || 'none'},`
      + `authenticated=${state.authenticated.join('|') || 'none'})`
    ));
}

function analyzeRepositorySchemaCoverage(root) {
  const generatedTypesPath = path.join(root, 'src', 'types', 'supabase.ts');
  const generatedTypesSource = fs.readFileSync(generatedTypesPath, 'utf8');
  const generatedTypeTables = extractGeneratedPublicTables(
    generatedTypesSource,
    generatedTypesPath,
  );
  const generatedTypeTableColumns = extractGeneratedPublicTableColumns(
    generatedTypesSource,
    generatedTypesPath,
  );
  const generatedTypeNotNullColumns = extractGeneratedPublicNotNullColumns(
    generatedTypesSource,
    generatedTypesPath,
  );
  const generatedTypeRequiredInsertColumns = extractGeneratedPublicRequiredInsertColumns(
    generatedTypesSource,
    generatedTypesPath,
  );
  const generatedTypeViews = extractGeneratedPublicViews(
    generatedTypesSource,
    generatedTypesPath,
  );

  const activeDatabaseTableRefs = new Map();
  for (const relativeSegments of RUNTIME_SOURCE_ROOTS) {
    const sourceRoot = path.join(root, ...relativeSegments);
    const sourceFiles = collectFiles(sourceRoot, isRuntimeTypeScriptFile);
    for (const sourcePath of sourceFiles) {
      if (path.resolve(sourcePath) === path.resolve(generatedTypesPath)) continue;
      const tables = extractDatabaseTableReferences(
        fs.readFileSync(sourcePath, 'utf8'),
        sourcePath,
      );
      for (const table of tables) {
        if (!activeDatabaseTableRefs.has(table)) activeDatabaseTableRefs.set(table, new Set());
        activeDatabaseTableRefs.get(table).add(path.relative(root, sourcePath).replaceAll('\\', '/'));
      }
    }
  }

  const migrationTables = new Set();
  const migrationSources = [];
  const migrationsPath = path.join(root, 'supabase', 'migrations');
  const migrationFiles = fs.readdirSync(migrationsPath, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.sql'))
    .map(entry => path.join(migrationsPath, entry.name))
    .sort();
  for (const migrationPath of migrationFiles) {
    const migrationSource = fs.readFileSync(migrationPath, 'utf8');
    migrationSources.push(migrationSource);
    applyEventsToSet(
      migrationTables,
      extractPublicTableEvents(migrationSource),
    );
  }
  const migrationReplaySource = migrationSources.join('\n;\n');
  const migrationReplayTableColumns = extractPublicTableColumns(migrationReplaySource);
  const migrationReplayNotNullColumns = extractPublicNotNullColumns(migrationReplaySource);
  const migrationReplayRequiredInsertColumns = extractPublicRequiredInsertColumns(
    migrationReplaySource,
  );

  const initPath = path.join(root, 'scripts', 'init-supabase.sql');
  const initSource = fs.readFileSync(initPath, 'utf8');
  const freshInitTableColumns = extractPublicTableColumns(initSource);
  const freshInitNotNullColumns = extractPublicNotNullColumns(initSource);
  const freshInitRequiredInsertColumns = extractPublicRequiredInsertColumns(initSource);
  const freshInitTables = new Set(applyPublicTableEvents(
    extractPublicTableEvents(initSource),
  ));
  const migrationReplayViewState = extractPublicViewState(migrationReplaySource);
  const freshInitViewState = extractPublicViewState(initSource);
  const migrationReplayViewPrivileges = extractPublicViewPrivilegeState(migrationReplaySource);
  const freshInitViewPrivileges = extractPublicViewPrivilegeState(initSource);
  const migrationReplayViews = new Set(migrationReplayViewState.map(({ view }) => view));
  const freshInitViews = new Set(freshInitViewState.map(({ view }) => view));
  const generatedSet = new Set(generatedTypeTables);
  const generatedViewSet = new Set(generatedTypeViews);
  const activeSet = new Set(activeDatabaseTableRefs.keys());

  return {
    generatedTypeTables,
    generatedTypeTableColumns,
    generatedTypeNotNullColumns,
    generatedTypeRequiredInsertColumns,
    generatedTypeViews,
    activeDatabaseTableRefs: Object.fromEntries(
      [...activeDatabaseTableRefs.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([table, files]) => [table, [...files].sort()]),
    ),
    migrationReplayTables: [...migrationTables].sort(),
    migrationReplayTableColumns,
    migrationReplayNotNullColumns,
    migrationReplayRequiredInsertColumns,
    migrationReplayViews: [...migrationReplayViews].sort(),
    freshInitTables: [...freshInitTables].sort(),
    freshInitTableColumns,
    freshInitNotNullColumns,
    freshInitRequiredInsertColumns,
    freshInitViews: [...freshInitViews].sort(),
    activeRefsMissingFromFreshInit: difference(activeSet, freshInitTables),
    activeRefsMissingFromGeneratedTypes: difference(activeSet, generatedSet),
    generatedTypesMissingFromFreshInit: difference(generatedSet, freshInitTables),
    freshInitMissingFromGeneratedTypes: difference(freshInitTables, generatedSet),
    migrationReplayMissingFromFreshInit: difference(migrationTables, freshInitTables),
    freshInitMissingFromMigrationReplay: difference(freshInitTables, migrationTables),
    generatedColumnsMissingFromFreshInit: columnDifference(
      generatedTypeTableColumns,
      freshInitTableColumns,
    ),
    freshInitColumnsMissingFromGeneratedTypes: columnDifference(
      freshInitTableColumns,
      generatedTypeTableColumns,
    ),
    migrationReplayColumnsMissingFromFreshInit: columnDifference(
      migrationReplayTableColumns,
      freshInitTableColumns,
    ),
    freshInitColumnsMissingFromMigrationReplay: columnDifference(
      freshInitTableColumns,
      migrationReplayTableColumns,
    ),
    generatedNotNullMissingFromFreshInit: notNullDifference(
      generatedTypeNotNullColumns,
      freshInitNotNullColumns,
      generatedTypeTableColumns,
      freshInitTableColumns,
    ),
    freshInitNotNullMissingFromGeneratedTypes: notNullDifference(
      freshInitNotNullColumns,
      generatedTypeNotNullColumns,
      freshInitTableColumns,
      generatedTypeTableColumns,
    ),
    migrationReplayNotNullMissingFromFreshInit: notNullDifference(
      migrationReplayNotNullColumns,
      freshInitNotNullColumns,
      migrationReplayTableColumns,
      freshInitTableColumns,
    ),
    freshInitNotNullMissingFromMigrationReplay: notNullDifference(
      freshInitNotNullColumns,
      migrationReplayNotNullColumns,
      freshInitTableColumns,
      migrationReplayTableColumns,
    ),
    generatedTypeRequiredInsertAheadOfFreshInit: requiredInsertDifference(
      generatedTypeRequiredInsertColumns,
      freshInitRequiredInsertColumns,
      generatedTypeTableColumns,
      freshInitTableColumns,
    ),
    freshInitRequiredInsertAheadOfGeneratedTypes: requiredInsertDifference(
      freshInitRequiredInsertColumns,
      generatedTypeRequiredInsertColumns,
      freshInitTableColumns,
      generatedTypeTableColumns,
    ),
    migrationReplayRequiredInsertAheadOfFreshInit: requiredInsertDifference(
      migrationReplayRequiredInsertColumns,
      freshInitRequiredInsertColumns,
      migrationReplayTableColumns,
      freshInitTableColumns,
    ),
    freshInitRequiredInsertAheadOfMigrationReplay: requiredInsertDifference(
      freshInitRequiredInsertColumns,
      migrationReplayRequiredInsertColumns,
      freshInitTableColumns,
      migrationReplayTableColumns,
    ),
    generatedViewsMissingFromFreshInit: difference(generatedViewSet, freshInitViews),
    freshInitViewsMissingFromGeneratedTypes: difference(freshInitViews, generatedViewSet),
    migrationReplayViewsMissingFromFreshInit: difference(migrationReplayViews, freshInitViews),
    freshInitViewsMissingFromMigrationReplay: difference(freshInitViews, migrationReplayViews),
    migrationReplayNonSecurityInvokerViews: migrationReplayViewState
      .filter(({ securityInvoker }) => !securityInvoker)
      .map(({ view }) => view),
    freshInitNonSecurityInvokerViews: freshInitViewState
      .filter(({ securityInvoker }) => !securityInvoker)
      .map(({ view }) => view),
    migrationReplayViewPrivileges,
    freshInitViewPrivileges,
    migrationReplayUnsafeViewPrivileges: extractUnsafeViewPrivileges(
      migrationReplayViewPrivileges,
    ),
    freshInitUnsafeViewPrivileges: extractUnsafeViewPrivileges(freshInitViewPrivileges),
    unindexedForeignKeys: extractUnindexedPublicForeignKeys(initSource),
    unindexedRlsPolicyColumns: extractUnindexedPublicRlsPolicyColumns(initSource),
    unforcedRlsTables: extractUnforcedPublicRlsTables(initSource),
    freshInitRedundantIndexes: extractRedundantPublicIndexes(initSource),
    migrationReplayRedundantIndexes: extractRedundantPublicIndexes(migrationReplaySource),
  };
}

module.exports = {
  analyzeRepositorySchemaCoverage,
  applyPublicTableEvents,
  extractDatabaseTableReferences,
  extractGeneratedPublicTableColumns,
  extractGeneratedPublicNotNullColumns,
  extractGeneratedPublicRequiredInsertColumns,
  extractGeneratedPublicTables,
  extractGeneratedPublicViews,
  extractPublicTableEvents,
  extractPublicTableColumns,
  extractPublicNotNullColumns,
  extractPublicRequiredInsertColumns,
  extractPublicViewPrivilegeState,
  extractPublicViewState,
  extractRedundantPublicIndexes,
  extractUnindexedPublicForeignKeys,
  extractUnindexedPublicRlsPolicyColumns,
  extractUnforcedPublicRlsTables,
};
