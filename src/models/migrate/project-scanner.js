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
   * Search a regular expression line by line
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
      for (let index = 0; index < lines.length; index++) {
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
