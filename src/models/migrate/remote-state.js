import fs from 'node:fs/promises';
import path from 'node:path';
import * as Addon from '../addon.js';

const TIMEOUT_MS = 10_000;

/**
 * @typedef {object} RemoteState
 * @property {string} appAlias
 * @property {Array<{ name: string, provider: string, isLinked: boolean }>} addons add-ons of the organisation
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
    /** @type {Array<any>} */
    const addons = await withTimeout(Addon.list(app.org_id, app.app_id, true));
    return {
      state: {
        appAlias: app.alias ?? app.name,
        addons: addons.map((addon) => ({
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
