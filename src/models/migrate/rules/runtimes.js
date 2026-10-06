/**
 * @typedef {import('../project-scanner.js').ProjectScanner} ProjectScanner
 * @typedef {import('../report.js').MigrationReport} MigrationReport
 */

const STATIC_SSG_FILES = [
  'astro.config.mjs',
  'astro.config.ts',
  'astro.config.js',
  'astro.config.cjs',
  'docusaurus.config.js',
  'docusaurus.config.ts',
  'hugo.toml',
  'hugo.yaml',
  'hugo.json',
  'book.toml',
  'mkdocs.yml',
  '.storybook/main.js',
  '.storybook/main.ts',
];

const FRONTEND_BUILD_DEPENDENCIES = [
  'vite',
  'react-scripts',
  '@angular/cli',
  '@vue/cli-service',
  'parcel',
  'webpack-cli',
];
const NODE_SERVER_DEPENDENCIES = [
  'express',
  'fastify',
  'koa',
  '@hapi/hapi',
  '@nestjs/core',
  'next',
  'nuxt',
  '@remix-run/serve',
  '@sveltejs/adapter-node',
  'hono',
  '@adonisjs/core',
  'socket.io',
];

/**
 * Detect every runtime the project could be deployed with, most relevant first
 * @param {ProjectScanner} scanner
 * @returns {Array<{ type: string, reason: string }>}
 */
export function detectRuntimes(scanner) {
  const runtimes = [];
  const packageJson = scanner.readJson('package.json');

  if (scanner.has('composer.json') || scanner.has('index.php')) {
    runtimes.push({ type: 'php', reason: scanner.has('composer.json') ? 'composer.json' : 'index.php' });
  }
  if (packageJson != null) {
    if (isStaticFrontend(scanner, packageJson)) {
      runtimes.push({ type: 'static', reason: 'package.json builds a frontend without server' });
    } else {
      runtimes.push({ type: 'node', reason: 'package.json' });
    }
  }
  const pythonMarker = scanner.first([
    'pyproject.toml',
    'requirements.txt',
    'Pipfile',
    'uv.lock',
    'setup.py',
    'manage.py',
  ]);
  if (pythonMarker != null && !scanner.has('mkdocs.yml')) {
    runtimes.push({ type: 'python', reason: pythonMarker });
  }
  if (scanner.has('go.mod') || scanner.has('main.go')) {
    runtimes.push({ type: 'go', reason: scanner.has('go.mod') ? 'go.mod' : 'main.go' });
  }
  if (scanner.has('Cargo.toml')) {
    runtimes.push({ type: 'rust', reason: 'Cargo.toml' });
  }
  if (scanner.has('Gemfile')) {
    runtimes.push({ type: 'ruby', reason: 'Gemfile' });
  }
  if (scanner.has('pom.xml')) {
    runtimes.push({ type: 'maven', reason: 'pom.xml' });
  }
  const gradleFile = scanner.first(['build.gradle', 'build.gradle.kts']);
  if (gradleFile != null) {
    runtimes.push({ type: 'gradle', reason: gradleFile });
  }
  if (scanner.has('build.sbt')) {
    runtimes.push({ type: 'sbt', reason: 'build.sbt' });
  }
  if (scanner.has('mix.exs')) {
    runtimes.push({ type: 'elixir', reason: 'mix.exs' });
  }
  const ssgFile = scanner.first(STATIC_SSG_FILES);
  if (ssgFile != null && !runtimes.some((runtime) => runtime.type === 'static')) {
    runtimes.push({ type: 'static', reason: `${ssgFile} (static site generator)` });
  }
  if (runtimes.length === 0 && scanner.first(['index.html', 'public/index.html']) != null) {
    runtimes.push({ type: 'static', reason: 'index.html' });
  }
  return runtimes;
}

/**
 * @param {ProjectScanner} scanner
 * @param {any} packageJson
 * @returns {boolean}
 */
