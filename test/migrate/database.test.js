import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { analyzeProject } from '../../src/models/migrate/analyze.js';
import { planMigrationFiles } from '../../src/models/migrate/migration-files.js';
import { ProjectScanner } from '../../src/models/migrate/project-scanner.js';
import { collectDependencies } from '../../src/models/migrate/rules/database.js';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

/** @type {string[]} */
const temporaryDirectories = [];

/**
 * @param {Record<string, string>} files
 * @returns {string}
 */
function createProject(files) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'clever-db-'));
  temporaryDirectories.push(directory);
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
    fs.writeFileSync(path.join(directory, file), content);
  }
  return directory;
}

/**
 * @param {string} projectPath
 * @returns {{ report: import('../../src/models/migrate/report.js').MigrationReport, files: Map<string, import('../../src/models/migrate/migration-files.js').PlannedChange>, plan: ReturnType<typeof planMigrationFiles> }}
 */
function plan(projectPath) {
  const report = analyzeProject(projectPath);
  const result = planMigrationFiles(new ProjectScanner(projectPath), report);
  return { report, plan: result, files: new Map(result.changes.map((change) => [change.path, change])) };
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    fs.rmSync(/** @type {string} */ (temporaryDirectories.pop()), { recursive: true, force: true });
  }
});

describe('database detection', () => {
  it('reads dependencies of every ecosystem', () => {
    const directory = createProject({
      'requirements.txt': 'Django==5.1\npsycopg[binary]==3.2\n# redis\n',
      'go.mod': 'module example.com/app\n\nrequire (\n\tgithub.com/jackc/pgx/v5 v5.7.1\n)\n',
      Gemfile: "source 'https://rubygems.org'\ngem 'mysql2', '~> 0.5'\n",
      'pom.xml':
        '<project><dependency><groupId>org.postgresql</groupId><artifactId>postgresql</artifactId></dependency></project>',
    });
    const dependencies = collectDependencies(new ProjectScanner(directory));
    for (const name of ['psycopg', 'django', 'github.com/jackc/pgx', 'mysql2', 'org.postgresql']) {
      assert.ok(dependencies.has(name), name);
    }
    assert.ok(!dependencies.has('redis'));
  });

  it('keeps a database already hosted outside', () => {
    const directory = createProject({
      'package.json': JSON.stringify({ scripts: { start: 'node index.js' }, dependencies: { pg: '^8' } }),
      'index.js': 'require("pg");\n',
      '.env': 'DATABASE_URL=postgres://user:pass@ep-cool-name.eu-central-1.aws.neon.tech/app\n',
    });
    const { report } = plan(directory);
    assert.deepEqual(report.addons, []);
    assert.equal(report.findings.find((finding) => finding.id === 'database.external')?.severity, 'info');
  });
});

