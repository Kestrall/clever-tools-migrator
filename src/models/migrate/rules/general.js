import { FOREIGN_PLATFORM_FILES } from '../catalog.js';
import { reportSqlite } from './runtimes.js';

/**
 * @typedef {import('../project-scanner.js').ProjectScanner} ProjectScanner
 * @typedef {import('../report.js').MigrationReport} MigrationReport
 */

const HTTP_PORT = 8080;
const PYTHON_RUN_COMMAND_PORT = 9000;

/**
 * @param {ProjectScanner} scanner
 * @param {MigrationReport} report
 */
export function checkRepository(scanner, report) {
  if (!scanner.isInsideGitRepository()) {
    report.add({
      id: 'git.missing',
      severity: 'blocker',
      title: 'The project is not a git repository: `clever deploy` pushes git commits',
      fix: ['`git init && git add . && git commit -m "Initial commit"`'],
    });
  }

  if (scanner.has('.clever.json')) {
    const linked = scanner.readJson('.clever.json')?.apps ?? [];
    report.add({
      id: 'clever.linked',
      severity: 'info',
      title: `Already linked to ${linked.length} Clever Cloud application(s): ${linked.map((/** @type {any} */ app) => app.alias ?? app.name).join(', ')}`,
      location: '.clever.json',
    });
  }

  const gitignore = scanner.read('.gitignore') ?? '';
  const envFiles = scanner.find(/^\.env(\.(local|prod|production))?$/);
  for (const envFile of envFiles) {
    if (!report.envFilesToImport.includes(envFile)) {
      report.envFilesToImport.push(envFile);
    }
  }
  if (envFiles.length > 0) {
    report.add({
      id: 'env.dotenv',
      severity: 'warning',
      title: `${envFiles.join(', ')} will not be read in production`,
      details:
        'Configuration must be stored in the application environment. Review the values first: hosts, ports and credentials must come from the add-ons.',
      fix: envFiles.map((file) => `\`clever env import < ${file}\``),
    });
    if (!/^\/?\.env\*?$/m.test(gitignore) && !/^\.env\b/m.test(gitignore)) {
      report.add({
        id: 'env.dotenv-committed',
        severity: 'warning',
        title: '.env is not in .gitignore: secrets could be pushed with `clever deploy`',
        location: '.gitignore',
        fix: ['Add `.env` to .gitignore'],
      });
    }
  }

  // Values that only make sense on a developer machine
  for (const envFile of envFiles) {
    const variables = scanner.readEnvFile(envFile) ?? {};
    const localUrls = Object.entries(variables).filter(
      ([name, value]) =>
        /^https?:\/\/(localhost|127\.0\.0\.1)\b/.test(value) && !/(DATABASE|DB_|REDIS|MONGO|AMQP)/.test(name),
    );
    const devModes = Object.entries(variables).filter(
      ([name, value]) =>
        /^(ENV|ENVIRONMENT|APP_ENV|NODE_ENV|RAILS_ENV|FLASK_ENV|MIX_ENV)$/.test(name) &&
        /^(dev|development|local|debug)$/i.test(value),
    );
    if (localUrls.length > 0 || devModes.length > 0) {
      report.add({
        id: 'env.dev-values',
        severity: 'warning',
        title: `${envFile} contains development values that must not be imported as is`,
        details: [...localUrls, ...devModes].map(([name, value]) => `${name}=${value}`).join('\n'),
        location: envFile,
        fix: [
          ...localUrls.map(([name]) => `\`clever env set ${name} https://<your-app>.cleverapps.io\` (or your domain)`),
          ...devModes.map(([name]) => `\`clever env set ${name} production\``),
        ],
      });
    }
  }

  const exampleFile = scanner.first(['.env.example', '.env.dist', '.env.sample', '.env.template']);
  if (exampleFile != null) {
    const variables = (scanner.read(exampleFile) ?? '')
      .split('\n')
      .map((line) => /^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=/.exec(line)?.[1])
      .filter((name) => name != null);
    if (variables.length > 0) {
      report.add({
        id: 'env.example',
        severity: 'info',
        title: `${variables.length} variable(s) expected by ${exampleFile}`,
        details: variables.join(', '),
        location: exampleFile,
        fix: ['Define each of them with `clever env set NAME value`'],
      });
    }
  }
}

/**
 * Heroku-like files and other PaaS specific configuration
 * @param {ProjectScanner} scanner
 * @param {MigrationReport} report
 * @param {string|null} runtimeType
 */