function isStaticFrontend(scanner, packageJson) {
  const dependencies = { ...packageJson.dependencies, ...packageJson.devDependencies };
  const scripts = packageJson.scripts ?? {};
  if (NODE_SERVER_DEPENDENCIES.some((name) => dependencies[name] != null)) {
    return false;
  }
  if (scripts.start != null && !/^(vite|react-scripts start|ng serve|vue-cli-service serve)/.test(scripts.start)) {
    return false;
  }
  const isSsg = scanner.first(STATIC_SSG_FILES) != null;
  return isSsg || (scripts.build != null && FRONTEND_BUILD_DEPENDENCIES.some((name) => dependencies[name] != null));
}

/**
 * @param {string} type
 * @param {ProjectScanner} scanner
 * @param {MigrationReport} report
 */
export function checkRuntime(type, scanner, report) {
  const check = RUNTIME_CHECKS[type];
  if (check != null) {
    check(scanner, report);
  }
}

/** @type {Record<string, (scanner: ProjectScanner, report: MigrationReport) => void>} */
const RUNTIME_CHECKS = {
  node: checkNode,
  static: checkStatic,
  php: checkPhp,
  python: checkPython,
  go: checkGo,
  rust: checkRust,
  ruby: checkRuby,
  maven: checkJava,
  gradle: checkJava,
};

/**
 * @param {ProjectScanner} scanner
 * @param {MigrationReport} report
 */
function checkNode(scanner, report) {
  const packageJson = scanner.readJson('package.json') ?? {};
  const scripts = packageJson.scripts ?? {};
  const dependencies = { ...packageJson.dependencies, ...packageJson.devDependencies };

  if (scripts.start == null && packageJson.main == null) {
    const devScript = scripts.dev ?? scripts.serve;
    report.add({
      id: 'node.no-start',
      severity: 'blocker',
      title: 'package.json has neither "scripts.start" nor "main"',
      details: devScript != null ? `Only a development script was found: "${devScript}".` : undefined,
      location: 'package.json',
      fix: ['Add a "start" script (e.g. "node server.js"), or `clever env set CC_RUN_COMMAND "<command>"`'],
    });
  } else if (
    scripts.start != null &&
    /\b(nodemon|ts-node-dev|tsx watch|--watch|vite(\s|$)|next dev|nuxt dev)\b/.test(scripts.start)
  ) {
    report.add({
      id: 'node.dev-start',
      severity: 'warning',
      title: `The start script runs in development mode: "${scripts.start}"`,
      location: 'package.json',
      fix: ['Use a production command in "start" (e.g. "node dist/main.js", "next start")'],
    });
  }

  if (scripts.build != null && !/\bbuild\b/.test(`${scripts.postinstall ?? ''} ${scripts.prestart ?? ''}`)) {
    report.setEnv(
      'CC_POST_BUILD_HOOK',
      `${packageManagerRun(scanner)} build`,
      'A build step is defined in package.json',
    );
    report.add({
      id: 'node.build-step',
      severity: 'blocker',
      title: 'The "build" script is never run on Clever Cloud',
      details: 'Only dependencies are installed during the build phase.',
      location: 'package.json',
      fix: [`\`clever env set CC_POST_BUILD_HOOK "${packageManagerRun(scanner)} build"\``],
    });
    const buildTools = ['typescript', '@nestjs/cli', 'vite', 'webpack', 'esbuild', 'tsup', 'rollup', '@swc/cli'];
    const buildToolsInDevDependencies = buildTools.filter((name) => packageJson.devDependencies?.[name] != null);
    if (buildToolsInDevDependencies.length > 0) {
      report.setEnv('CC_NODE_DEV_DEPENDENCIES', 'install', 'Build tools are declared in devDependencies');
      report.add({
        id: 'node.dev-dependencies',
        severity: 'blocker',
        title: `Build tools are devDependencies (${buildToolsInDevDependencies.join(', ')})`,
        details: 'devDependencies are not installed by default.',
        location: 'package.json',
        fix: ['`clever env set CC_NODE_DEV_DEPENDENCIES install`'],
      });
    }
  }

  if (
    packageJson.engines?.node == null &&
    !scanner.has('.nvmrc') &&
    !scanner.has('.node-version') &&
    !scanner.has('mise.toml')
  ) {
    report.add({
      id: 'node.version',
      severity: 'info',
      title: 'No Node.js version pinned',
      location: 'package.json',
      fix: ['Add "engines": { "node": "24" } to package.json, or set CC_NODE_VERSION'],
    });
  }

  if (scanner.has('bun.lockb') && !scanner.has('bun.lock')) {
    report.setEnv('CC_NODE_BUILD_TOOL', 'bun', 'Legacy bun.lockb lockfile is not auto-detected');
  } else if (
    scanner.has('yarn.lock') &&
    !/^yarn@[34]/.test(packageJson.packageManager ?? '') &&
    scanner.has('.yarnrc.yml')
  ) {
    report.add({
      id: 'node.yarn-berry',
      severity: 'warning',
      title: 'Yarn Berry config found but "packageManager" does not pin yarn@3/4',
      details: 'Clever Cloud would fall back to the deprecated Yarn 1.x.',
      location: 'package.json',
      fix: ['Add "packageManager": "yarn@4.x.x" to package.json, or `clever env set CC_NODE_BUILD_TOOL yarn-berry`'],
    });
  }

  if (
    dependencies.next != null &&
    /next start/.test(scripts.start ?? '') &&
    /-p\s*\d+|--port\s*\d+/.test(scripts.start)
  ) {
    report.add({
      id: 'node.next-port',
      severity: 'blocker',
      title: `"next start" uses a hard-coded port: "${scripts.start}"`,
      location: 'package.json',
      fix: ['Remove the -p option, Next.js reads PORT (8080 on Clever Cloud)'],
    });
  }

  const sqliteDriver = ['sqlite3', 'better-sqlite3', 'sqlite'].find((name) => dependencies[name] != null);
  if (sqliteDriver != null) {
    reportSqlite(report, `${sqliteDriver} dependency`, 'package.json');
  }
}

