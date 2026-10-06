import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { analyzeProject } from '../../src/models/migrate/analyze.js';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

/**
 * @param {import('../../src/models/migrate/report.js').MigrationReport} report
 * @param {string} id
 */
function severityOf(report, id) {
  return report.findings.find((finding) => finding.id === id)?.severity;
}

describe('analyzeProject', () => {
  describe('dockerized Node.js application with docker-compose', () => {
    const report = analyzeProject(path.join(fixtures, 'docker-compose-node'));

    it('keeps the Docker runtime and suggests the native one', () => {
      assert.equal(report.runtime.type, 'docker');
      assert.deepEqual(report.runtime.alternatives, ['node']);
      assert.equal(severityOf(report, 'runtime.native-alternative'), 'info');
    });

    it('maps the exposed port', () => {
      assert.equal(severityOf(report, 'docker.http-port'), 'blocker');
      assert.equal(report.env.CC_DOCKER_EXPOSED_HTTP_PORT.value, '3000');
    });

    it('replaces databases with add-ons and drops infrastructure services', () => {
      assert.deepEqual(
        report.addons.map((addon) => [addon.provider, addon.fromService]),
        [
          ['postgresql-addon', 'db'],
          ['redis-addon', 'cache'],
        ],
      );
      const titles = report.findings.map((finding) => finding.title).join('\n');
      assert.match(titles, /"proxy".*not needed/);
      assert.match(titles, /"adminer".*not needed/);
      assert.match(titles, /"mq".*no managed equivalent/);
    });

    it('detects hostnames of docker-compose services', () => {
      const finding = report.findings.find((f) => f.id === 'compose.service-hostnames');
      assert.match(finding?.details ?? '', /DATABASE_URL=.* → use POSTGRESQL_ADDON_URI/);
      assert.match(finding?.details ?? '', /REDIS_HOST=cache → already injected/);
    });

    it('only copies safe literal variables', () => {
      assert.equal(report.env.LOG_LEVEL.value, 'info');
      assert.equal(report.env.JWT_SECRET, undefined);
      assert.equal(report.env.DATABASE_URL, undefined);
    });

    it('plans the worker as an application linked to the same add-ons', () => {
      assert.equal(report.extraApps.length, 1);
      assert.equal(report.extraApps[0].name, 'docker-compose-node-worker');
      assert.ok(
        report.commands.includes(
          'clever service link-addon docker-compose-node-postgresql --alias docker-compose-node-worker',
        ),
      );
    });

    it('warns about non persistent storage, .env and cron', () => {
      assert.equal(severityOf(report, 'docker.volume'), 'warning');
      assert.equal(severityOf(report, 'env.dotenv'), 'warning');
      assert.equal(severityOf(report, 'env.dotenv-committed'), 'warning');
      assert.deepEqual(JSON.parse(report.files[0].content), ['*/10 * * * * node dist/cleanup.js']);
    });

    it('produces an ordered command plan', () => {
      const commands = report.commands;
      assert.equal(commands[0], 'clever create --type docker docker-compose-node');
      assert.equal(commands.at(-1), 'clever deploy');
      assert.ok(commands.indexOf('clever env import < .env') > 0);
    });
  });

  it('detects node build requirements when the native runtime is forced', () => {
    const report = analyzeProject(path.join(fixtures, 'docker-compose-node'), { type: 'node' });
    assert.equal(report.env.CC_POST_BUILD_HOOK.value, 'npm run build');
    assert.equal(report.env.CC_NODE_DEV_DEPENDENCIES.value, 'install');
    assert.equal(report.env.CC_WORKER_COMMAND.value, 'node dist/worker.js');
    assert.equal(severityOf(report, 'code.hardcoded-port'), 'blocker');
    assert.equal(severityOf(report, 'code.localhost-service'), 'warning');
  });

  it('configures Symfony', () => {
    const report = analyzeProject(path.join(fixtures, 'symfony'));
    assert.equal(report.runtime.type, 'php');
    assert.equal(report.env.CC_WEBROOT.value, '/public');
    assert.equal(report.env.CC_PHP_VERSION.value, '8.2');
    assert.match(report.env.CC_PRE_RUN_HOOK.value, /doctrine:migrations:migrate/);
  });

  it('translates a Heroku Flask application', () => {
    const report = analyzeProject(path.join(fixtures, 'flask-heroku'));
    assert.equal(report.runtime.type, 'python');
    assert.equal(report.env.CC_PYTHON_MODULE.value, 'app:app');
    assert.equal(report.env.CC_PYTHON_VERSION.value, '3.12');
    assert.equal(report.env.CC_PRE_RUN_HOOK.value, 'flask db upgrade');
    assert.equal(report.env.CC_WORKER_COMMAND_0.value, 'celery -A tasks worker');
    assert.equal(report.env.CC_RUN_COMMAND, undefined);
    assert.equal(severityOf(report, 'storage.sqlite'), 'blocker');
    // app.run() is a development server, not used with CC_PYTHON_MODULE
    assert.equal(severityOf(report, 'code.hardcoded-port'), undefined);
  });

  it('builds a Vite single page application with the static runtime', () => {
    const report = analyzeProject(path.join(fixtures, 'vite-spa'));
    assert.equal(report.runtime.type, 'static');
    assert.equal(report.env.CC_BUILD_COMMAND.value, 'npm ci && npm run build');
    assert.equal(report.env.CC_WEBROOT.value, '/dist');
    assert.equal(severityOf(report, 'static.spa-fallback'), 'warning');
  });

  it('finds the Go main package and loopback binding', () => {
    const report = analyzeProject(path.join(fixtures, 'go-cmd'));
    assert.equal(report.runtime.type, 'go');
    assert.equal(report.env.CC_GO_PKG.value, 'example.com/api/cmd/server');
    assert.equal(severityOf(report, 'code.loopback-binding'), 'blocker');
    assert.equal(severityOf(report, 'code.hardcoded-port'), 'blocker');
  });

  it('reports missing git repository and unknown runtime', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'clever-migrate-'));
    try {
      fs.writeFileSync(path.join(directory, 'README.md'), '# hello');
      const report = analyzeProject(directory);
      assert.equal(severityOf(report, 'git.missing'), 'blocker');
      assert.equal(severityOf(report, 'runtime.unknown'), 'blocker');
      assert.equal(report.runtime.type, null);
      assert.deepEqual(report.commands, []);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('serializes to JSON', () => {
    const json = analyzeProject(path.join(fixtures, 'symfony')).toJSON();
    assert.equal(json.findings[0].severity, 'blocker');
    assert.equal(json.plan.env.CC_WEBROOT, '/public');
    assert.ok(json.score < 100);
  });
});
