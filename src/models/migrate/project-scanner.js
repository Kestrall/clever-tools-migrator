import fs from 'node:fs';
import path from 'node:path';

const IGNORED_DIRECTORIES = new Set([
  '.git',
  '.hg',
  '.svn',
  '.idea',
  '.vscode',
  '.venv',
  'venv',
  '__pycache__',
  '.next',
  '.nuxt',
  '.output',
  '.cache',
  '.gradle',
  'node_modules',
  'vendor',
  'bower_components',
  'dist',
  'build',
  'target',
  'coverage',
  'var',
  'tmp',
]);

const SOURCE_EXTENSIONS = new Set([
  '.js',
  '.mjs',
  '.cjs',
  '.ts',
  '.mts',
  '.py',
  '.php',
  '.go',
  '.rb',
  '.rs',
  '.java',
  '.kt',
  '.ex',
  '.exs',
]);

const CONFIG_EXTENSIONS = new Set(['.yml', '.yaml', '.toml', '.ini', '.properties', '.conf', '.json', '.xml']);

const MAX_DEPTH = 6;
const MAX_FILES = 8000;
const MAX_FILE_SIZE = 512 * 1024;

/**
 * Read-only view of a project directory, with cached file reads.
 * All paths exposed by this class are relative to the project root and use forward slashes.
 */
export class ProjectScanner {
  /**
   * @param {string} root
   */
  constructor(root) {
    this.root = path.resolve(root);
    /** @type {Map<string, string|null>} */
    this._contents = new Map();
    /** @type {string[]} */
    this.files = [];
    /** @type {Set<string>} */
    this.directories = new Set();
    this.truncated = false;
    this._walk('', 0);
    this._fileSet = new Set(this.files);
  }