/**
 * @param {ProjectScanner} scanner
 * @returns {string}
 */
function packageManagerRun(scanner) {
  if (scanner.has('pnpm-lock.yaml')) {
    return 'pnpm run';
  }
  if (scanner.has('yarn.lock')) {
    return 'yarn run';
  }
  if (scanner.has('bun.lock') || scanner.has('bun.lockb')) {
    return 'bun run';
  }
  return 'npm run';
}

/**
 * @param {ProjectScanner} scanner
 * @param {MigrationReport} report
 */
function checkStatic(scanner, report) {
  const packageJson = scanner.readJson('package.json');
  if (scanner.first(STATIC_SSG_FILES) != null) {
    report.add({
      id: 'static.ssg',
      severity: 'info',
      title: 'Static site generator detected: Clever Cloud builds it automatically',
    });
    return;
  }
  if (packageJson?.scripts?.build != null) {
    const outputDir = guessFrontendOutputDir(scanner, packageJson);
    report.setEnv(
      'CC_BUILD_COMMAND',
      `${packageManagerInstall(scanner)} && ${packageManagerRun(scanner)} build`,
      'Frontend must be built',
    );
    report.setEnv('CC_WEBROOT', `/${outputDir}`, 'Serve the build output');
    report.add({
      id: 'static.build',
      severity: 'blocker',
      title: `The frontend must be built and served from /${outputDir}`,
      location: 'package.json',
      fix: [
        `\`clever env set CC_BUILD_COMMAND "${packageManagerInstall(scanner)} && ${packageManagerRun(scanner)} build"\``,
        `\`clever env set CC_WEBROOT /${outputDir}\``,
      ],
    });
    const dependencies = { ...packageJson.dependencies, ...packageJson.devDependencies };
    if (
      ['react-router-dom', 'vue-router', '@angular/router', '@tanstack/react-router'].some(
        (name) => dependencies[name] != null,
      )
    ) {
      report.add({
        id: 'static.spa-fallback',
        severity: 'warning',
        title: 'Client-side router detected: deep links need a fallback to index.html',
        fix: [
          'Configure the static server to rewrite unknown routes to /index.html (e.g. with a Caddyfile and CC_STATIC_CADDYFILE)',
        ],
      });
    }
    return;
  }
  if (!scanner.has('index.html') && scanner.has('public/index.html')) {
    report.setEnv('CC_WEBROOT', '/public', 'index.html is in public/');
  }
}