export function checkForeignPlatforms(scanner, report, runtimeType) {
  for (const { file, platform, mustContain } of FOREIGN_PLATFORM_FILES) {
    if (!scanner.has(file) || (mustContain != null && !(scanner.read(file) ?? '').includes(mustContain))) {
      continue;
    }
    if (file === 'Procfile') {
      checkProcfile(scanner, report, runtimeType);
      continue;
    }
    report.add({
      id: 'platform.foreign-config',
      severity: 'info',
      title: `${file} (${platform}) is not used by Clever Cloud`,
      details:
        'Translate its build/start commands, environment and services with the equivalents listed in this report.',
      location: file,
    });
  }

  const kubernetesManifests = scanner
    .find(/\.(ya?ml)$/)
    .filter((file) => /^kind:\s*(Deployment|StatefulSet|Service|Ingress)\s*$/m.test(scanner.read(file) ?? ''));
  if (kubernetesManifests.length > 0) {
    report.add({
      id: 'platform.kubernetes',
      severity: 'info',
      title: `${kubernetesManifests.length} Kubernetes manifest(s) found`,
      details: `${kubernetesManifests.slice(0, 5).join(', ')}. Ingress/TLS are handled by Clever Cloud, replicas by \`clever scale\`, Secrets/ConfigMaps by \`clever env\`.`,
    });
  }
}

/**
 * @param {ProjectScanner} scanner
 * @param {MigrationReport} report
 * @param {string|null} runtimeType
 */
function checkProcfile(scanner, report, runtimeType) {
  const processes = Object.fromEntries(
    (scanner.read('Procfile') ?? '')
      .split('\n')
      .map((line) => /^([\w-]+)\s*:\s*(.+)$/.exec(line.trim()))
      .filter((match) => match != null)
      .map((match) => [match[1], match[2].trim()]),
  );
  /** @type {string[]} */
  const fix = [];
  const pythonServer = /^(gunicorn|uvicorn|daphne|uwsgi)\b.*?\s([\w.]+:[\w]+)\b/.exec(processes.web ?? '');
  if (runtimeType === 'python' && pythonServer != null && report.env.CC_PYTHON_MODULE != null) {
    fix.push(
      `web → served by Clever Cloud with CC_PYTHON_MODULE (${pythonServer[1]} is a supported CC_PYTHON_BACKEND)`,
    );
  } else if (processes.web != null && runtimeType !== 'docker') {
    const command = processes.web.replace(
      /\$PORT|\$\{PORT\}/g,
      String(runtimeType === 'python' ? PYTHON_RUN_COMMAND_PORT : HTTP_PORT),
    );
    report.setEnv('CC_RUN_COMMAND', command, 'web process of the Procfile');
    fix.push(`web → \`clever env set CC_RUN_COMMAND ${JSON.stringify(command)}\``);
    if (runtimeType === 'python') {
      fix.push(`With CC_RUN_COMMAND, Python applications must listen on port ${PYTHON_RUN_COMMAND_PORT}`);
    }
  }
  if (processes.release != null) {
    report.setEnv('CC_PRE_RUN_HOOK', processes.release, 'release process of the Procfile');
    fix.push(`release → \`clever env set CC_PRE_RUN_HOOK ${JSON.stringify(processes.release)}\``);
  }
  const workers = Object.entries(processes).filter(([name]) => name !== 'web' && name !== 'release');
  workers.forEach(([name, command], index) => {
    const variable = `CC_WORKER_COMMAND_${index}`;
    report.setEnv(variable, command, `${name} process of the Procfile`);
    fix.push(`${name} → \`clever env set ${variable} ${JSON.stringify(command)}\``);
  });
  report.add({
    id: 'platform.procfile',
    severity: 'warning',
    title: 'Procfile is not read by Clever Cloud: its processes must be declared as environment variables',
    location: 'Procfile',
    fix,
  });
}

/**
 * Look into the code for things that break on a PaaS
 * @param {ProjectScanner} scanner
 * @param {MigrationReport} report
 * @param {string|null} runtimeType
 */
