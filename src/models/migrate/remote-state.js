import { getAllEnvVars } from '@clevercloud/client/esm/api/v2/application.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import * as Addon from '../addon.js';
import * as Application from '../application.js';
import { sendToApi } from '../send-to-api.js';

const TIMEOUT_MS = 10_000;

/**
 * @typedef {object} RemoteState
 * @property {string} appAlias
 * @property {Array<{ name: string, provider: string, isLinked: boolean }>} addons add-ons of the organisation
 * @property {string|null} [appType] instance type of the linked application (php, docker...)
 * @property {Record<string, string>} [env] environment variables of the linked application
 */

/**
 * What already exists on Clever Cloud for the application linked in .clever.json.
 * Best effort: any failure (not logged in, offline...) returns the reason instead of throwing.
 * @param {string} root
 * @returns {Promise<{ state: RemoteState|null, error: string|null }>}
 */
export async function fetchRemoteState(root) {
  const config = await fs
    .readFile(path.join(root, '.clever.json'), 'utf8')
    .then((content) => JSON.parse(content))
    .catch(() => null);
  const app = config?.apps?.[0];
  if (app?.app_id == null || app?.org_id == null) {
    return { state: null, error: null };
  }
  try {
    const [addons, application, env] = await withTimeout(
      Promise.all([
        Addon.list(app.org_id, app.app_id, true),
        Application.get(app.org_id, app.app_id),
        getAllEnvVars({ id: app.org_id, appId: app.app_id }).then(sendToApi),
      ]),
    );
    return {
      state: {
        appAlias: app.alias ?? app.name,
        appType: application?.instance?.variant?.slug ?? null,
        env: Object.fromEntries((env ?? []).map((/** @type {any} */ variable) => [variable.name, variable.value])),
        addons: addons.map((/** @type {any} */ addon) => ({
          name: addon.name,
          provider: addon.provider?.id,
          isLinked: addon.isLinked === true,
        })),
      },
      error: null,
    };
  } catch (error) {
    return { state: null, error: error?.message ?? String(error) };
  }
}

/**
 * @template T
 * @param {Promise<T>} promise
 * @returns {Promise<T>}
 */
function withTimeout(promise) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Clever Cloud API did not answer in time')), TIMEOUT_MS).unref(),
    ),
  ]);
}