/**
 * @param {ProjectScanner} scanner
 * @param {any} packageJson
 * @returns {string}
 */
function guessFrontendOutputDir(scanner, packageJson) {
  const dependencies = { ...packageJson.dependencies, ...packageJson.devDependencies };
  if (dependencies['react-scripts'] != null) {
    return 'build';
  }
  if (dependencies['@angular/cli'] != null) {
    const angular = scanner.readJson('angular.json');
    const project = Object.values(angular?.projects ?? {})[0];
    return project?.architect?.build?.options?.outputPath ?? 'dist';
  }
  const viteConfig = scanner.first(['vite.config.ts', 'vite.config.js', 'vite.config.mjs']);
  const outDir = viteConfig != null ? /outDir\s*:\s*['"]([^'"]+)['"]/.exec(scanner.read(viteConfig) ?? '')?.[1] : null;
  return outDir?.replace(/^\.?\//, '') ?? 'dist';
}

/**
 * @param {ProjectScanner} scanner
 * @returns {string}
 */
function packageManagerInstall(scanner) {
  if (scanner.has('pnpm-lock.yaml')) {
    return 'pnpm install --frozen-lockfile';
  }
  if (scanner.has('yarn.lock')) {
    return 'yarn install';
  }
  if (scanner.has('package-lock.json')) {
    return 'npm ci';
  }
  return 'npm install';
}

/**
 * @param {ProjectScanner} scanner
 * @param {MigrationReport} report
 */
function checkPhp(scanner, report) {
  const composer = scanner.readJson('composer.json') ?? {};
  const require = { ...composer.require, ...composer['require-dev'] };
  const isSymfony = require['symfony/framework-bundle'] != null || scanner.has('symfony.lock');
  const isLaravel = require['laravel/framework'] != null || scanner.has('artisan');

  if ((isSymfony || isLaravel || scanner.has('public/index.php')) && !scanner.has('index.php')) {
    report.setEnv('CC_WEBROOT', '/public', 'The front controller is public/index.php');
    report.add({
      id: 'php.webroot',
      severity: 'blocker',
      title: 'The front controller is in public/: the document root must be changed',
      location: 'public/index.php',
      fix: ['`clever env set CC_WEBROOT /public`'],
    });
  }

  const phpConstraint = composer.require?.php;
  if (phpConstraint != null) {
    const version = /(\d+\.\d+)/.exec(phpConstraint)?.[1];
    if (version != null) {
      report.setEnv('CC_PHP_VERSION', version, `composer.json requires php ${phpConstraint}`);
    }
  }

  if (isSymfony) {
    report.setEnv('APP_ENV', 'prod', 'Symfony production mode');
    report.add({
      id: 'php.symfony-secret',
      severity: 'warning',
      title: 'Symfony needs APP_SECRET in production',
      fix: ['`clever env set APP_SECRET "$(openssl rand -hex 32)"`'],
    });
    if (require['doctrine/doctrine-migrations-bundle'] != null) {
      report.setEnv(
        'CC_PRE_RUN_HOOK',
        'php bin/console doctrine:migrations:migrate --no-interaction --allow-no-migration',
        'Run Doctrine migrations before start',
      );
    }
  }
  if (isLaravel) {
    report.setEnv('APP_ENV', 'production', 'Laravel production mode');
    report.setEnv('APP_DEBUG', 'false', 'Laravel production mode');
    report.setEnv('CC_PRE_RUN_HOOK', 'php artisan migrate --force', 'Run Laravel migrations before start');
    report.add({
      id: 'php.laravel-key',
      severity: 'blocker',
      title: 'Laravel needs APP_KEY in production',
      fix: ['`clever env set APP_KEY "base64:$(openssl rand -base64 32)"`'],
    });
    report.add({
      id: 'php.laravel-storage',
      severity: 'warning',
      title: 'storage/ is not persistent (uploads, file sessions, file cache)',
      fix: [
        'Use an FS Bucket for storage/app, or an S3 disk on Cellar',
        'Use the redis or database driver for sessions and cache',
      ],
    });
  }
}

/**
 * @param {ProjectScanner} scanner
 * @param {MigrationReport} report
 */
function checkPython(scanner, report) {
  const pythonVersionFile = scanner.first(['.python-version', 'runtime.txt']);
  if (pythonVersionFile != null) {
    const version = /(\d+\.\d+)/.exec(scanner.read(pythonVersionFile) ?? '')?.[1];
    if (version != null) {
      report.setEnv('CC_PYTHON_VERSION', version, `Pinned in ${pythonVersionFile}`);
    }
  }

  const dependencies = [scanner.read('requirements.txt'), scanner.read('pyproject.toml'), scanner.read('Pipfile')]
    .filter((content) => content != null)
    .join('\n')
    .toLowerCase();

  if (scanner.has('manage.py')) {
    const wsgiFile = scanner.find(/(^|\/)wsgi\.py$/)[0];
    if (wsgiFile != null) {
      const module = wsgiFile.replace(/\.py$/, '').replaceAll('/', '.');
      report.setEnv('CC_PYTHON_MODULE', `${module}:application`, 'Django WSGI entry point');
    }
    report.setEnv(
      'CC_PYTHON_MANAGE_TASKS',
      'migrate --noinput, collectstatic --noinput',
      'Django migrations and static files',
    );
    report.add({
      id: 'python.django',
      severity: 'warning',
      title: 'Django settings must be production ready',
      fix: [
        'Read ALLOWED_HOSTS, SECRET_KEY and DEBUG from environment variables',
        'Read the database from POSTGRESQL_ADDON_URI / MYSQL_ADDON_* (e.g. with dj-database-url)',
        'Serve static files with whitenoise, or with STATIC_FILES_PATH pointing to STATIC_ROOT',
      ],
    });
    return;
  }

  const asgiApp = scanner.grep(/^(\w+)\s*=\s*(FastAPI|Starlette|Quart)\(/)[0];
  const wsgiApp = scanner.grep(/^(\w+)\s*=\s*(Flask|Bottle|falcon\.App|falcon\.API)\(/)[0];
  const entryPoint = asgiApp ?? wsgiApp;
  if (entryPoint != null) {
    const module = entryPoint.file.replace(/\.py$/, '').replaceAll('/', '.');
    report.setEnv('CC_PYTHON_MODULE', `${module}:${entryPoint.match[1]}`, `${entryPoint.match[2]} application found`);
    if (asgiApp != null) {
      report.setEnv('CC_PYTHON_BACKEND', 'uvicorn', 'ASGI application');
      if (!/uvicorn/.test(dependencies)) {
        report.add({
          id: 'python.asgi-server',
          severity: 'info',
          title: 'Add uvicorn to the dependencies to run an ASGI application',
          fix: ['Add `uvicorn` to requirements.txt / pyproject.toml'],
        });
      }
    }
    report.add({
      id: 'python.entrypoint',
      severity: 'blocker',
      title: `Clever Cloud must know which application to serve (${entryPoint.match[2]} found in ${entryPoint.file})`,
      location: `${entryPoint.file}:${entryPoint.line}`,
      fix: [`\`clever env set CC_PYTHON_MODULE ${module}:${entryPoint.match[1]}\``],
    });
    return;
  }

  report.add({
    id: 'python.no-entrypoint',
    severity: 'blocker',
    title: 'No WSGI/ASGI application detected',
    fix: [
      'Set CC_PYTHON_MODULE to "module:app" (WSGI/ASGI object)',
      'or set CC_RUN_COMMAND: the process must then listen on port 9000',
    ],
  });
}

/**
 * @param {ProjectScanner} scanner
 * @param {MigrationReport} report
 */
function checkGo(scanner, report) {
  if (!scanner.has('go.mod')) {
    report.add({
      id: 'go.no-module',
      severity: 'warning',
      title: 'No go.mod: the legacy GOPATH build will be used',
      fix: ['Run `go mod init <module>` and commit go.mod / go.sum'],
    });
    return;
  }
  const hasRootMain = scanner.grep(/^package main\b/, scanner.find(/^[^/]+\.go$/)).length > 0;
  if (!hasRootMain) {
    const mainPackages = [
      ...new Set(
        scanner
          .grep(/^package main\b/, scanner.find(/\.go$/))
          .map((result) => result.file.split('/').slice(0, -1).join('/')),
      ),
    ];
    const module = /^module\s+(\S+)/m.exec(scanner.read('go.mod') ?? '')?.[1];
    if (mainPackages.length > 0 && module != null) {
      report.setEnv('CC_GO_PKG', `${module}/${mainPackages[0]}`, `The main package is in ${mainPackages[0]}`);
      report.add({
        id: 'go.main-package',
        severity: 'blocker',
        title: `The main package is not at the root (found: ${mainPackages.join(', ')})`,
        fix: [`\`clever env set CC_GO_PKG ${module}/${mainPackages[0]}\``],
      });
    }
  }
}

/**
 * @param {ProjectScanner} scanner
 * @param {MigrationReport} report
 */
function checkRust(scanner, report) {
  const cargo = scanner.read('Cargo.toml') ?? '';
  const bins = [...cargo.matchAll(/\[\[bin\]\][^[]*?name\s*=\s*"([^"]+)"/g)].map((match) => match[1]);
  if (bins.length > 1) {
    report.setEnv('CC_RUST_BIN', bins[0], 'Several binaries are defined in Cargo.toml');
    report.add({
      id: 'rust.multiple-bins',
      severity: 'blocker',
      title: `Several binaries in Cargo.toml (${bins.join(', ')})`,
      location: 'Cargo.toml',
      fix: [`\`clever env set CC_RUST_BIN ${bins[0]}\` (choose the web server)`],
    });
  }
  if (/^\[workspace\]/m.test(cargo) && !/^\[package\]/m.test(cargo)) {
    report.add({
      id: 'rust.workspace',
      severity: 'warning',
      title: 'Cargo workspace without root package',
      location: 'Cargo.toml',
      fix: ['Set CC_RUST_BIN to the binary to start'],
    });
  }
}

/**
 * @param {ProjectScanner} scanner
 * @param {MigrationReport} report
 */
function checkRuby(scanner, report) {
  if (!scanner.has('config.ru')) {
    report.add({
      id: 'ruby.no-rack',
      severity: 'warning',
      title: 'No config.ru: Clever Cloud starts Ruby web applications through Rack',
      fix: ['Add a config.ru, or set CC_RUN_COMMAND'],
    });
  }
  if (scanner.has('bin/rails')) {
    report.setEnv('RAILS_ENV', 'production', 'Rails production mode');
    report.setEnv('CC_RAKEGOALS', 'db:prepare,assets:precompile', 'Rails database and assets');
    report.add({
      id: 'ruby.rails-secret',
      severity: 'blocker',
      title: 'Rails needs SECRET_KEY_BASE (or RAILS_MASTER_KEY) in production',
      fix: ['`clever env set SECRET_KEY_BASE "$(openssl rand -hex 64)"`'],
    });
  }
}

/**
 * @param {ProjectScanner} scanner
 * @param {MigrationReport} report
 */
function checkJava(scanner, report) {
  const propertiesFile = scanner.first([
    'src/main/resources/application.properties',
    'src/main/resources/application.yml',
    'src/main/resources/application.yaml',
  ]);
  if (propertiesFile == null) {
    return;
  }
  const content = scanner.read(propertiesFile) ?? '';
  const port = /server\.port\s*[=:]\s*(\d+)/.exec(content)?.[1] ?? /^server:\s*\n\s+port:\s*(\d+)/m.exec(content)?.[1];
  if (port != null && port !== '8080') {
    report.add({
      id: 'java.port',
      severity: 'blocker',
      title: `server.port is set to ${port}, the application must listen on 8080`,
      location: propertiesFile,
      fix: ['Use server.port=${PORT:8080}'],
    });
  }
}

/**
 * @param {MigrationReport} report
 * @param {string} reason
 * @param {string} location
 */
export function reportSqlite(report, reason, location) {
  report.add({
    id: 'storage.sqlite',
    severity: 'blocker',
    title: `SQLite is used (${reason}): the database file would be lost on each deployment`,
    location,
    fix: [
      'Migrate to a PostgreSQL or MySQL add-on',
      'or store the SQLite file on an FS Bucket (not available for Docker applications)',
    ],
  });
}
