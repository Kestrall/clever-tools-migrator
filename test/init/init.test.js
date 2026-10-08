import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import {
  checkCanScaffold,
  checkCurrentDirectoryIsEmpty,
  checkProjectDirectory,
  getStarterTemplate,
  scaffoldProject,
} from '../../src/models/init/scaffold.js';
import { STARTER_TEMPLATES, listStarterRuntimes } from '../../src/models/init/templates.js';
import { analyzeProject } from '../../src/models/migrate/analyze.js';

/** @type {string[]} */
const temporaryDirectories = [];

/**
 * @param {{ git?: boolean }} [options]
 * @returns {string}
 */
function emptyDirectory({ git = false } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'clever-init-'));
  temporaryDirectories.push(directory);
  if (git) {
    gitIn(directory, 'init', '-q', '-b', 'main');
  }
  return directory;
}

/**
 * @param {string} directory
 * @param {...string} args
 * @returns {string}
 */
function gitIn(directory, ...args) {
  return execFileSync('git', args, { cwd: directory, stdio: 'pipe', encoding: 'utf8' });
}

const GIT_IDENTITY = {
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
};

/**
 * Give the git commands run by scaffoldProject an identity, independently of the machine configuration
 * @returns {() => void} restore the environment
 */
function withGitIdentity() {
  const previous = Object.fromEntries(Object.keys(GIT_IDENTITY).map((key) => [key, process.env[key]]));
  Object.assign(process.env, GIT_IDENTITY);
  return () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value == null) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('clever init templates', () => {
  it('covers docker, node, python, php, go, static, ruby and rust with existing instance types', () => {
    assert.deepEqual(listStarterRuntimes(), ['docker', 'node', 'python', 'php', 'go', 'static', 'ruby', 'rust']);
  });

  it('rejects an unknown runtime', () => {
    assert.throws(
      () => getStarterTemplate('cobol'),
      /available runtimes: docker, node, python, php, go, static, ruby, rust/,
    );
  });

  it('escapes the application name in the generated sources', () => {
    const name = '<b>`${process.exit()}`"""\\';
    for (const runtime of listStarterRuntimes()) {
      const files = STARTER_TEMPLATES[runtime].files(name);
      const sources = Object.entries(files)
        .filter(([file]) => !file.endsWith('.md') && file !== 'package.json')
        .map(([, content]) => content)
        .join('\n');
      assert.ok(!sources.includes(name), `${runtime} embeds the raw name`);
      assert.ok(!sources.includes('<b>'), `${runtime} embeds raw HTML`);
    }
  });

  it('generates a valid package.json name', () => {
    const packageJson = JSON.parse(STARTER_TEMPLATES.node.files('My App!')['package.json']);
    assert.equal(packageJson.name, 'my-app');
    assert.equal(packageJson.scripts.start, 'node server.js');
  });

  for (const runtime of listStarterRuntimes()) {
    it(`${runtime} starter has no blocker for clever migrate once created`, async () => {
      const directory = emptyDirectory();
      const restore = withGitIdentity();
      try {
        await scaffoldProject(directory, runtime, 'demo');
      } finally {
        restore();
      }
      const { env } = STARTER_TEMPLATES[runtime];
      // State right after `clever init`: the application exists with the variables of the template
      const remote = { appAlias: 'demo', addons: [], appType: runtime, env };
      const report = analyzeProject(directory, { appName: 'demo', remote });
      assert.equal(report.runtime.type, runtime);
      assert.deepEqual(
        report.findings.filter((finding) => finding.severity === 'blocker').map((finding) => finding.title),
        [],
      );
    });
  }
});

