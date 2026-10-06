import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { analyzeProject } from '../../src/models/migrate/analyze.js';
import { applyMigration, resolveMode } from '../../src/models/migrate/apply.js';
import { planMigrationFiles } from '../../src/models/migrate/migration-files.js';
import { ProjectScanner } from '../../src/models/migrate/project-scanner.js';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

/** @type {string[]} */
const temporaryDirectories = [];

/**
 * Copy a fixture in a temporary directory, optionally as a git repository
 * @param {string} fixture
 * @param {{ git?: boolean }} [options]
 * @returns {string}
 */
function copyFixture(fixture, { git = false } = {}) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'clever-apply-'));
  temporaryDirectories.push(parent);
  const directory = path.join(parent, 'shop');
  fs.cpSync(path.join(fixtures, fixture), directory, { recursive: true });
  if (git) {
    const run = (/** @type {string[]} */ ...args) => execFileSync('git', args, { cwd: directory, stdio: 'pipe' });
    run('init', '-q', '-b', 'main');
    run('config', 'user.email', 'test@example.com');
    run('config', 'user.name', 'Test');
    run('add', '-A');
    run('commit', '-q', '-m', 'initial');
  }
  return directory;
}

/**
 * @param {string} directory
 * @param {...string} args
 * @returns {string}
 */
function git(directory, ...args) {
  return execFileSync('git', args, { cwd: directory, encoding: 'utf8' });
}

/**
 * @param {string} fixture
 * @returns {Map<string, import('../../src/models/migrate/migration-files.js').PlannedChange>}
 */
function planFor(fixture) {
  const projectPath = path.join(fixtures, fixture);
  const { changes } = planMigrationFiles(new ProjectScanner(projectPath), analyzeProject(projectPath));
  return new Map(changes.map((change) => [change.path, change]));
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    fs.rmSync(/** @type {string} */ (temporaryDirectories.pop()), { recursive: true, force: true });
  }
});

