// Dependency-free TOML parser for rule files. It covers the subset a
// hand-written rule file needs and fails loudly with a line/column diagnostic
// outside it, because silently reinterpreting a rule file would silently change
// a score. Dates are returned as source text: no rule field uses them.

const BARE_KEY = /[A-Za-z0-9_-]/;

// Line and column are carried on the error so a model can point the author at
// the exact token instead of making them grep the file.
export class TomlError extends Error {
  constructor(message, line, column) {
    super(`${message} (line ${line}, column ${column})`);
    this.name = 'TomlError';
    this.line = line;
    this.column = column;
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function signature(path) {
  return path.join('\u0000');
}

export function parseToml(source) {
  if (typeof source !== 'string') throw new TypeError('TOML source must be a string');
  const normalized = source.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  return new Parser(normalized).parse();
}

class Parser {
  constructor(source) {
    this.source = source;
    this.index = 0;
    this.line = 1;
    this.column = 1;
    this.root = {};
    // Explicit [table] declarations exist only to reject duplicates.
    this.tables = new Set();
    // Arrays built by [[...]] may keep receiving entries; plain arrays may not.
    this.tableArrays = new Set();
  }

  parse() {
    let current = this.root;
    for (;;) {
      this.skipBlank();
      if (this.eof()) return this.root;
      if (this.current() === '[') {
        current = this.parseHeader();
      } else {
        this.parseKeyValue(current);
      }
      this.expectEndOfLine();
    }
  }

  eof() {
    return this.index >= this.source.length;
  }

  current(offset = 0) {
    return this.source[this.index + offset];
  }

  advance() {
    const char = this.source[this.index];
    this.index += 1;
    if (char === '\n') {
      this.line += 1;
      this.column = 1;
    } else {
      this.column += 1;
    }
    return char;
  }

  error(message) {
    throw new TomlError(message, this.line, this.column);
  }

  skipSpaces() {
    while (this.current() === ' ' || this.current() === '\t') this.advance();
  }

  skipComment() {
    if (this.current() !== '#') return;
    while (!this.eof() && this.current() !== '\n') this.advance();
  }

  skipBlank() {
    for (;;) {
      this.skipSpaces();
      if (this.current() === '#') {
        this.skipComment();
        continue;
      }
      if (this.current() === '\n') {
        this.advance();
        continue;
      }
      return;
    }
  }

  expectEndOfLine() {
    this.skipSpaces();
    this.skipComment();
    if (this.eof()) return;
    if (this.current() !== '\n') this.error('unexpected content after the key/value');
    this.advance();
  }

  expect(text) {
    if (this.current() !== text) this.error(`expected "${text}"`);
    this.advance();
  }

  parseHeader() {
    this.advance(); // [
    const isArray = this.current() === '[';
    if (isArray) this.advance();
    this.skipSpaces();
    const path = this.parseKeyPath();
    this.skipSpaces();
    this.expect(']');
    if (isArray) this.expect(']');

    const parent = this.descend(path.slice(0, -1));
    const key = path[path.length - 1];
    const sig = signature(path);

    if (isArray) {
      let table;
      if (Object.hasOwn(parent, key)) {
        table = parent[key];
        if (!Array.isArray(table) || !this.tableArrays.has(table)) {
          this.error(`"${path.join('.')}" was already defined as another type; [[...]] cannot redeclare it`);
        }
      } else {
        table = [];
        this.tableArrays.add(table);
        parent[key] = table;
      }
      const entry = {};
      table.push(entry);
      this.tables.add(sig);
      return entry;
    }

    if (Object.hasOwn(parent, key)) {
      const existing = parent[key];
      if (Array.isArray(existing)) {
        this.error(`"${path.join('.')}" is an [[...]] array and cannot be redeclared with [table]`);
      }
      if (!isPlainObject(existing)) this.error(`"${path.join('.')}" was already defined as a value; [table] cannot redeclare it`);
      if (this.tables.has(sig)) this.error(`table "${path.join('.')}" is declared more than once`);
      this.tables.add(sig);
      return existing;
    }

    const table = {};
    parent[key] = table;
    this.tables.add(sig);
    return table;
  }

  // TOML creates intermediate tables implicitly; reuse them so a later header
  // or dotted key lands in the same table instead of a duplicate.
  descend(path) {
    let node = this.root;
    for (const key of path) {
      if (!Object.hasOwn(node, key)) node[key] = {};
      let next = node[key];
      if (Array.isArray(next)) {
        if (!this.tableArrays.has(next) || next.length === 0) {
          this.error(`"${key}" is not a table and cannot be a parent`);
        }
        next = next[next.length - 1];
      }
      if (!isPlainObject(next)) this.error(`"${key}" is not a table and cannot be a parent`);
      node = next;
    }
    return node;
  }

  parseKeyValue(container) {
    const path = this.parseKeyPath();
    this.skipSpaces();
    this.expect('=');
    this.skipSpaces();
    const value = this.parseValue();

    let node = container;
    for (const key of path.slice(0, -1)) {
      if (!Object.hasOwn(node, key)) node[key] = {};
      if (!isPlainObject(node[key])) this.error(`"${key}" is not a table; dotted assignment cannot continue`);
      node = node[key];
    }
    const key = path[path.length - 1];
    if (Object.hasOwn(node, key)) this.error(`key "${path.join('.')}" is defined more than once`);
    node[key] = value;
  }

  parseKeyPath() {
    const path = [this.parseKey()];
    for (;;) {
      this.skipSpaces();
      if (this.current() !== '.') break;
      this.advance();
      this.skipSpaces();
      path.push(this.parseKey());
    }
    return path;
  }

  parseKey() {
    const char = this.current();
    if (char === '"') return this.parseBasicString();
    if (char === "'") return this.parseLiteralString();
    const start = this.index;
    while (!this.eof() && BARE_KEY.test(this.current())) this.advance();
    if (this.index === start) this.error('expected a key name');
    return this.source.slice(start, this.index);
  }

  parseValue() {
    const char = this.current();
    if (char === undefined) this.error('value is incomplete');
    if (char === '"') return this.parseBasicString();
    if (char === "'") return this.parseLiteralString();
    if (char === '[') return this.parseArray();
    if (char === '{') return this.parseInlineTable();
    return this.parseScalarToken();
  }

  parseScalarToken() {
    const start = this.index;
    while (!this.eof()) {
      const char = this.current();
      if (char === ' ' || char === '\t' || char === '\n' || char === ',' || char === ']' || char === '}') break;
      this.advance();
    }
    const raw = this.source.slice(start, this.index);
    if (raw.length === 0) this.error('expected a value');
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    // Dates and times stay as source text; inventing Date objects would make
    // deep-equal tests depend on the host timezone.
    if (/^\d{4}-\d{2}-\d{2}(?:[Tt ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})?)?$/.test(raw)) return raw;
    if (/^\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(raw)) return raw;

    const token = raw.replace(/_/g, '');
    if (token === 'inf' || token === '+inf') return Infinity;
    if (token === '-inf') return -Infinity;
    if (token === 'nan' || token === '+nan' || token === '-nan') return Number.NaN;
    if (/^0x[0-9A-Fa-f]+$/.test(token)) return Number(token);
    if (/^0o[0-7]+$/.test(token)) return Number(token);
    if (/^0b[01]+$/.test(token)) return Number(token);
    if (/^[+-]?(?:0|[1-9][0-9]*)$/.test(token)) return Number(token);
    if (/^[+-]?(?:0|[1-9][0-9]*)\.[0-9]+(?:[eE][+-]?[0-9]+)?$/.test(token)) return Number(token);
    if (/^[+-]?(?:0|[1-9][0-9]*)[eE][+-]?[0-9]+$/.test(token)) return Number(token);
    this.error(`cannot recognize value "${raw}"`);
  }

  parseArray() {
    this.advance(); // [
    const values = [];
    for (;;) {
      this.skipBlank();
      if (this.eof()) this.error('array is not closed');
      if (this.current() === ']') {
        this.advance();
        return values;
      }
      values.push(this.parseValue());
      this.skipBlank();
      if (this.current() === ',') {
        this.advance();
        continue;
      }
      if (this.current() === ']') {
        this.advance();
        return values;
      }
      this.error('missing comma between array elements');
    }
  }

  parseInlineTable() {
    this.advance(); // {
    const table = {};
    this.skipSpaces();
    if (this.current() === '}') {
      this.advance();
      return table;
    }
    for (;;) {
      this.skipSpaces();
      const path = this.parseKeyPath();
      this.skipSpaces();
      this.expect('=');
      this.skipSpaces();
      const value = this.parseValue();
      let node = table;
      for (const key of path.slice(0, -1)) {
        if (!Object.hasOwn(node, key)) node[key] = {};
        if (!isPlainObject(node[key])) this.error(`"${key}" is not a table`);
        node = node[key];
      }
      const key = path[path.length - 1];
      if (Object.hasOwn(node, key)) this.error(`inline table key "${path.join('.')}" is defined more than once`);
      node[key] = value;
      this.skipSpaces();
      if (this.current() === ',') {
        this.advance();
        this.skipSpaces();
        if (this.current() === '}') this.error('inline tables do not allow a trailing comma');
        continue;
      }
      if (this.current() === '}') {
        this.advance();
        return table;
      }
      this.error('inline table is missing a comma or closing brace');
    }
  }

  parseBasicString() {
    if (this.source.startsWith('"""', this.index)) return this.parseMultilineBasic();
    this.advance(); // "
    let out = '';
    for (;;) {
      if (this.eof()) this.error('string is not closed');
      const char = this.advance();
      if (char === '"') return out;
      if (char === '\n') this.error('a single-line string cannot contain a newline');
      if (char === '\\') {
        out += this.parseEscape();
        continue;
      }
      out += char;
    }
  }

  parseMultilineBasic() {
    this.advance();
    this.advance();
    this.advance();
    if (this.current() === '\n') this.advance();
    let out = '';
    for (;;) {
      if (this.eof()) this.error('multi-line string is not closed');
      if (this.source.startsWith('"""', this.index)) {
        this.advance();
        this.advance();
        this.advance();
        return out;
      }
      const char = this.advance();
      if (char === '\\') {
        // TOML clips a backslash at the end of a line plus the whitespace that
        // follows, which is the only way to wrap a long inline script cleanly.
        let probe = this.index;
        while (this.source[probe] === ' ' || this.source[probe] === '\t') probe += 1;
        if (this.source[probe] === '\n') {
          while (!this.eof() && (this.current() === ' ' || this.current() === '\t' || this.current() === '\n')) this.advance();
          continue;
        }
        out += this.parseEscape();
        continue;
      }
      out += char;
    }
  }

  parseLiteralString() {
    if (this.source.startsWith("'''", this.index)) {
      this.advance();
      this.advance();
      this.advance();
      if (this.current() === '\n') this.advance();
      let out = '';
      for (;;) {
        if (this.eof()) this.error('multi-line string is not closed');
        if (this.source.startsWith("'''", this.index)) {
          this.advance();
          this.advance();
          this.advance();
          return out;
        }
        out += this.advance();
      }
    }
    this.advance(); // '
    let out = '';
    for (;;) {
      if (this.eof()) this.error('string is not closed');
      const char = this.advance();
      if (char === "'") return out;
      if (char === '\n') this.error('a single-line string cannot contain a newline');
      out += char;
    }
  }

  parseEscape() {
    const char = this.advance();
    switch (char) {
      case 'b': return '\b';
      case 't': return '\t';
      case 'n': return '\n';
      case 'f': return '\f';
      case 'r': return '\r';
      case '"': return '"';
      case '\\': return '\\';
      case 'u': return this.parseHexEscape(4);
      case 'U': return this.parseHexEscape(8);
      default: this.error(`invalid escape \\${char ?? ''}`);
    }
  }

  parseHexEscape(length) {
    const start = this.index;
    let hex = '';
    for (let i = 0; i < length; i += 1) {
      const char = this.current();
      if (char === undefined || !/[0-9A-Fa-f]/.test(char)) this.error('invalid Unicode escape');
      hex += char;
      this.advance();
    }
    if (this.index === start) this.error('invalid Unicode escape');
    return String.fromCodePoint(Number.parseInt(hex, 16));
  }
}
