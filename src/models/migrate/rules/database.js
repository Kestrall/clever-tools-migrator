import { getAddonMapping } from '../catalog.js';
import { codeLineMask } from '../project-scanner.js';
import { isRewiringAutomatic, resolveRewiring } from '../rewiring.js';

/**
 * @typedef {import('../project-scanner.js').ProjectScanner} ProjectScanner
 * @typedef {import('../report.js').MigrationReport} MigrationReport
 */

/**
 * @typedef {object} EngineSignature
 * @property {string} provider
 * @property {string[]} dependencies package names, in any ecosystem
 * @property {string[]} schemes URI schemes
 * @property {RegExp[]} code patterns in source and configuration files
 * @property {string[]} prefixes environment variable prefixes (MYSQL_HOST, PGHOST...)
 * @property {string} defaultPort
 */

/** @type {EngineSignature[]} */
export const ENGINES = [
  {
    provider: 'postgresql-addon',
    dependencies: [
      'pg',
      'postgres',
      'pg-promise',
      '@vercel/postgres',
      'ext-pgsql',
      'ext-pdo_pgsql',
      'psycopg',
      'psycopg2',
      'psycopg2-binary',
      'asyncpg',
      'github.com/lib/pq',
      'github.com/jackc/pgx',
      'org.postgresql',
      'tokio-postgres',
    ],
    schemes: ['postgres', 'postgresql', 'pgsql'],
    code: [
      /['"`]pgsql:host=/,
      /\bpg_connect\(/,
      /jdbc:postgresql:/,
      /django\.db\.backends\.postgresql/,
      /provider\s*=\s*"postgresql"/,
      /^DB_CONNECTION=pgsql$/,
    ],
    prefixes: ['POSTGRES', 'POSTGRESQL', 'PG'],
    defaultPort: '5432',
  },
  {
    provider: 'mysql-addon',
    dependencies: [
      'mysql',
      'mysql2',
      'mariadb',
      'ext-mysqli',
      'ext-pdo_mysql',
      'pymysql',
      'mysqlclient',
      'mysql-connector-python',
      'aiomysql',
      'github.com/go-sql-driver/mysql',
      'mysql-connector-java',
      'mysql-connector-j',
      'mariadb-java-client',
      'mysql_async',
    ],
    schemes: ['mysql', 'mariadb'],
    code: [
      /['"`]mysql:host=/,
      /\bmysqli_connect\(|\bnew\s+mysqli\(/,
      /jdbc:(mysql|mariadb):/,
      /django\.db\.backends\.mysql/,
      /provider\s*=\s*"mysql"/,
      /^DB_CONNECTION=(mysql|mariadb)$/,
    ],
    prefixes: ['MYSQL', 'MARIADB'],
    defaultPort: '3306',
  },
  {
    provider: 'mongodb-addon',
    dependencies: [
      'mongoose',
      'mongodb',
      'mongodb/mongodb',
      'pymongo',
      'motor',
      'mongoengine',
      'mongoid',
      'go.mongodb.org/mongo-driver',
    ],
    schemes: ['mongodb', 'mongodb+srv'],
    code: [/provider\s*=\s*"mongodb"/],
    prefixes: ['MONGO', 'MONGODB'],
    defaultPort: '27017',
  },
  {
    provider: 'redis-addon',
    dependencies: [
      'redis',
      'ioredis',
      'bull',
      'bullmq',
      'predis/predis',
      'ext-redis',
      'rq',
      'sidekiq',
      'github.com/redis/go-redis',
      'github.com/go-redis/redis',
    ],
    schemes: ['redis', 'rediss'],
    code: [],
    prefixes: ['REDIS'],
    defaultPort: '6379',
  },
];

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', 'host.docker.internal']);
const DATA_PROVIDERS = new Set(['postgresql-addon', 'mysql-addon', 'mongodb-addon']);

/** Names of PHP variables and constants holding database settings */
const PHP_SETTING_ROLES = /** @type {Array<[RegExp, string]>} */ ([
  [/^(db_?)?(host|hostname|servername|server)$/i, 'host'],
  [/^(db_?)?port$/i, 'port'],
  [/^(db_?name|dbname|database|db_?database|db)$/i, 'database'],
  [/^(db_?)?(user|username|login|dbuser)$/i, 'user'],
  [/^(db_?)?(password|pass|passwd|pwd|dbpass)$/i, 'password'],
]);

/**
 * Detect databases used by the application, plan the add-ons and rewire the configuration
 * @param {ProjectScanner} scanner
 * @param {MigrationReport} report
 */
export function checkDatabases(scanner, report) {
  if (report.runtime.type === 'static') {
    return;
  }
  const dependencies = collectDependencies(scanner);
  const configFiles = [
    ...scanner.sourceFiles,
    ...scanner.configFiles,
    ...report.envFilesToImport,
    ...exampleEnvFiles(scanner),
  ];
  const externalHosts = findExternalHosts(scanner, report);

  for (const engine of ENGINES) {
    const mapping = getAddonMapping(engine.provider);
    if (mapping == null) {
      continue;
    }
    /** @type {string[]} */
    const evidence = [];
    const dependency = engine.dependencies.find((name) => dependencies.has(name));
    if (dependency != null) {
      evidence.push(`dependency ${dependency}`);
    }
    for (const pattern of engine.code) {
      const result = scanner.grep(pattern, configFiles)[0];
      if (result != null) {
        evidence.push(`${result.file}:${result.line}`);
        break;
      }
    }
    const schemePattern = new RegExp(
      `\\b(${engine.schemes.map((scheme) => scheme.replace('+', '\\+')).join('|')})(\\+[\\w-]+)?://`,
    );
    const uriResult = scanner.grep(schemePattern, configFiles)[0];
    if (uriResult != null) {
      evidence.push(`${uriResult.file}:${uriResult.line}`);
    }
    const composeAddon = report.addons.find((addon) => addon.provider === engine.provider);
    if (evidence.length === 0 && composeAddon == null) {
      continue;
    }

    const external = externalHosts.get(engine.provider);
    if (external != null && composeAddon == null) {
      report.add({
        id: 'database.external',
        severity: 'info',
        title: `${mapping.label} is already hosted outside of the project (${external})`,
        details: `Keep it, or migrate it to a ${mapping.label} add-on with \`clever addon create ${engine.provider}\`.`,
      });
      continue;
    }

    const addon = report.addAddon({ provider: engine.provider, label: mapping.label });
    report.databases.push({ provider: engine.provider, label: mapping.label, evidence, addonName: addon.name });
    if (composeAddon == null) {
      report.add({
        id: 'database.addon',
        severity: 'blocker',
        title: `The application uses ${mapping.label}: it needs a ${mapping.label} add-on`,
        details: `Detected from ${evidence.join(', ')}`,
        fix: [`\`clever addon create ${engine.provider} ${addon.name} --link ${report.appName}\``],
      });
    }
  }

  rewireEnvFiles(scanner, report);
  checkHardcodedCredentials(scanner, report);

  for (const database of report.databases.filter((candidate) => DATA_PROVIDERS.has(candidate.provider))) {
    report.add({
      id: 'database.import-data',
      severity: 'warning',
      title: `The ${database.label} add-on starts empty: import your schema and data`,
      location: database.addonName ?? undefined,
      fix: [
        'Review and run `./clever-migrate-data.sh` (dump of the local database, import into the add-on), or use your migrations',
      ],
    });
  }
}

/**
 * Point database variables of .env files to the add-ons
 * @param {ProjectScanner} scanner
 * @param {MigrationReport} report
 */
function rewireEnvFiles(scanner, report) {
  const files = [...report.envFilesToImport, ...exampleEnvFiles(scanner)];
  /** @type {string[]} */
  const descriptions = [];

  for (const file of files) {
    const variables = scanner.readEnvFile(file) ?? {};
    const groups = groupDatabaseVariables(variables, report);
    for (const [name, value] of Object.entries(variables)) {
      if (report.env[name] != null || report.rewired.some((variable) => variable.name === name)) {
        continue;
      }
      const engine = engineForVariable(name, value, groups, report);
      if (engine == null) {
        continue;
      }
      const mapping = getAddonMapping(engine.provider);
      const database = report.databases.find((candidate) => candidate.provider === engine.provider);
      if (mapping == null || database == null) {
        continue;
      }
      const target = resolveRewiring(mapping, name, value);
      if (target.addonVariable == null && target.uriParts == null) {
        continue;
      }
      report.rewired.push({
        name,
        value,
        source: file,
        service: 'local database',
        addonName: database.addonName,
        ...target,
      });
      descriptions.push(
        target.addonVariable === name
          ? `${name} → already injected by the add-on`
          : `${name} → ${target.addonVariable ?? `built from ${Object.values(target.uriParts ?? {}).join(', ')}`} (${file})`,
      );
    }
  }

  if (descriptions.length > 0) {
    const automatic = report.rewired
      .filter((variable) => variable.service === 'local database')
      .every(isRewiringAutomatic);
    report.add({
      id: 'database.env-rewired',
      severity: 'blocker',
      title: 'Database variables point to a local database',
      details: descriptions.join('\n'),
      fix: [automatic ? 'clever-setup.sh sets them from the add-on variables' : 'Set them from the add-on variables'],
    });
  }
}

/**
 * Database settings are usually grouped by prefix (DB_HOST, DB_PORT...): a group points to a local
 * database when its host does, or when it has no host at all (the driver then defaults to localhost)
 * @param {Record<string, string>} variables
 * @param {MigrationReport} report
 * @returns {Map<string, EngineSignature>} prefix → engine
 */
function groupDatabaseVariables(variables, report) {
  /** @type {Map<string, EngineSignature>} */
  const groups = new Map();
  for (const [name, value] of Object.entries(variables)) {
    const match = /^([A-Z][A-Z0-9]*_)?(DB_)?(HOST|HOSTNAME|SERVER)$/.exec(name);
    if (match == null || (value !== '' && !isLocalHost(value))) {
      continue;
    }
    const prefix = `${match[1] ?? ''}${match[2] ?? ''}`;
    const engine =
      ENGINES.find((candidate) => candidate.prefixes.some((engineName) => prefix.startsWith(`${engineName}_`))) ??
      engineFromConnection(variables, report);
    if (engine != null && /(DB|DATABASE|SQL|PG|MONGO|REDIS|MARIADB)/.test(prefix)) {
      groups.set(prefix, engine);
    }
  }
  return groups;
}

/**
 * Laravel and friends declare the engine in DB_CONNECTION, otherwise use the only SQL database detected
 * @param {Record<string, string>} variables
 * @param {MigrationReport} report
 * @returns {EngineSignature|null}
 */
function engineFromConnection(variables, report) {
  const connection = variables.DB_CONNECTION ?? variables.DATABASE_ENGINE ?? '';
  const byName = ENGINES.find(
    (engine) => engine.schemes.includes(connection) || engine.provider.startsWith(connection),
  );
  if (byName != null && connection !== '') {
    return byName;
  }
  const sqlDatabases = report.databases.filter((database) =>
    ['postgresql-addon', 'mysql-addon'].includes(database.provider),
  );
  return sqlDatabases.length === 1
    ? (ENGINES.find((engine) => engine.provider === sqlDatabases[0].provider) ?? null)
    : null;
}

/**
 * @param {string} name
 * @param {string} value
 * @param {Map<string, EngineSignature>} groups
 * @param {MigrationReport} report
 * @returns {EngineSignature|null}
 */
function engineForVariable(name, value, groups, report) {
  const uri = /^([a-z][a-z0-9+.-]*):\/\/(?:[^@/]*@)?(\[[^\]]+\]|[^:/?]+)/i.exec(value);
  if (uri != null) {
    const scheme = uri[1].split('+')[0] === 'mongodb' && uri[1].includes('srv') ? 'mongodb+srv' : uri[1].split('+')[0];
    const engine = ENGINES.find((candidate) => candidate.schemes.includes(scheme));
    const isLocal = isLocalHost(uri[2]) || !uri[2].includes('.');
    return engine != null && isLocal && report.databases.some((database) => database.provider === engine.provider)
      ? engine
      : null;
  }
  for (const [prefix, engine] of groups) {
    if (
      name.startsWith(prefix) &&
      /^(HOST|HOSTNAME|SERVER|PORT|NAME|DATABASE|DB|USER|USERNAME|PASSWORD|PASS)$/.test(name.slice(prefix.length))
    ) {
      return engine;
    }
  }
  return null;
}

/**
 * Databases already hosted elsewhere (managed service URL in the .env files)
 * @param {ProjectScanner} scanner
 * @param {MigrationReport} report
 * @returns {Map<string, string>} provider → host
 */
function findExternalHosts(scanner, report) {
  /** @type {Map<string, string>} */
  const hosts = new Map();
  for (const file of report.envFilesToImport) {
    for (const value of Object.values(scanner.readEnvFile(file) ?? {})) {
      const uri = /^([a-z][a-z0-9+.-]*):\/\/(?:[^@/]*@)?([^:/?]+)/i.exec(value);
      if (uri == null || isLocalHost(uri[2]) || !uri[2].includes('.')) {
        continue;
      }
      const engine = ENGINES.find((candidate) => candidate.schemes.includes(uri[1].split('+')[0]));
      if (engine != null) {
        hosts.set(engine.provider, uri[2]);
      }
    }
  }
  return hosts;
}

/**
 * @typedef {object} HardcodedSetting
 * @property {number} line
 * @property {string} role host, port, database, user or password
 * @property {'variable'|'constant'} kind
 * @property {string} name variable or constant name
 * @property {string} value
 */

/**
 * @typedef {object} HardcodedConnection
 * @property {string} file
 * @property {EngineSignature} engine
 * @property {HardcodedSetting[]} settings
 * @property {number|null} dsnLine line of a PDO DSN using $host without port, when there is one
 * @property {string|null} hostVariable
 */

/**
 * Find PHP files holding database credentials in variables or constants used to connect
 * @param {ProjectScanner} scanner
 * @returns {HardcodedConnection[]}
 */
export function findHardcodedPhpConnections(scanner) {
  /** @type {HardcodedConnection[]} */
  const connections = [];
  for (const file of scanner.files.filter(
    (candidate) => candidate.endsWith('.php') && !candidate.startsWith('vendor/'),
  )) {
    const content = scanner.read(file);
    if (content == null) {
      continue;
    }
    const usesMysql = /['"]mysql:host=|\bmysqli_connect\(|\bnew\s+mysqli\(|DB_HOST/.test(content);
    const usesPostgres = /['"]pgsql:host=|\bpg_connect\(/.test(content);
    if (!usesMysql && !usesPostgres) {
      continue;
    }
    const engine = /** @type {EngineSignature} */ (
      ENGINES.find((candidate) => candidate.provider === (usesPostgres ? 'postgresql-addon' : 'mysql-addon'))
    );
    const lines = content.split('\n');
    const isCode = codeLineMask(file, lines);
    const connectionLines = lines.filter((line) => /mysql:|pgsql:|mysqli|pg_connect|new PDO/.test(line)).join('\n');

    /** @type {HardcodedSetting[]} */
    const settings = [];
    lines.forEach((line, index) => {
      if (!isCode[index]) {
        return;
      }
      const variable = /^\s*\$(\w+)\s*=\s*(['"])([^'"]*)\2\s*;/.exec(line);
      if (variable != null) {
        const role = roleOfPhpName(variable[1]);
        // Only variables actually used to connect
        if (role != null && new RegExp(`\\$${variable[1]}\\b`).test(connectionLines)) {
          settings.push({ line: index + 1, role, kind: 'variable', name: variable[1], value: variable[3] });
        }
        return;
      }
      const constant =
        /^\s*define\(\s*(['"])(DB_(?:HOST|NAME|USER|PASSWORD|PORT))\1\s*,\s*(['"])([^'"]*)\3\s*\)\s*;/.exec(line);
      if (constant != null) {
        const role = {
          DB_HOST: 'host',
          DB_NAME: 'database',
          DB_USER: 'user',
          DB_PASSWORD: 'password',
          DB_PORT: 'port',
        }[constant[2]];
        if (role != null) {
          settings.push({ line: index + 1, role, kind: 'constant', name: constant[2], value: constant[4] });
        }
      }
    });

    const host = settings.find((setting) => setting.role === 'host');
    if (host == null || !isLocalHost(host.value)) {
      continue;
    }
    const dsnIndex = lines.findIndex(
      (line) => new RegExp(`(mysql|pgsql):host=\\$${host.name}\\b`).test(line) && !/port=/.test(line),
    );
    connections.push({
      file,
      engine,
      settings,
      dsnLine: dsnIndex === -1 ? null : dsnIndex + 1,
      hostVariable: host.kind === 'variable' ? host.name : null,
    });
  }
  return connections;
}

/**
 * @param {ProjectScanner} scanner
 * @param {MigrationReport} report
 */
function checkHardcodedCredentials(scanner, report) {
  for (const connection of findHardcodedPhpConnections(scanner)) {
    const mapping = getAddonMapping(connection.engine.provider);
    if (!report.databases.some((database) => database.provider === connection.engine.provider)) {
      const addon = report.addAddon({
        provider: connection.engine.provider,
        label: mapping?.label ?? connection.engine.provider,
      });
      report.databases.push({
        provider: connection.engine.provider,
        label: addon.label,
        evidence: [connection.file],
        addonName: addon.name,
      });
    }
    const host = /** @type {HardcodedSetting} */ (connection.settings.find((setting) => setting.role === 'host'));
    report.add({
      id: 'database.hardcoded-credentials',
      severity: 'blocker',
      title: `Database credentials are hard-coded in ${connection.file} (host ${host.value})`,
      details: connection.settings
        .map(
          (setting) =>
            `${setting.kind === 'variable' ? `$${setting.name}` : setting.name} → ${mapping?.variables[setting.role] ?? '?'}`,
        )
        .join('\n'),
      location: `${connection.file}:${host.line}`,
      fix: [`Read them from the add-on variables, e.g. getenv('${mapping?.variables.host}') ?: '${host.value}'`],
    });
  }
}

/**
 * @param {string} name
 * @returns {string|null}
 */
function roleOfPhpName(name) {
  return PHP_SETTING_ROLES.find(([pattern]) => pattern.test(name))?.[1] ?? null;
}

/**
 * @param {string} host
 * @returns {boolean}
 */
export function isLocalHost(host) {
  return LOCAL_HOSTS.has(host.toLowerCase());
}

/**
 * @param {ProjectScanner} scanner
 * @returns {string[]}
 */
function exampleEnvFiles(scanner) {
  return scanner.find(/^\.env\.(example|dist|sample|template)$/);
}

/**
 * Names of the dependencies declared in every known manifest
 * @param {ProjectScanner} scanner
 * @returns {Set<string>}
 */
export function collectDependencies(scanner) {
  /** @type {Set<string>} */
  const names = new Set();
  const add = (/** @type {string} */ name) => names.add(name.toLowerCase().replace(/\[.*\]$/, ''));

  const packageJson = scanner.readJson('package.json');
  Object.keys({ ...packageJson?.dependencies, ...packageJson?.optionalDependencies }).forEach(add);

  const composer = scanner.readJson('composer.json');
  Object.keys({ ...composer?.require }).forEach(add);

  for (const file of scanner.find(/(^|\/)requirements[\w.-]*\.txt$/)) {
    for (const line of (scanner.read(file) ?? '').split('\n')) {
      const match = /^\s*([A-Za-z0-9_.-]+(?:\[[^\]]*\])?)/.exec(line);
      if (match != null && !line.trim().startsWith('#') && !line.trim().startsWith('-')) {
        add(match[1]);
      }
    }
  }
  for (const file of ['pyproject.toml', 'Pipfile']) {
    const content = scanner.read(file) ?? '';
    for (const match of content.matchAll(/["']([A-Za-z0-9_.-]+)(?:\[[^\]]*\])?\s*(?:[<>=~!;].*?)?["']/g)) {
      add(match[1]);
    }
    for (const match of content.matchAll(/^([A-Za-z0-9_.-]+)\s*=/gm)) {
      add(match[1]);
    }
  }
  for (const match of (scanner.read('Gemfile') ?? '').matchAll(/^\s*gem\s+['"]([^'"]+)['"]/gm)) {
    add(match[1]);
  }
  for (const match of (scanner.read('go.mod') ?? '').matchAll(
    /^\s*(?:require\s+)?([\w.-]+\.[\w.-]+\/[\w./-]+)\s+v/gm,
  )) {
    // Keep both the module and its parents: github.com/jackc/pgx/v5 → github.com/jackc/pgx
    const parts = match[1].split('/');
    for (let length = 3; length <= parts.length; length++) {
      add(parts.slice(0, length).join('/'));
    }
  }
  for (const match of (scanner.read('Cargo.toml') ?? '').matchAll(/^([A-Za-z0-9_-]+)\s*=/gm)) {
    add(match[1]);
  }
  for (const file of ['pom.xml', 'build.gradle', 'build.gradle.kts']) {
    const content = scanner.read(file) ?? '';
    for (const match of content.matchAll(/<(?:groupId|artifactId)>([^<]+)<\//g)) {
      add(match[1]);
    }
    for (const match of content.matchAll(/["']([\w.-]+):([\w.-]+)(?::[^"']*)?["']/g)) {
      add(match[1]);
      add(match[2]);
    }
  }
  return names;
}
