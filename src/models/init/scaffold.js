import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { STARTER_TEMPLATES, listStarterRuntimes } from './templates.js';

const execFileAsync = promisify(execFile);

const GIT_MISSING = 'git is required by `clever init`';
const INITIAL_COMMIT_MESSAGE = 'chore: initialize project with clever init';

/**
 * @typedef {object} ScaffoldResult
 * @property {string[]} files files written, relative to the directory
 * @property {'created'|'existing'} repository whether `git init` was run
 * @property {string|null} commit hash of the commit holding the files, null if it could not be created
 * @property {string|null} commitError why the commit failed (missing git identity, ...)
 */

/**
 * @param {string} runtime
 * @returns {import('./templates.js').StarterTemplate}
 */
export function getStarterTemplate(runtime) {
  const template = STARTER_TEMPLATES[runtime];
  if (template == null) {
    throw new Error(`No starter project for "${runtime}", available runtimes: ${listStarterRuntimes().join(', ')}`);
  }
  return template;
}

/**
 * Check that the starter project can be written in the directory, without touching anything
 * @param {string} directory
 * @param {string} runtime
 * @param {string} name
 * @returns {Promise<void>}
 */
export async function checkCanScaffold(directory, runtime, name) {
  const files = Object.keys(getStarterTemplate(runtime).files(name));
  const existing = [];
  for (const file of files) {
    if (await exists(path.join(directory, file))) {
      existing.push(file);
    }
  }
  if (existing.length > 0) {
    throw new Error(
      `${existing.join(', ')} already exist${existing.length === 1 ? 's' : ''} in ${directory}, run \`clever init\` in an empty directory (or \`clever migrate\` for an existing project)`,
    );
  }

  // A directory still to create is checked through its parent
  const directoryExists = await exists(directory);
  const topLevel = await getGitTopLevel(directoryExists ? directory : path.dirname(directory));
  if (topLevel != null && (!directoryExists || path.resolve(topLevel) !== path.resolve(directory))) {
    throw new Error(
      `${directory} is inside the git repository ${topLevel}: Clever Cloud deploys the root of a repository, run \`clever init\` in a directory of its own`,
    );
  }
}

/** Entries that do not make a directory a project: editor settings, an empty `git init` */
const IGNORED_ENTRIES = new Set(['.git', '.DS_Store', '.idea', '.vscode']);

/**
 * Without an application name, the project is written in the current directory: it must not hold anything else
 * (running `clever init` from a folder of projects would mix the starter with them)
 * @param {string} directory
 * @returns {Promise<void>}
 */
export async function checkCurrentDirectoryIsEmpty(directory) {
  const entries = (await fs.readdir(directory)).filter((entry) => !IGNORED_ENTRIES.has(entry)).sort();
  if (entries.length > 0) {
    const shown = entries.slice(0, 3).join(', ') + (entries.length > 3 ? `, ... (${entries.length} entries)` : '');
    throw new Error(
      `${directory} is not empty (${shown}): run \`clever init <runtime> <app-name>\` to generate the project in a new directory, or \`clever migrate\` to deploy an existing project`,
    );
  }
}

/**
 * Check the name of the project directory created by `clever init <runtime> <app-name>`
 * @param {string} parent
 * @param {string} name
 * @returns {Promise<string>} absolute path of the project directory
 */
export async function checkProjectDirectory(parent, name) {
  if (name === '.' || name === '..' || /[/\\]/.test(name) || name.trim() !== name) {
    throw new Error(`"${name}" cannot be used as a directory name, choose an application name without slashes`);
  }
  const directory = path.join(parent, name);
  const entries = await fs.readdir(directory).catch((error) => {
    if (error.code === 'ENOENT') {
      return [];
    }
    if (error.code === 'ENOTDIR') {
      throw new Error(`${directory} already exists and is not a directory`);
    }
    throw error;
  });
  if (entries.length > 0) {
    throw new Error(`${directory} already exists and is not empty, choose another application name`);
  }
  return directory;
}

/**
 * Write the starter project and commit it, initializing the git repository if needed
 * @param {string} directory
 * @param {string} runtime
 * @param {string} name
 * @param {import('./templates.js').StarterAddon[]} [addons] add-ons described in the welcome page and the README
 * @returns {Promise<ScaffoldResult>}
 */
export async function scaffoldProject(directory, runtime, name, addons = []) {
  await checkCanScaffold(directory, runtime, name);
  const files = getStarterTemplate(runtime).files(name, addons);
  await fs.mkdir(directory, { recursive: true });

  for (const [file, content] of Object.entries(files)) {
    const target = path.join(directory, file);
    await fs.mkdir(path.dirname(target), { recursive: true });
    // wx: never overwrite a file created in the meantime
    await fs.writeFile(target, content, { flag: 'wx' });
  }

  const isRepository = (await getGitTopLevel(directory)) != null;
  if (!isRepository) {
    await runGit(directory, ['init', '-q', '-b', 'main']);
  }

  const fileList = Object.keys(files);
  try {
    await runGit(directory, ['add', '--', ...fileList]);
    await runGit(directory, ['commit', '-q', '-m', INITIAL_COMMIT_MESSAGE, '--', ...fileList]);
    const commit = (await runGit(directory, ['rev-parse', 'HEAD'])).trim();
    return { files: fileList, repository: isRepository ? 'existing' : 'created', commit, commitError: null };
  } catch (error) {
    const commitError = String(error.stderr || error.message)
      .trim()
      .split('\n')
      .filter((line) => line.trim() !== '')
      .at(-1);
    return { files: fileList, repository: isRepository ? 'existing' : 'created', commit: null, commitError };
  }
}

/**
 * @param {string} directory
 * @returns {Promise<string|null>}
 */
async function getGitTopLevel(directory) {
  try {
    return (await runGit(directory, ['rev-parse', '--show-toplevel'])).trim();
  } catch (error) {
    if (error.message === GIT_MISSING) {
      throw error;
    }
    return null;
  }
}

/**
 * @param {string} file
 * @returns {Promise<boolean>}
 */
async function exists(file) {
  return fs.lstat(file).then(
    () => true,
    () => false,
  );
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
      throw new Error(GIT_MISSING);
    }
    throw error;
  }
}