describe('clever init scaffold', () => {
  it('writes the files, initializes git and commits them', async () => {
    const directory = emptyDirectory();
    const restore = withGitIdentity();
    try {
      const result = await scaffoldProject(directory, 'node', 'demo');
      assert.equal(result.repository, 'created');
      assert.match(result.commit ?? '', /^[0-9a-f]{40}$/);
      assert.deepEqual(result.files.sort(), ['.gitignore', 'README.md', 'package.json', 'server.js']);
      assert.equal(gitIn(directory, 'status', '--porcelain'), '');
    } finally {
      restore();
    }
  });

  it('only commits its own files in an existing repository', async () => {
    const directory = emptyDirectory({ git: true });
    fs.writeFileSync(path.join(directory, 'notes.txt'), 'draft');
    const restore = withGitIdentity();
    try {
      const result = await scaffoldProject(directory, 'php', 'demo');
      assert.equal(result.repository, 'existing');
      assert.equal(gitIn(directory, 'status', '--porcelain').trim(), '?? notes.txt');
    } finally {
      restore();
    }
  });

  it('refuses to overwrite existing files', async () => {
    const directory = emptyDirectory();
    fs.writeFileSync(path.join(directory, 'Dockerfile'), 'FROM scratch\n');
    await assert.rejects(checkCanScaffold(directory, 'docker', 'demo'), /Dockerfile already exists/);
    assert.equal(fs.readFileSync(path.join(directory, 'Dockerfile'), 'utf8'), 'FROM scratch\n');
  });

  it('refuses a sub-directory of another git repository', async () => {
    const repository = emptyDirectory({ git: true });
    const directory = path.join(repository, 'app');
    fs.mkdirSync(directory);
    await assert.rejects(checkCanScaffold(directory, 'python', 'demo'), /inside the git repository/);
  });

  it('generates the project in a new directory named after the application', async () => {
    const parent = emptyDirectory();
    const directory = await checkProjectDirectory(parent, 'monapp');
    assert.equal(directory, path.join(parent, 'monapp'));
    assert.equal(fs.existsSync(directory), false);
    const restore = withGitIdentity();
    try {
      const result = await scaffoldProject(directory, 'docker', 'monapp');
      assert.match(result.commit ?? '', /^[0-9a-f]{40}$/);
    } finally {
      restore();
    }
    assert.ok(fs.existsSync(path.join(directory, 'Dockerfile')));
    assert.ok(fs.existsSync(path.join(directory, '.git')));
    assert.deepEqual(fs.readdirSync(parent), ['monapp']);
  });

  it('accepts an existing empty directory and refuses a non-empty one', async () => {
    const parent = emptyDirectory();
    fs.mkdirSync(path.join(parent, 'empty'));
    fs.mkdirSync(path.join(parent, 'used'));
    fs.writeFileSync(path.join(parent, 'used', 'notes.txt'), 'draft');
    fs.writeFileSync(path.join(parent, 'file'), 'draft');
    assert.equal(await checkProjectDirectory(parent, 'empty'), path.join(parent, 'empty'));
    await assert.rejects(checkProjectDirectory(parent, 'used'), /already exists and is not empty/);
    await assert.rejects(checkProjectDirectory(parent, 'file'), /is not a directory/);
  });

  it('refuses names that are not a single directory', async () => {
    const parent = emptyDirectory();
    for (const name of ['.', '..', 'a/b', '../evil', ' padded']) {
      await assert.rejects(checkProjectDirectory(parent, name), /cannot be used as a directory name/, name);
    }
  });

  it('refuses a new directory inside another git repository', async () => {
    const repository = emptyDirectory({ git: true });
    const directory = await checkProjectDirectory(repository, 'monapp');
    await assert.rejects(checkCanScaffold(directory, 'node', 'monapp'), /inside the git repository/);
    assert.equal(fs.existsSync(directory), false);
  });

  it('refuses to write in a current directory that holds other files', async () => {
    const directory = emptyDirectory();
    for (const project of ['Bloggy', 'kliicc', 'notes.txt', 'sentinelhub']) {
      fs.mkdirSync(path.join(directory, project));
    }
    await assert.rejects(
      checkCurrentDirectoryIsEmpty(directory),
      /is not empty \(Bloggy, kliicc, notes\.txt, \.\.\. \(4 entries\)\): run `clever init <runtime> <app-name>`/,
    );
  });

  it('accepts a current directory with only an empty git repository and editor settings', async () => {
    const directory = emptyDirectory({ git: true });
    fs.mkdirSync(path.join(directory, '.vscode'));
    await checkCurrentDirectoryIsEmpty(directory);
  });
});