export function checkSourceCode(scanner, report, runtimeType) {
  // CI pipelines and compose files legitimately talk to local services
  const files = [
    ...scanner.sourceFiles,
    ...scanner.configFiles.filter(
      (file) =>
        !/(^|\/)(docker-)?compose[\w.-]*\.ya?ml$|^\.(github|gitlab|circleci|woodpecker)\/|^\.gitlab-ci\.yml$/.test(
          file,
        ),
    ),
  ];

  const localServiceUrls = scanner.grep(
    /\b(postgres(?:ql)?|mysql|mariadb|mongodb|redis|rediss|amqp|nats)(?:\+[\w-]+)?:\/\/[^\s'"`]*?(localhost|127\.0\.0\.1|0\.0\.0\.0)\b/,
    files,
  );
  for (const result of localServiceUrls.slice(0, 5)) {
    report.add({
      id: 'code.localhost-service',
      severity: 'warning',
      title: `Hard-coded ${result.match[1]} connection to ${result.match[2]}`,
      details: result.text,
      location: `${result.file}:${result.line}`,
      fix: ['Read the connection string from the add-on environment variables'],
    });
  }

  const expectedPort =
    runtimeType === 'python' && report.env.CC_RUN_COMMAND != null ? PYTHON_RUN_COMMAND_PORT : HTTP_PORT;
  const portPatterns = [
    /\.listen\(\s*(\d{2,5})\s*[,)]/,
    /\bListenAndServe(?:TLS)?\(\s*"[^"]*:(\d{2,5})"/,
    /\bapp\.run\([^)]*port\s*=\s*(\d{2,5})/,
    /\buvicorn\.run\([^)]*port\s*=\s*(\d{2,5})/,
    /\.bind\(\s*"(?:127\.0\.0\.1|localhost|0\.0\.0\.0):(\d{2,5})"/,
  ];
  // With CC_PYTHON_MODULE, the application object is served by the backend and dev servers are never started
  const isDevServer = (/** @type {string} */ text) =>
    runtimeType === 'python' && report.env.CC_PYTHON_MODULE != null && /\b(app\.run|uvicorn\.run)\(/.test(text);
  if (runtimeType !== 'docker' && runtimeType !== 'static') {
    for (const pattern of portPatterns) {
      for (const result of scanner
        .grep(pattern)
        .filter((result) => !isDevServer(result.text))
        .slice(0, 3)) {
        if (
          result.match[1] !== String(expectedPort) &&
          !/process\.env|os\.environ|getenv|env::var|PORT/.test(result.text)
        ) {
          report.add({
            id: 'code.hardcoded-port',
            severity: 'blocker',
            title: `The server listens on hard-coded port ${result.match[1]} instead of ${expectedPort}`,
            details: result.text,
            location: `${result.file}:${result.line}`,
            fix: [`Listen on the PORT environment variable (${expectedPort} on Clever Cloud)`],
          });
        }
      }
    }
  }

  const loopbackBindings = scanner.grep(
    /(\.listen\([^)]*['"](?:localhost|127\.0\.0\.1)['"]|host\s*=\s*['"](?:localhost|127\.0\.0\.1)['"]|"(?:localhost|127\.0\.0\.1):\d+"\)?\s*$|ListenAndServe\(\s*"(?:localhost|127\.0\.0\.1):)/,
  );
  for (const result of loopbackBindings.slice(0, 3)) {
    if (
      isDevServer(result.text) ||
      /(connect|createClient|Redis|mongo|database|db_?host|DB_HOST|smtp)/i.test(result.text)
    ) {
      continue;
    }
    report.add({
      id: 'code.loopback-binding',
      severity: 'blocker',
      title: 'The server only listens on localhost: it must listen on 0.0.0.0',
      details: result.text,
      location: `${result.file}:${result.line}`,
      fix: ['Bind the server to 0.0.0.0'],
    });
  }

  const sqliteFiles = scanner.find(/\.(sqlite3?|db)$/).filter((file) => !/(^|\/)(tests?|fixtures)\//.test(file));
  const sqliteUrl = scanner.grep(/sqlite:\/\/\/?[\w./-]+/, files)[0];
  if (sqliteFiles.length > 0) {
    reportSqlite(report, sqliteFiles[0], sqliteFiles[0]);
  } else if (sqliteUrl != null) {
    reportSqlite(report, sqliteUrl.match[0], `${sqliteUrl.file}:${sqliteUrl.line}`);
  }

  const uploadDirectory = ['uploads', 'public/uploads', 'storage/app/public', 'media', 'public/media', 'data'].find(
    (dir) => scanner.hasDirectory(dir),
  );
  if (
    uploadDirectory != null &&
    !['docker.volume', 'compose.volume', 'php.laravel-storage'].some((id) => report.hasFinding(id))
  ) {
    report.add({
      id: 'storage.local-files',
      severity: 'warning',
      title: `${uploadDirectory}/ looks like runtime data: the local filesystem is not persistent`,
      location: `${uploadDirectory}/`,
      fix:
        runtimeType === 'docker'
          ? ['Store these files on Cellar (S3): `clever addon create cellar-addon <name> --link <app>`']
          : [
              'Mount an FS Bucket on this folder (`clever addon create fs-bucket <name> --link <app>`), or use Cellar (S3)',
            ],
    });
  }

  const crontab = scanner.first(['crontab', 'docker/crontab', 'cron/crontab', '.crontab']);
  if (crontab != null && !scanner.has('clevercloud/cron.json')) {
    const entries = (scanner.read(crontab) ?? '')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('#') && /^(\S+\s+){5}\S/.test(line));
    const jobs = entries.map((line) => {
      const parts = line.split(/\s+/);
      return `${parts.slice(0, 5).join(' ')} ${parts.slice(5).join(' ')}`;
    });
    report.addFile('clevercloud/cron.json', JSON.stringify(jobs, null, 2) + '\n', `Translated from ${crontab}`);
    report.add({
      id: 'cron.crontab',
      severity: 'warning',
      title: `${crontab} found: scheduled jobs must be declared in clevercloud/cron.json`,
      details:
        'A clevercloud/cron.json draft is proposed. Use absolute binaries and the $ROOT token for repository files; wrap commands needing environment variables in a `#!/bin/bash -l` script.',
      location: crontab,
    });
  }
}
