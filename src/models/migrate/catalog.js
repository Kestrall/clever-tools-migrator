/**
 * Knowledge base used by the migration analyzer: how common self-hosted services map to Clever Cloud.
 */

/**
 * @typedef {object} AddonMapping
 * @property {'addon'} kind
 * @property {string} provider provider id for `clever addon create`
 * @property {string} label
 * @property {Record<string, string>} variables role → environment variable injected by the add-on
 * @property {string} [note]
 */

/**
 * @typedef {object} ReplacedMapping
 * @property {'not-needed'|'dev-only'|'unsupported'} kind
 * @property {string} label
 * @property {string} note
 */

/** @type {Array<{ pattern: RegExp, mapping: AddonMapping|ReplacedMapping }>} */
export const SERVICE_MAPPINGS = [
  {
    pattern: /(^|\/)(postgres|postgis\/postgis|timescale\/timescaledb|bitnami\/postgresql|pgvector\/pgvector)(:|$)/,
    mapping: {
      kind: 'addon',
      provider: 'postgresql-addon',
      label: 'PostgreSQL',
      variables: {
        uri: 'POSTGRESQL_ADDON_URI',
        host: 'POSTGRESQL_ADDON_HOST',
        port: 'POSTGRESQL_ADDON_PORT',
        database: 'POSTGRESQL_ADDON_DB',
        user: 'POSTGRESQL_ADDON_USER',
        password: 'POSTGRESQL_ADDON_PASSWORD',
      },
    },
  },
  {
    pattern: /(^|\/)(mysql|mariadb|percona|bitnami\/mysql|bitnami\/mariadb)(:|$)/,
    mapping: {
      kind: 'addon',
      provider: 'mysql-addon',
      label: 'MySQL',
      variables: {
        host: 'MYSQL_ADDON_HOST',
        port: 'MYSQL_ADDON_PORT',
        database: 'MYSQL_ADDON_DB',
        user: 'MYSQL_ADDON_USER',
        password: 'MYSQL_ADDON_PASSWORD',
      },
      note: 'MariaDB images are migrated to the MySQL add-on: check SQL compatibility of MariaDB-specific features.',
    },
  },
  {
    pattern: /(^|\/)(mongo|mongodb\/mongodb-community-server|bitnami\/mongodb)(:|$)/,
    mapping: {
      kind: 'addon',
      provider: 'mongodb-addon',
      label: 'MongoDB',
      variables: {
        uri: 'MONGODB_ADDON_URI',
        host: 'MONGODB_ADDON_HOST',
        port: 'MONGODB_ADDON_PORT',
        user: 'MONGODB_ADDON_USER',
        password: 'MONGODB_ADDON_PASSWORD',
      },
    },
  },
  {
    pattern: /(^|\/)(redis|valkey\/valkey|valkey|keydb|eqalpha\/keydb|bitnami\/redis|redis\/redis-stack)(:|$)/,
    mapping: {
      kind: 'addon',
      provider: 'redis-addon',
      label: 'Redis',
      variables: {
        uri: 'REDIS_URL',
        host: 'REDIS_HOST',
        port: 'REDIS_PORT',
        password: 'REDIS_PASSWORD',
      },
      note: 'Materia KV (`clever addon create kv`) is a serverless, Redis-compatible alternative for simple key/value usage.',
    },
  },
  {
    pattern: /(^|\/)(elasticsearch|elastic\/elasticsearch|opensearchproject\/opensearch|bitnami\/elasticsearch)(:|$)/,
    mapping: {
      kind: 'addon',
      provider: 'es-addon',
      label: 'Elasticsearch',
      variables: {
        host: 'ES_ADDON_HOST',
        user: 'ES_ADDON_USER',
        password: 'ES_ADDON_PASSWORD',
      },
      note: 'OpenSearch is migrated to Elasticsearch: check client compatibility.',
    },
  },
  {
    pattern: /(^|\/)(minio|minio\/minio|bitnami\/minio|localstack\/localstack|zenko\/cloudserver|garage)(:|$)/,
    mapping: {
      kind: 'addon',
      provider: 'cellar-addon',
      label: 'Cellar (S3-compatible object storage)',
      variables: {
        host: 'CELLAR_ADDON_HOST',
        accessKey: 'CELLAR_ADDON_KEY_ID',
        secretKey: 'CELLAR_ADDON_KEY_SECRET',
      },
      note: 'Create buckets with any S3 client once the add-on exists.',
    },
  },
  {
    pattern: /(^|\/)(keycloak|quay\.io\/keycloak\/keycloak|bitnami\/keycloak)(:|$)/,
    mapping: { kind: 'addon', provider: 'keycloak', label: 'Keycloak', variables: {} },
  },
  {
    pattern: /(^|\/)(matomo|bitnami\/matomo)(:|$)/,
    mapping: { kind: 'addon', provider: 'addon-matomo', label: 'Matomo', variables: {} },
  },
  {
    pattern: /(^|\/)(metabase|metabase\/metabase)(:|$)/,
    mapping: { kind: 'addon', provider: 'metabase', label: 'Metabase', variables: {} },
  },
  {
    pattern: /(^|\/)(otoroshi|maif\/otoroshi)(:|$)/,
    mapping: { kind: 'addon', provider: 'otoroshi', label: 'Otoroshi', variables: {} },
  },
  {
    pattern: /(^|\/)(jenkins|jenkins\/jenkins)(:|$)/,
    mapping: { kind: 'addon', provider: 'jenkins', label: 'Jenkins', variables: {} },
  },
  {
    pattern: /(^|\/)(apachepulsar\/pulsar|pulsar)(:|$)/,
    mapping: { kind: 'addon', provider: 'addon-pulsar', label: 'Pulsar', variables: {} },
  },
  {
    pattern:
      /(^|\/)(nginx|traefik|caddy|haproxy|httpd|nginxproxy\/nginx-proxy|jwilder\/nginx-proxy|jc21\/nginx-proxy-manager)(:|$)/,
    mapping: {
      kind: 'not-needed',
      label: 'Reverse proxy',
      note: 'Clever Cloud provides the load balancer, HTTPS termination and domain routing. Drop this service, or keep it inside the application image only if it serves files or rewrites requests.',
    },
  },
  {
    pattern: /(^|\/)(certbot|certbot\/certbot|nginxproxy\/acme-companion|jrcs\/letsencrypt-nginx-proxy-companion)(:|$)/,
    mapping: {
      kind: 'not-needed',
      label: 'TLS certificates',
      note: "Let's Encrypt certificates are issued automatically for domains added with `clever domain add`.",
    },
  },
  {
    pattern:
      /(^|\/)(adminer|phpmyadmin|phpmyadmin\/phpmyadmin|dpage\/pgadmin4|mongo-express|redis\/redisinsight|rediscommander\/redis-commander)(:|$)/,
    mapping: {
      kind: 'dev-only',
      label: 'Database admin UI',
      note: 'Each database add-on comes with an administration interface in the Clever Cloud Console.',
    },
  },
  {
    pattern: /(^|\/)(mailhog\/mailhog|mailhog|axllent\/mailpit|mailpit|maildev\/maildev|schickling\/mailcatcher)(:|$)/,
    mapping: {
      kind: 'dev-only',
      label: 'Mail catcher',
      note: 'Development-only service. Use a real SMTP provider in production (Mailjet, Brevo, Scaleway TEM, ...).',
    },
  },
  {
    pattern:
      /(^|\/)(rabbitmq|bitnami\/rabbitmq|cloudamqp\/lavinmq|nats|bitnami\/kafka|apache\/kafka|confluentinc\/cp-kafka)(:|$)/,
    mapping: {
      kind: 'unsupported',
      label: 'Message broker',
      note: 'No managed equivalent with the same protocol. Options: Pulsar add-on (`clever addon create addon-pulsar`), Redis streams/queues, an external managed broker, or deploy the image as a separate Docker application with TCP redirections.',
    },
  },
];