describe('planMigrationFiles', () => {
  const changes = planFor('fastapi-compose');

  it('builds a production .env without compose hostnames nor dev values', () => {
    const envClever = changes.get('.env.clever')?.content ?? '';
    assert.match(envClever, /^ENVIRONMENT=production$/m);
    assert.doesNotMatch(envClever, /^DATABASE_URL=/m);
    assert.match(envClever, /# DATABASE_URL is computed by clever-setup.sh from POSTGRESQL_ADDON_URI/);
    assert.equal(changes.get('.env.clever')?.group, 'secrets');
  });

  it('ignores local secrets', () => {
    assert.match(changes.get('.gitignore')?.content ?? '', /^\.env\n\.env\.clever\n$/m);
  });

  it('writes a setup script rebuilding variables from add-ons', () => {
    const script = changes.get('clever-setup.sh')?.content ?? '';
    assert.ok(changes.get('clever-setup.sh')?.executable);
    assert.match(script, /^  clever create --type "\$EXPECTED_TYPE" "\$APP"$/m);
    assert.match(script, /^EXPECTED_TYPE=docker$/m);
    assert.match(script, /^  clever addon create postgresql-addon fastapi-compose-postgresql --link "\$APP"$/m);
    // The import replaces every variable, so it must come before the other ones
    assert.ok(
      script.indexOf('clever env import < .env.clever') <
        script.indexOf('clever env set CC_DOCKER_EXPOSED_HTTP_PORT 8000'),
    );
    assert.match(script, /DATABASE_URL_VALUE="\$\(addon_var fastapi-compose-postgresql POSTGRESQL_ADDON_URI\)"/);
    assert.match(
      script,
      /clever env set DATABASE_URL "postgresql\+psycopg:\/\/\$\{DATABASE_URL_VALUE#\*:\/\/\}" --alias "\$APP"/,
    );
  });

  it('creates a .dockerignore for Docker applications', () => {
    assert.match(changes.get('.dockerignore')?.content ?? '', /^\.env$/m);
    assert.match(changes.get('.dockerignore')?.content ?? '', /^\.venv$/m);
  });

  it('lists only remaining work as manual steps', () => {
    const guide = changes.get('CLEVER-MIGRATION.md')?.content ?? '';
    const section = (/** @type {string} */ title) => guide.split(`## ${title}`)[1]?.split('\n## ')[0] ?? '';
    const todo = section('To do manually');
    const done = section('Handled by the generated files');
    assert.doesNotMatch(todo, /Docker Compose is not supported/);
    assert.match(done, /\[x\] .*replaced by the PostgreSQL add-on/);
  });

  it('turns crontab and Procfile based projects into files and variables', () => {
    const dockerCompose = planFor('docker-compose-node');
    assert.deepEqual(JSON.parse(dockerCompose.get('clevercloud/cron.json')?.content ?? 'null'), [
      '*/10 * * * * node dist/cleanup.js',
    ]);
    const flask = planFor('flask-heroku').get('clever-setup.sh')?.content ?? '';
    assert.match(flask, /^clever env set CC_WORKER_COMMAND_0 'celery -A tasks worker' --alias "\$APP"$/m);
  });
});

describe('resolveMode', () => {
  it('prefers a branch only for clean git repositories', () => {
    assert.equal(resolveMode('auto', { isRepository: true, isClean: true }).mode, 'branch');
    assert.equal(resolveMode('auto', { isRepository: true, isClean: false }).mode, 'folder');
    assert.equal(resolveMode('auto', { isRepository: false, isClean: false }).mode, 'folder');
    assert.equal(resolveMode('folder', { isRepository: true, isClean: true }).mode, 'folder');
  });
});

describe('applyMigration', () => {
  const options = /** @type {const} */ ({ mode: 'auto', branch: 'clever-cloud-migration' });

  it('commits the generated files on a new branch, without the secrets', async () => {
    const directory = copyFixture('fastapi-compose', { git: true });
    const result = await applyMigration(directory, options);

    assert.equal(result.mode, 'branch');
    assert.equal(git(directory, 'branch', '--show-current').trim(), 'clever-cloud-migration');
    assert.deepEqual(git(directory, 'log', '--format=%s', '-2').trim().split('\n'), [
      'docs(clever): add Clever Cloud setup script and migration guide',
      'chore(clever): add Clever Cloud configuration files',
    ]);
    assert.equal(git(directory, 'status', '--porcelain'), '');
    assert.ok(fs.existsSync(path.join(directory, '.env.clever')));
    assert.equal(git(directory, 'ls-files', '.env.clever'), '');
    assert.equal(fs.statSync(path.join(directory, 'clever-setup.sh')).mode & 0o111, 0o111);
  });

  it('reuses an existing branch instead of failing', async () => {
    const directory = copyFixture('fastapi-compose', { git: true });
    const first = await applyMigration(directory, options);
    assert.equal(first.branchStatus, 'new');

    // Running again on the same branch only refreshes the guide (fewer things left to do)...
    const again = await applyMigration(directory, options);
    assert.equal(again.branchStatus, 'current');
    assert.deepEqual(again.commits, ['docs(clever): add Clever Cloud setup script and migration guide']);
    // ...and once up to date, no empty commit
    const unchanged = await applyMigration(directory, options);
    assert.deepEqual(unchanged.commits, []);

    // From another branch: switch to the existing one and add the new changes on top
    git(directory, 'checkout', '-q', 'main');
    fs.appendFileSync(path.join(directory, 'crontab'), '0 * * * * python -m app.cleanup\n');
    git(directory, 'add', 'crontab');
    git(directory, 'commit', '-q', '-m', 'add crontab');
    git(directory, 'checkout', '-q', 'clever-cloud-migration');
    git(directory, 'merge', '-q', 'main', '-m', 'merge main');
    git(directory, 'checkout', '-q', 'main');
    const switched = await applyMigration(directory, options);
    assert.equal(switched.branchStatus, 'switched');
    assert.equal(git(directory, 'branch', '--show-current').trim(), 'clever-cloud-migration');
    assert.ok(fs.existsSync(path.join(directory, 'clevercloud/cron.json')));
    assert.equal(git(directory, 'status', '--porcelain'), '');
  });

  it('uses a free branch name in a copy', async () => {
    const directory = copyFixture('fastapi-compose', { git: true });
    git(directory, 'branch', 'clever-cloud-migration');
    fs.appendFileSync(path.join(directory, 'app/main.py'), '# work in progress\n');
    const result = await applyMigration(directory, options);
    assert.equal(result.mode, 'folder');
    assert.equal(result.branch, 'clever-cloud-migration-2');
  });

  it('works on a copy when the repository has uncommitted changes', async () => {
    const directory = copyFixture('fastapi-compose', { git: true });
    fs.appendFileSync(path.join(directory, 'app/main.py'), '# work in progress\n');
    await assert.rejects(applyMigration(directory, { ...options, mode: 'branch' }), /uncommitted changes/);

    const result = await applyMigration(directory, options);
    assert.equal(result.mode, 'folder');
    assert.equal(result.targetPath, `${directory}-clever`);
    // The original project is untouched
    assert.equal(git(directory, 'branch', '--show-current').trim(), 'main');
    assert.ok(!fs.existsSync(path.join(directory, 'clever-setup.sh')));
    // The work in progress is kept in the copy but not committed
    assert.equal(git(result.targetPath, 'status', '--porcelain').trim(), 'M app/main.py');
  });

  it('copies a project without git, skipping dependencies', async () => {
    const directory = copyFixture('vite-spa');
    fs.mkdirSync(path.join(directory, 'node_modules/vite'), { recursive: true });
    const output = path.join(path.dirname(directory), 'migrated');
    const result = await applyMigration(directory, { ...options, output });

    assert.equal(result.mode, 'folder');
    assert.equal(result.branch, null);
    assert.ok(fs.existsSync(path.join(output, 'clever-setup.sh')));
    assert.ok(fs.existsSync(path.join(output, 'index.html')));
    assert.ok(!fs.existsSync(path.join(output, 'node_modules')));
    await assert.rejects(applyMigration(directory, { ...options, output }), /already exists/);
  });

  it('never overwrites user files', async () => {
    const directory = copyFixture('vite-spa');
    fs.writeFileSync(path.join(directory, 'CLEVER-MIGRATION.md'), 'my notes\n');
    const output = path.join(path.dirname(directory), 'migrated');
    const result = await applyMigration(directory, { ...options, output });
    assert.equal(result.changes.find((change) => change.path === 'CLEVER-MIGRATION.md')?.status, 'skipped');
    assert.equal(fs.readFileSync(path.join(output, 'CLEVER-MIGRATION.md'), 'utf8'), 'my notes\n');
  });

  it('writes nothing in dry run mode', async () => {
    const directory = copyFixture('fastapi-compose', { git: true });
    const result = await applyMigration(directory, { ...options, dryRun: true });
    assert.equal(result.mode, 'branch');
    assert.equal(git(directory, 'branch', '--show-current').trim(), 'main');
    assert.ok(!fs.existsSync(path.join(directory, 'clever-setup.sh')));
  });
});