describe('hard-coded PHP credentials', () => {
  const { report, files, plan: result } = plan(path.join(fixtures, 'php-pdo'));

  it('plans a MySQL add-on', () => {
    assert.deepEqual(
      report.addons.map((addon) => addon.provider),
      ['mysql-addon'],
    );
    assert.ok(!report.findings.some((finding) => finding.id === 'code.loopback-binding'));
  });

  it('reads the add-on variables with the current values as fallback', () => {
    const config = files.get('config.php')?.content ?? '';
    assert.match(config, /^\$host = getenv\('MYSQL_ADDON_HOST'\) \?: 'localhost';/m);
    assert.match(config, /^\$port = getenv\('MYSQL_ADDON_PORT'\) \?: '3306';$/m);
    assert.match(config, /^\$dbname = getenv\('MYSQL_ADDON_DB'\) \?: 'url_shortener';/m);
    assert.match(config, /^\$username = getenv\('MYSQL_ADDON_USER'\) \?: 'root';/m);
    assert.match(config, /^\$password = getenv\('MYSQL_ADDON_PASSWORD'\) \?: 'local-secret';/m);
    assert.match(config, /new PDO\("mysql:host=\$host;port=\$port;dbname=\$dbname"/);
    assert.equal(files.get('config.php')?.group, 'code');
    assert.ok(!result.todo.some((finding) => finding.id === 'database.hardcoded-credentials'));
  });

  it('copies the data without storing any password', () => {
    const script = files.get('clever-migrate-data.sh')?.content ?? '';
    assert.match(script, /LOCAL_MYSQL_DB="\$\{LOCAL_MYSQL_DB:-url_shortener\}"/);
    assert.match(script, /LOCAL_MYSQL_HOST="\$\{LOCAL_MYSQL_HOST:-127\.0\.0\.1\}"/);
    assert.match(script, /client mysql mysql:8\.4 -h "\$ADDON_HOST" -P "\$ADDON_PORT"/);
    assert.doesNotMatch(script, /local-secret/);
    assert.ok(files.get('clever-migrate-data.sh')?.executable);
  });
});

describe('projects already migrated', () => {
  it('finds the local database behind getenv() fallbacks and reuses the linked application', () => {
    const directory = createProject({
      '.clever.json': JSON.stringify({ apps: [{ app_id: 'app_1', alias: 'shop', name: 'shop' }] }),
      'index.php': '<?php require "config.php";\n',
      'config.php':
        "<?php\n$host = getenv('MYSQL_ADDON_HOST') ?: 'localhost';\n$dbname = getenv('MYSQL_ADDON_DB') ?: 'shop_local';\n$pdo = new PDO(\"mysql:host=$host;dbname=$dbname\", 'root', '');\n",
    });
    const { report, files } = plan(directory);
    assert.equal(report.appName, 'shop');
    assert.ok(!report.findings.some((finding) => finding.id === 'database.hardcoded-credentials'));
    assert.match(
      files.get('clever-migrate-data.sh')?.content ?? '',
      /LOCAL_MYSQL_DB="\$\{LOCAL_MYSQL_DB:-shop_local\}"/,
    );
    const setup = files.get('clever-setup.sh')?.content ?? '';
    assert.match(setup, /^APP=shop$/m);
    assert.match(setup, /^if addon_exists shop-mysql; then$/m);
  });
});

describe('existing add-ons on Clever Cloud', () => {
  const files = {
    '.clever.json': JSON.stringify({ apps: [{ app_id: 'app_1', org_id: 'user_1', alias: 'shop', name: 'shop' }] }),
    'index.php': '<?php\n$pdo = new PDO("mysql:host=$host;dbname=$db", $user, $pass);\n',
  };

  it('does not ask to create an add-on already linked', () => {
    const directory = createProject(files);
    const report = analyzeProject(directory, {
      remote: { appAlias: 'shop', addons: [{ name: 'shop-db', provider: 'mysql-addon', isLinked: true }] },
    });
    assert.ok(!report.findings.some((finding) => finding.id === 'database.addon'));
    assert.equal(report.findings.find((finding) => finding.id === 'database.import-data')?.severity, 'info');
    assert.equal(report.addons[0].name, 'shop-db');
    assert.ok(!report.commands.some((command) => /clever (create|addon create)/.test(command)));
    // Only the missing git repository of the temporary project remains
    assert.deepEqual(
      report.findings.filter((finding) => finding.severity === 'blocker').map((finding) => finding.id),
      ['git.missing'],
    );
  });

  it('asks to link an existing add-on', () => {
    const directory = createProject(files);
    const report = analyzeProject(directory, {
      remote: { appAlias: 'shop', addons: [{ name: 'shop-mysql', provider: 'mysql-addon', isLinked: false }] },
    });
    assert.equal(report.findings.find((finding) => finding.id === 'remote.addon-unlinked')?.severity, 'warning');
    assert.ok(report.commands.includes('clever service link-addon shop-mysql --alias shop'));
  });
});

describe('state of the application on Clever Cloud', () => {
  const files = {
    '.clever.json': JSON.stringify({ apps: [{ app_id: 'app_1', org_id: 'user_1', alias: 'shop', name: 'shop' }] }),
    'composer.json': JSON.stringify({ require: { php: '>=8.4', 'symfony/framework-bundle': '8.1.*' } }),
    'symfony.lock': '{}',
    'public/index.php': '<?php\n',
    '.env': 'APP_ENV=dev\nAPP_SECRET=dev\nDATABASE_URL="mysql://app:app@127.0.0.1:3306/app"\n',
  };

  it('only reports what is not done yet on the application', () => {
    const directory = createProject({ ...files, 'public/.htaccess': 'RewriteEngine On\n' });
    const report = analyzeProject(directory, {
      remote: {
        appAlias: 'shop',
        appType: 'php',
        addons: [{ name: 'shop-mysql', provider: 'mysql-addon', isLinked: true }],
        env: {
          CC_WEBROOT: '/public',
          CC_PHP_VERSION: '8.4',
          APP_ENV: 'prod',
          APP_SECRET: 'generated',
          DATABASE_URL: 'mysql://u:p@bxyz-mysql.services.clever-cloud.com:3306/bxyz',
        },
      },
    });
    const left = report.findings.filter((finding) => finding.severity !== 'info').map((finding) => finding.id);
    assert.deepEqual(left, ['git.missing']);
    assert.equal(report.env.CC_WEBROOT, undefined);
  });

  it('reports an application of the wrong type', () => {
    const directory = createProject(files);
    const report = analyzeProject(directory, {
      remote: { appAlias: 'shop', appType: 'docker', addons: [], env: { CC_WEBROOT: '/public' } },
    });
    assert.equal(report.findings.find((finding) => finding.id === 'remote.app-type')?.severity, 'blocker');
    // The new application will need the configuration again
    assert.equal(report.env.CC_WEBROOT?.value, '/public');
  });

  it('creates a new application in the setup script when the type does not match', () => {
    const script = plan(createProject(files)).files.get('clever-setup.sh')?.content ?? '';
    assert.match(script, /^EXPECTED_TYPE=php$/m);
    assert.match(script, /^ {4}APP="\$APP-\$EXPECTED_TYPE"$/m);
    assert.match(script, /^ {4}clever unlink "\$OLD_APP"$/m);
    // The old application is never deleted by the script
    assert.doesNotMatch(script, /^\s*clever delete/m);
  });

  it('adds Apache rewrite rules and trusts the proxy for Symfony', () => {
    const { files: generated, plan: result, report } = plan(createProject(files));
    const htaccess = generated.get('public/.htaccess');
    assert.equal(htaccess?.group, 'code');
    assert.match(htaccess?.content ?? '', /^ {4}RewriteRule \^ index\.php \[L\]$/m);
    assert.match(htaccess?.content ?? '', /RewriteRule \^index\\\.php/);
    assert.ok(!result.todo.some((finding) => finding.id === 'php.front-controller'));
    assert.equal(report.env.SYMFONY_TRUSTED_PROXIES?.value, 'REMOTE_ADDR');
  });

  it('recreates an application deleted from Clever Cloud', () => {
    const directory = createProject({ ...files, 'public/.htaccess': 'RewriteEngine On\n' });
    const report = analyzeProject(directory, { missingApp: 'shop' });
    assert.equal(report.findings.find((finding) => finding.id === 'remote.app-missing')?.severity, 'warning');
    assert.ok(report.commands.includes('clever create --type php shop'));
    const script = plan(directory).files.get('clever-setup.sh')?.content ?? '';
    assert.match(script, /^ {4}clever unlink "\$APP" >\/dev\/null 2>&1 \|\| true$/m);
    assert.match(script, /^if \[ "\$LINKED" = yes \]; then$/m);
  });

  it('generates framework secrets and keeps them between runs', () => {
    const directory = createProject(files);
    const first = plan(directory).files.get('.env.clever')?.content ?? '';
    const secret = /^APP_SECRET=(\w{64})$/m.exec(first)?.[1];
    assert.ok(secret != null && secret !== 'dev');
    fs.writeFileSync(path.join(directory, '.env.clever'), first);
    assert.match(plan(directory).files.get('.env.clever')?.content ?? '', new RegExp(`^APP_SECRET=${secret}$`, 'm'));
  });

  it('sets public URLs from the domain of the application', () => {
    const directory = createProject({ ...files, '.env.example': 'DEFAULT_URI=http://localhost:8000/app\n' });
    const { files: generated, plan: result } = plan(directory);
    assert.match(
      generated.get('clever-setup.sh')?.content ?? '',
      /^clever env set DEFAULT_URI "\$APP_URL\/app" --alias "\$APP"$/m,
    );
    assert.ok(!result.todo.some((finding) => /DEFAULT_URI/.test(finding.title)));
  });
});

describe('PHP extensions of Clever Cloud', () => {
  it('pins the composer platform and aligns the local Docker image', () => {
    const directory = createProject({
      'composer.json': JSON.stringify({ require: { php: '>=8.4', 'doctrine/mongodb-odm-bundle': '^5.6' } }, null, 4),
      'composer.lock': JSON.stringify({
        packages: [
          { name: 'mongodb/mongodb', version: '2.4.2', require: { 'ext-mongodb': '^2.4' } },
          { name: 'doctrine/mongodb-odm', version: '2.17.1', require: { 'ext-mongodb': '^1.21 || ^2.0' } },
        ],
      }),
      'docker/php/Dockerfile': 'FROM php:8.4-fpm\nRUN pecl install mongodb \\\n    && docker-php-ext-enable mongodb\n',
      'index.php': '<?php\n',
    });
    const { report, files, plan: result } = plan(directory);
    assert.deepEqual(report.composerPlatform, [
      { extension: 'mongodb', version: '1.21.2', packages: ['mongodb/mongodb'] },
    ]);
    assert.equal(JSON.parse(files.get('composer.json')?.content ?? '{}').config.platform['ext-mongodb'], '1.21.2');
    assert.match(files.get('docker/php/Dockerfile')?.content ?? '', /pecl install mongodb-1\.21\.2 \\/);
    assert.ok(!result.todo.some((finding) => finding.id === 'php.extension-version'));
  });
});

describe('data migration', () => {
  it('offers to import a SQL file of the project when the local database is gone', () => {
    const directory = createProject({
      'index.php': '<?php\n$pdo = new PDO("mysql:host=$host;dbname=$dbname", $user, $pass);\n$host = "localhost";\n',
      'schema.sql': 'CREATE TABLE links (id INT PRIMARY KEY);\n',
    });
    const script = plan(directory).files.get('clever-migrate-data.sh')?.content ?? '';
    assert.match(script, /^SCHEMA_FILE=schema\.sql$/m);
    assert.match(script, /^if \[ "\$\{MYSQL_SOURCE:-file\}" = local \]; then$/m);
    assert.match(script, /^ {2}cp "\$SCHEMA_FILE" "\$DUMP_DIR\/mysql-addon\.dump"$/m);
  });
});

describe('database variables of .env files', () => {
  it('rewires Laravel DB_* variables', () => {
    const { report, files } = plan(path.join(fixtures, 'laravel'));
    const rewired = Object.fromEntries(report.rewired.map((variable) => [variable.name, variable.addonVariable]));
    assert.deepEqual(rewired, {
      DB_HOST: 'MYSQL_ADDON_HOST',
      DB_PORT: 'MYSQL_ADDON_PORT',
      DB_DATABASE: 'MYSQL_ADDON_DB',
      DB_USERNAME: 'MYSQL_ADDON_USER',
      DB_PASSWORD: 'MYSQL_ADDON_PASSWORD',
    });
    // Redis settings of the default Laravel .env.example are not a reason to create an add-on
    assert.ok(!report.addons.some((addon) => addon.provider === 'redis-addon'));
    assert.match(files.get('.env.clever')?.content ?? '', /^# DB_CONNECTION=mysql$/m);
  });

  it('takes DATABASE_URL from the add-on URI, without local-only options', () => {
    const { files } = plan(path.join(fixtures, 'node-pg'));
    const script = files.get('clever-setup.sh')?.content ?? '';
    assert.match(script, /^DATABASE_URL_VALUE="\$\(addon_var node-pg-postgresql POSTGRESQL_ADDON_URI\)"$/m);
    assert.match(script, /^clever env set DATABASE_URL "\$DATABASE_URL_VALUE" --alias "\$APP"$/m);
  });

  it('builds a MySQL URI from the add-on variables and keeps the query string', () => {
    const directory = createProject({
      'composer.json': JSON.stringify({ require: { 'symfony/framework-bundle': '7.1.*' } }),
      'public/index.php': '<?php\n',
      '.env': 'DATABASE_URL="mysql://app:app@127.0.0.1:3306/app?serverVersion=8.0.32&charset=utf8mb4"\n',
    });
    const script = plan(directory).files.get('clever-setup.sh')?.content ?? '';
    // serverVersion comes from the add-on, Doctrine must generate SQL for the real server
    assert.match(script, /^DATABASE_URL_VERSION="\$\(addon_var [\w-]+ MYSQL_ADDON_VERSION\)"$/m);
    assert.match(
      script,
      /clever env set DATABASE_URL "mysql:\/\/\$\{DATABASE_URL_USER\}:\$\{DATABASE_URL_PASSWORD\}@\$\{DATABASE_URL_HOST\}:\$\{DATABASE_URL_PORT\}\/\$\{DATABASE_URL_DATABASE\}\?serverVersion=\$\{DATABASE_URL_VERSION\}&charset=utf8mb4" --alias "\$APP"/,
    );
  });
});

describe('code fixes', () => {
  it('only fixes the interface when several servers have hard-coded ports', () => {
    const { plan: result } = plan(path.join(fixtures, 'node-express'));
    assert.deepEqual(
      result.edits.map((edit) => `${edit.file}:${edit.line} ${edit.after}`),
      ["src/server.js:9 app.listen(port, '0.0.0.0', () => {"],
    );
    assert.ok(result.todo.some((finding) => finding.id === 'code.several-servers'));
  });

  it('listens on PORT for a single server', () => {
    const directory = createProject({
      'package.json': JSON.stringify({
        main: 'server.js',
        scripts: { start: 'node server.js' },
        dependencies: { express: '^4' },
      }),
      'server.js': "const app = require('express')();\nconst port = 3000;\n// app.listen(4000)\napp.listen(port);\n",
    });
    const { plan: result, files } = plan(directory);
    assert.match(files.get('server.js')?.content ?? '', /^const port = Number\(process\.env\.PORT\) \|\| 3000;$/m);
    assert.match(files.get('server.js')?.content ?? '', /^\/\/ app\.listen\(4000\)$/m);
    assert.ok(!result.todo.some((finding) => finding.id === 'code.hardcoded-port'));
  });

  it('removes the hard-coded Next.js port', () => {
    const { files } = plan(path.join(fixtures, 'next-app'));
    assert.match(files.get('package.json')?.content ?? '', /"start": "next start"/);
  });

  it('reads the Spring Boot port from PORT', () => {
    const { files } = plan(path.join(fixtures, 'spring-boot'));
    assert.match(
      files.get('src/main/resources/application.properties')?.content ?? '',
      /^server\.port=\$\{PORT:8080\}$/m,
    );
  });
});

describe('source code checks', () => {
  it('ignores docstrings and defaults overridden by the plan', () => {
    const directory = createProject({
      'requirements.txt': 'fastapi\npsycopg\n',
      'app/main.py': 'from fastapi import FastAPI\n\napp = FastAPI()\n',
      'app/config.py':
        'from pydantic_settings import BaseSettings\n\nclass Settings(BaseSettings):\n    database_url: str = "postgresql+psycopg://u:p@localhost:5432/app"\n',
      'scripts/admin.py':
        '"""Usage:\n\n    DATABASE_URL=postgresql://u:p@localhost:5432/app python -m scripts.admin\n"""\n',
      '.env': 'DATABASE_URL=postgresql+psycopg://u:p@localhost:5432/app\n',
    });
    const { report } = plan(directory);
    assert.ok(!report.findings.some((finding) => finding.id === 'code.localhost-service'));
    assert.equal(
      report.rewired.find((variable) => variable.name === 'DATABASE_URL')?.driverScheme,
      'postgresql+psycopg',
    );
  });
});