/**
 * @param {string} image
 * @returns {AddonMapping|ReplacedMapping|null}
 */
export function findServiceMapping(image) {
  const normalized = image
    .toLowerCase()
    .replace(/^docker\.io\//, '')
    .replace(/^library\//, '');
  return SERVICE_MAPPINGS.find(({ pattern }) => pattern.test(normalized))?.mapping ?? null;
}

/**
 * Guess which add-on variable a docker-compose / .env variable should point to
 * @param {string} variableName
 * @returns {string|null} role in AddonMapping.variables
 */
export function guessVariableRole(variableName) {
  const name = variableName.toUpperCase();
  if (/(_URL|_URI|_DSN|CONNECTION_STRING)$/.test(name) || name === 'DATABASE_URL') {
    return 'uri';
  }
  if (/(HOST|HOSTNAME|SERVER|ADDR)$/.test(name)) {
    return 'host';
  }
  if (/PORT$/.test(name)) {
    return 'port';
  }
  if (/(_DB|_DATABASE|_NAME|DBNAME)$/.test(name)) {
    return 'database';
  }
  if (/(USER|USERNAME|LOGIN)$/.test(name)) {
    return 'user';
  }
  if (/(PASSWORD|PASS|PWD)$/.test(name)) {
    return 'password';
  }
  if (/(ACCESS_KEY|ACCESS_KEY_ID|KEY_ID)$/.test(name)) {
    return 'accessKey';
  }
  if (/(SECRET_KEY|SECRET_ACCESS_KEY|KEY_SECRET)$/.test(name)) {
    return 'secretKey';
  }
  return null;
}

/** Hosting-provider specific files and how they translate */
export const FOREIGN_PLATFORM_FILES = [
  { file: 'Procfile', platform: 'Heroku / Scalingo' },
  { file: 'app.json', platform: 'Heroku', mustContain: '"buildpacks"' },
  { file: 'heroku.yml', platform: 'Heroku' },
  { file: 'scalingo.json', platform: 'Scalingo' },
  { file: 'fly.toml', platform: 'Fly.io' },
  { file: 'render.yaml', platform: 'Render' },
  { file: 'railway.json', platform: 'Railway' },
  { file: 'railway.toml', platform: 'Railway' },
  { file: 'vercel.json', platform: 'Vercel' },
  { file: 'netlify.toml', platform: 'Netlify' },
  { file: 'app.yaml', platform: 'Google App Engine', mustContain: 'runtime:' },
  { file: 'nixpacks.toml', platform: 'Nixpacks' },
  { file: 'Dockerrun.aws.json', platform: 'AWS Elastic Beanstalk' },
  { file: 'serverless.yml', platform: 'Serverless Framework' },
];
