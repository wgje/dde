const YAML_BLOCK_SCALAR_TRIGGERS = /\n|\r/;

/**
 * 最小 YAML 输出器：
 * - 标量：使用 JSON.stringify 双引号 flow scalar
 * - 块标量：多行字符串用 `|`
 * - 列表：每项前缀 `- ` + 嵌套缩进
 */
export class YamlWriter {
  private readonly buf: string[] = [];
  private depth = 0;
  private pendingListItem = false;

  toString(): string {
    return `${this.buf.join('\n')}\n`;
  }

  private prefix(): string {
    return '  '.repeat(this.depth);
  }

  line(text: string): void {
    if (this.pendingListItem) {
      const outerPrefix = '  '.repeat(Math.max(0, this.depth - 1));
      this.buf.push(`${outerPrefix}- ${text}`);
      this.pendingListItem = false;
      return;
    }

    this.buf.push(this.prefix() + text);
  }

  key(name: string): void {
    this.line(`${safeYamlKey(name)}:`);
  }

  kv(name: string, value: string | number | boolean | null): void {
    this.line(`${safeYamlKey(name)}: ${yamlScalar(value)}`);
  }

  kvNullable(name: string, value: string | number | boolean | null | undefined): void {
    this.kv(name, value ?? null);
  }

  kvBlock(name: string, value: string): void {
    if (value === '') {
      this.line(`${safeYamlKey(name)}: ""`);
      return;
    }

    if (!YAML_BLOCK_SCALAR_TRIGGERS.test(value)) {
      this.line(`${safeYamlKey(name)}: ${yamlScalar(value)}`);
      return;
    }

    this.line(`${safeYamlKey(name)}: |-`);
    this.depth++;
    for (const line of value.split(/\r?\n/)) {
      this.buf.push(this.prefix() + line);
    }
    this.depth--;
  }

  kvList(name: string, arr: readonly (string | number | boolean)[]): void {
    if (arr.length === 0) {
      this.line(`${safeYamlKey(name)}: []`);
      return;
    }

    this.key(name);
    this.depth++;
    for (const value of arr) {
      this.line(`- ${yamlScalar(value)}`);
    }
    this.depth--;
  }

  listItem(fn: () => void): void {
    this.pendingListItem = true;
    this.depth++;
    try {
      fn();
      if (this.pendingListItem) {
        this.line('~');
      }
    } finally {
      this.depth--;
    }
  }

  indent(fn: () => void): void {
    this.depth++;
    try {
      fn();
    } finally {
      this.depth--;
    }
  }

  inlineEmptyList(): void {
    const last = this.buf.pop();
    this.buf.push(last === undefined ? '[]' : `${last} []`);
  }

  scalar(value: string | number | boolean | null): void {
    this.line(yamlScalar(value));
  }
}

function safeYamlKey(key: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ? key : JSON.stringify(key);
}

function yamlScalar(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'null';
  return JSON.stringify(value);
}
