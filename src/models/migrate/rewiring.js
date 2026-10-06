import { guessVariableRole } from './catalog.js';

/**
 * How to rebuild a variable from the variables of an add-on
 * @typedef {object} RewiringTarget
 * @property {string|null} addonVariable add-on variable holding the whole value
 * @property {string|null} driverScheme scheme to restore on a URI (postgresql+psycopg, mysql+pymysql...)
 * @property {string|null} query query string of the original URI to keep (?serverVersion=8.0&charset=utf8mb4)
 * @property {Record<string, string>|null} uriParts role → add-on variable, when the URI must be built from its parts
 * @property {string|null} scheme scheme of the built URI
 */

const URI_PATTERN = /^([a-z][a-z0-9+.-]*):\/\/[^?#\s]*(\?[^#\s]*)?/i;

/**
 * @param {import('./catalog.js').AddonMapping} mapping
 * @param {string} name
 * @param {string} value current value, used to keep the driver scheme and the query string
 * @returns {RewiringTarget}
 */
export function resolveRewiring(mapping, name, value) {
  const uri = URI_PATTERN.exec(value);
  const role = uri != null ? 'uri' : guessVariableRole(name);
  const empty = { addonVariable: null, driverScheme: null, query: null, uriParts: null, scheme: null };
  if (role == null) {
    return empty;
  }
  if (role !== 'uri') {
    return { ...empty, addonVariable: mapping.variables[role] ?? null };
  }

  const scheme = uri?.[1] ?? null;
  const query = keepQuery(uri?.[2] ?? null);
  // An add-on URI has a plain scheme (postgresql://), drivers like SQLAlchemy need theirs (postgresql+psycopg://)
  const driverScheme = scheme != null && scheme.includes('+') ? scheme : null;
  if (mapping.variables.uri != null) {
    return { ...empty, addonVariable: mapping.variables.uri, driverScheme, query };
  }
  const { host, port, database, user, password } = mapping.variables;
  if (host != null && port != null && database != null && user != null && password != null) {
    return {
      ...empty,
      query,
      scheme: scheme ?? mapping.provider.replace(/-addon$/, ''),
      uriParts: { host, port, database, user, password },
    };
  }
  return empty;
}

/**
 * Whether a rewired variable can be computed automatically
 * @param {{ addonName: string|null, addonVariable: string|null, uriParts?: Record<string, string>|null }} variable
 * @returns {boolean}
 */
export function isRewiringAutomatic(variable) {
  return variable.addonName != null && (variable.addonVariable != null || variable.uriParts != null);
}

/** Connection options tied to the local server, the add-on decides them */
const LOCAL_ONLY_PARAMETERS = new Set([
  'sslmode',
  'ssl',
  'sslcert',
  'sslkey',
  'sslrootcert',
  'socket',
  'unix_socket',
  'host',
  'port',
]);

/**
 * @param {string|null} query
 * @returns {string|null}
 */
function keepQuery(query) {
  if (query == null) {
    return null;
  }
  const kept = query
    .slice(1)
    .split('&')
    .filter((parameter) => parameter !== '' && !LOCAL_ONLY_PARAMETERS.has(parameter.split('=')[0].toLowerCase()));
  return kept.length > 0 ? `?${kept.join('&')}` : null;
}
