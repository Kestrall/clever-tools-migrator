import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { analyzeProject } from './analyze.js';
import { GENERATED_MARKER, planMigrationFiles } from './migration-files.js';
import { ProjectScanner } from './project-scanner.js';

const execFileAsync = promisify(execFile);

/** Directories never copied in folder mode: they are rebuilt from lockfiles */
const NOT_COPIED = new Set([
  'node_modules',
  '.venv',
  'venv',
  '__pycache__',
  '.pytest_cache',
  '.ruff_cache',
  '.mypy_cache',
  '.next',
  '.nuxt',
  '.cache',
  '.gradle',
]);

const COMMIT_MESSAGES = {
  config: 'chore(clever): add Clever Cloud configuration files',
  setup: 'docs(clever): add Clever Cloud setup script and migration guide',
};

/**
 * @typedef {'auto'|'branch'|'folder'} ApplyMode
 */

/**
 * @typedef {object} ApplyOptions
 * @property {ApplyMode} mode
 * @property {string} branch
 * @property {string|null} [output] target directory in folder mode
 * @property {string|null} [type]
 * @property {string|null} [appName]
 * @property {boolean} [dryRun]
 */

/**
 * @typedef {object} ApplyResult
 * @property {'branch'|'folder'} mode
 * @property {string} targetPath
 * @property {string|null} branch
 * @property {string[]} commits
 * @property {Array<import('./migration-files.js').PlannedChange & { status: 'written'|'skipped', reason?: string }>} changes
 * @property {import('./report.js').Finding[]} todo
 * @property {import('./report.js').MigrationReport} report
 * @property {string|null} modeReason why auto mode picked this mode
 */

/**
 * Apply the migration plan on a git branch or in a copy of the project
 * @param {string} projectPath
 * @param {ApplyOptions} options
 * @returns {Promise<ApplyResult>}
 */
export async function applyMigration(projectPath, options) {
  const sourcePath = path.resolve(projectPath);
  const git = await getGitState(sourcePath);
  const { mode, reason: modeReason } = resolveMode(options.mode, git);

  if (mode === 'branch') {
    if (!git.isRepository) {
      throw new Error(`${sourcePath} is not a git repository, use --mode folder`);
    }
    if (!git.isClean) {
      throw new Error('The working tree has uncommitted changes: commit or stash them, or use --mode folder');
    }
    if (await branchExists(sourcePath, options.branch)) {
      throw new Error(`Branch "${options.branch}" already exists, choose another one with --branch`);
    }
  }

  const targetPath =
    mode === 'folder' ? path.resolve(options.output ?? `${sourcePath.replace(/\/+$/, '')}-clever`) : sourcePath;
  if (mode === 'folder') {
    if (targetPath === sourcePath || targetPath.startsWith(`${sourcePath}${path.sep}`)) {
      throw new Error('The output folder must be outside of the project');
    }
    const exists = await fs.stat(targetPath).catch(() => null);
    if (exists != null) {
      throw new Error(`${targetPath} already exists, choose another folder with --output`);
    }
  }

  // The plan is computed on the source so that the copy does not change the application name
  const report = analyzeProject(sourcePath, { type: options.type, appName: options.appName });
  const { changes, todo } = planMigrationFiles(new ProjectScanner(sourcePath), report);

  /** @type {ApplyResult} */
  const result = {
    mode,
    targetPath,
    branch: null,
    commits: [],
    changes: changes.map((change) => ({ ...change, status: 'written' })),
    todo,
    report,
    modeReason,
  };
  if (options.dryRun) {
    return result;
  }

  if (mode === 'folder') {
    await fs.cp(sourcePath, targetPath, {
      recursive: true,
      filter: (source) => !NOT_COPIED.has(path.basename(source)),
    });
  }

  for (const change of result.changes) {
    const target = path.join(targetPath, change.path);
    const existing = await fs.readFile(target, 'utf8').catch(() => null);
    // Never overwrite a file the user wrote, except the ones we only append to
    if (existing != null && change.path !== '.gitignore' && !existing.includes(GENERATED_MARKER)) {
      change.status = 'skipped';
      change.reason = 'file already exists';
      continue;
    }
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, change.content, { mode: change.executable ? 0o755 : 0o644 });
    if (change.executable) {
      await fs.chmod(target, 0o755);
    }
  }

  const targetGit = mode === 'branch' ? git : await getGitState(targetPath);
  if (targetGit.isRepository) {
    await runGit(targetPath, ['checkout', '-b', options.branch]);
    result.branch = options.branch;
    for (const group of /** @type {const} */ (['config', 'setup'])) {
      const paths = result.changes
        .filter((change) => change.group === group && change.status === 'written')
        .map((change) => change.path);
      if (paths.length === 0) {
        continue;
      }
      await runGit(targetPath, ['add', '--', ...paths]);
      // Committing explicit paths keeps any other local change out of the commit
      await runGit(targetPath, ['commit', '--no-verify', '-m', COMMIT_MESSAGES[group], '--', ...paths]);
      result.commits.push(COMMIT_MESSAGES[group]);
    }
  }

  return result;
}

/**
 * @param {ApplyMode} requested
 * @param {{ isRepository: boolean, isClean: boolean }} git
 * @returns {{ mode: 'branch'|'folder', reason: string|null }}
 */
export function resolveMode(requested, git) {
  if (requested !== 'auto') {
    return { mode: requested, reason: null };
  }
  if (!git.isRepository) {
    return { mode: 'folder', reason: 'not a git repository' };
  }
  if (!git.isClean) {
    return { mode: 'folder', reason: 'the working tree has uncommitted changes' };
  }
  return { mode: 'branch', reason: 'clean git repository' };
}

/**
 * @param {string} directory
 * @returns {Promise<{ isRepository: boolean, isClean: boolean }>}
 */
async function getGitState(directory) {
  try {
    await runGit(directory, ['rev-parse', '--is-inside-work-tree']);
  } catch {
    return { isRepository: false, isClean: false };
  }
  const status = await runGit(directory, ['status', '--porcelain', '--', '.']);
  return { isRepository: true, isClean: status.trim() === '' };
}

/**
 * @param {string} directory
 * @param {string} branch
 * @returns {Promise<boolean>}
 */
async function branchExists(directory, branch) {
  try {
    await runGit(directory, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {string} directory
 * @param {string[]} args
 * @returns {Promise<string>}
 */
async function runGit(directory, args) {
  try {
    const { stdout } = await execFileAsync('git', args, { cwd: directory });
    return stdout;
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error('git is required by `clever migrate apply`');
    }
    throw error;
  }
}