  /**
   * @param {string} relativeDir
   * @param {number} depth
   */
  _walk(relativeDir, depth) {
    if (depth > MAX_DEPTH || this.files.length >= MAX_FILES) {
      this.truncated = this.truncated || this.files.length >= MAX_FILES;
      return;
    }
    let entries;
    try {
      entries = fs.readdirSync(path.join(this.root, relativeDir), { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const relativePath = relativeDir === '' ? entry.name : `${relativeDir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (IGNORED_DIRECTORIES.has(entry.name)) {
          continue;
        }
        this.directories.add(relativePath);
        this._walk(relativePath, depth + 1);
      } else if (entry.isFile()) {
        if (this.files.length >= MAX_FILES) {
          this.truncated = true;
          return;
        }
        this.files.push(relativePath);
      }
    }
  }

  /**
   * @param {string} relativePath
   * @returns {boolean}
   */
  has(relativePath) {
    return this._fileSet.has(relativePath);
  }

  /**
   * @param {string} relativePath
   * @returns {boolean}
   */
  hasDirectory(relativePath) {
    return this.directories.has(relativePath);
  }

  /**
   * Returns the first existing file among the candidates
   * @param {string[]} candidates
   * @returns {string|null}
   */
  first(candidates) {
    return candidates.find((candidate) => this.has(candidate)) ?? null;
  }

  /**
   * @param {string} relativePath
   * @returns {string|null}
   */
  read(relativePath) {
    if (this._contents.has(relativePath)) {
      return this._contents.get(relativePath) ?? null;
    }
    let content = null;
    try {
      const absolutePath = path.join(this.root, relativePath);
      if (fs.statSync(absolutePath).size <= MAX_FILE_SIZE) {
        content = fs.readFileSync(absolutePath, 'utf8');
      }
    } catch {
      content = null;
    }
    this._contents.set(relativePath, content);
    return content;
  }

  /**
   * @param {string} relativePath
   * @returns {any}
   */
  readJson(relativePath) {
    const content = this.read(relativePath);
    if (content == null) {
      return null;
    }
    try {
      return JSON.parse(content);
    } catch {
      return null;
    }
  }

  /**
   * Parse a dotenv file
   * @param {string} relativePath
   * @returns {Record<string, string>|null}
   */
  readEnvFile(relativePath) {
    const content = this.read(relativePath);
    if (content == null) {
      return null;
    }
    /** @type {Record<string, string>} */
    const variables = {};
    for (const line of content.split(/\r?\n/)) {
      const match = /^\s*(?:export\s+)?([A-Za-z_][\w.]*)\s*=\s*(.*?)\s*$/.exec(line);
      if (match != null) {
        variables[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
      }
    }
    return variables;
  }

  /**
   * @param {RegExp} pattern tested against the relative path
   * @returns {string[]}
   */
  find(pattern) {
    return this.files.filter((file) => pattern.test(file));
  }

  /**
   * Files that may contain application code or configuration
   * @returns {string[]}
   */
  get sourceFiles() {
    return this.files.filter((file) => {
      const extension = path.extname(file);
      return SOURCE_EXTENSIONS.has(extension) && !/(^|\/)(tests?|spec|__tests__|fixtures)\//.test(file);
    });
  }

  /**
   * @returns {string[]}
   */
  get configFiles() {
    return this.files.filter((file) => CONFIG_EXTENSIONS.has(path.extname(file)) && !file.endsWith('lock.json'));
  }

  /**
   * Search a regular expression line by line, ignoring comments and docstrings
   * @param {RegExp} pattern
   * @param {string[]} files
   * @returns {Array<{ file: string, line: number, text: string, match: RegExpExecArray }>}
   */
  grep(pattern, files = this.sourceFiles) {
    const results = [];
    for (const file of files) {
      const content = this.read(file);
      if (content == null) {
        continue;
      }
      const lines = content.split('\n');
      const isCode = codeLineMask(file, lines);
      for (let index = 0; index < lines.length; index++) {
        if (!isCode[index]) {
          continue;
        }
        const match = pattern.exec(lines[index]);
        if (match != null) {
          results.push({ file, line: index + 1, text: lines[index].trim(), match });
        }
      }
    }
    return results;
  }

  /**
   * Whether the project lives inside a git repository (looks in parent directories too)
   * @returns {boolean}
   */
  isInsideGitRepository() {
    let current = this.root;
    while (true) {
      if (fs.existsSync(path.join(current, '.git'))) {
        return true;
      }
      const parent = path.dirname(current);
      if (parent === current) {
        return false;
      }
      current = parent;
    }
  }
}

const HASH_COMMENT_EXTENSIONS = new Set([
  '.py',
  '.rb',
  '.ex',
  '.exs',
  '.yml',
  '.yaml',
  '.toml',
  '.ini',
  '.conf',
  '.properties',
]);
const C_COMMENT_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.ts', '.mts', '.go', '.rs', '.java', '.kt', '.php']);

/**
 * Tell which lines hold code, as opposed to comments and Python docstrings.
 * Line based heuristic: good enough to avoid reporting documentation examples.
 * @param {string} file
 * @param {string[]} lines
 * @returns {boolean[]}
 */
export function codeLineMask(file, lines) {
  const extension = path.extname(file);
  const hashComments = HASH_COMMENT_EXTENSIONS.has(extension) || extension === '.php';
  const cComments = C_COMMENT_EXTENSIONS.has(extension);
  /** @type {string|null} */
  let openBlock = null;

  return lines.map((line) => {
    const trimmed = line.trim();
    if (openBlock != null) {
      if (trimmed.includes(openBlock)) {
        openBlock = null;
      }
      return false;
    }
    if ((hashComments && trimmed.startsWith('#')) || (cComments && /^(\/\/|\*|\/\*)/.test(trimmed))) {
      if (cComments && trimmed.startsWith('/*') && !trimmed.includes('*/')) {
        openBlock = '*/';
      }
      return false;
    }
    if (extension === '.py') {
      const docstring = /^(?:[rbuf]{0,2})("""|''')/i.exec(trimmed);
      if (docstring != null) {
        // A docstring closed on the same line is still documentation
        if (trimmed.split(docstring[1]).length === 2) {
          openBlock = docstring[1];
        }
        return false;
      }
    }
    return true;
  });
}
