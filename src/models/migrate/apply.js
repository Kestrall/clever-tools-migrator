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
  code: 'fix(clever): adapt the code to Clever Cloud',
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
 * @property {boolean} [skipCode] do not rewrite source files
 * @property {import('./remote-state.js').RemoteState|null} [remote] what already exists on Clever Cloud
 */

/**
 * @typedef {object} ApplyResult
 * @property {'branch'|'folder'} mode
 * @property {string} targetPath
 * @property {string|null} branch
 * @property {'new'|'current'|'switched'} branchStatus whether the branch was created or reused
 * @property {string[]} commits
 * @property {Array<import('./migration-files.js').PlannedChange & { status: 'written'|'skipped', reason?: string }>} changes
 * @property {import('./report.js').Finding[]} todo
 * @property {import('./code-fixes.js').CodeEdit[]} edits
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
  }

  // An existing branch is reused: switch to it before the analysis, so that the plan starts from its content
  let branchStatus = /** @type {'new'|'current'|'switched'} */ ('new');
  if (mode === 'branch' && (await branchExists(sourcePath, options.branch))) {
    const currentBranch = (await runGit(sourcePath, ['branch', '--show-current'])).trim();
    branchStatus = currentBranch === options.branch ? 'current' : 'switched';
    if (branchStatus === 'switched' && !options.dryRun) {
      await runGit(sourcePath, ['checkout', '--quiet', options.branch]);
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
  const report = analyzeProject(sourcePath, { type: options.type, appName: options.appName, remote: options.remote });
  const { changes, todo, edits } = planMigrationFiles(new ProjectScanner(sourcePath), report, {
    code: !options.skipCode,
  });

  /** @type {ApplyResult} */
  const result = {
    mode,
    targetPath,
    branch: null,
    branchStatus,
    commits: [],
    changes: changes.map((change) => ({ ...change, status: 'written' })),
    todo,
    edits,
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
    // Never overwrite a file the user wrote, except .gitignore (appended to) and code fixes (computed from it)
    const isDerivedFromExisting = change.path === '.gitignore' || change.group === 'code';
    if (existing != null && !isDerivedFromExisting && !existing.includes(GENERATED_MARKER)) {
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

  // composer.lock must follow the platform written in composer.json
  const composerPackages = report.composerPlatform.flatMap((entry) => entry.packages);
  if (
    composerPackages.length > 0 &&
    result.changes.some((change) => change.path === 'composer.json' && change.status === 'written')
  ) {
    const updated = await updateComposerLock(targetPath, composerPackages);
    if (updated) {
      result.changes.push({
        path: 'composer.lock',
        content: '',
        action: 'update',
        description: `Updated ${composerPackages.join(', ')} for the extensions of Clever Cloud`,
        group: 'code',
        status: 'written',
      });
    } else {
      result.todo.push({
        id: 'php.composer-lock',
        severity: 'blocker',
        title: `Update composer.lock: composer update ${composerPackages.join(' ')} --no-install (neither composer nor Docker is available)`,
        location: 'composer.lock',
      });
    }
  }

  const targetGit = mode === 'branch' ? git : await getGitState(targetPath);
  if (targetGit.isRepository) {
    if (branchStatus === 'new') {
      // In a copy, the branch may already exist with other changes: use a free name instead of mixing them
      result.branch = mode === 'folder' ? await findFreeBranchName(targetPath, options.branch) : options.branch;
      await runGit(targetPath, ['checkout', '--quiet', '-b', result.branch]);
    } else {
      result.branch = options.branch;
    }
    for (const group of /** @type {const} */ (['config', 'code', 'setup'])) {
      const paths = result.changes
        .filter((change) => change.group === group && change.status === 'written')
        .map((change) => change.path);
      if (paths.length === 0) {
        continue;
      }
      await runGit(targetPath, ['add', '--', ...paths]);
      // Running apply again may produce the same files: no empty commit
      const hasChanges = await runGit(targetPath, ['diff', '--cached', '--quiet', '--', ...paths]).then(
        () => false,
        () => true,
      );
      if (!hasChanges) {
        continue;
      }
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
  // Untracked files (like a previous .env.clever) neither block a checkout nor end up in our commits
  const status = await runGit(directory, ['status', '--porcelain', '--untracked-files=no', '--', '.']);
  return { isRepository: true, isClean: status.trim() === '' };
}

/**
 * @param {string} directory
 * @param {string} branch
 * @returns {Promise<string>}
 */
async function findFreeBranchName(directory, branch) {
  let candidate = branch;
  for (let index = 2; await branchExists(directory, candidate); index++) {
    candidate = `${branch}-${index}`;
  }
  return candidate;
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

/**
 * Run `composer update <packages>` with a local Composer, or the official Docker image
 * @param {string} directory
 * @param {string[]} packages
 * @returns {Promise<boolean>}
 */
async function updateComposerLock(directory, packages) {
  const args = ['update', ...packages, '--no-install', '--no-scripts', '--no-plugins', '--no-interaction'];
  const attempts = [
    ['composer', args],
    [
      'docker',
      [
        'run',
        '--rm',
        ...(process.getuid != null ? ['-u', `${process.getuid()}:${process.getgid?.() ?? 0}`] : []),
        '-e',
        'COMPOSER_HOME=/tmp',
        '-v',
        `${directory}:/app`,
        '-w',
        '/app',
        'composer:2',
        'composer',
        ...args,
      ],
    ],
  ];
  for (const [command, commandArgs] of /** @type {Array<[string, string[]]>} */ (attempts)) {
    try {
      await execFileAsync(command, commandArgs, { cwd: directory, timeout: 600_000 });
      return true;
    } catch {
      // try the next way
    }
  }
  return false;
}
