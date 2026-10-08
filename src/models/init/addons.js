import * as Addon from '../addon.js';
import { getAddonMapping } from '../migrate/catalog.js';

/**
 * Databases `clever init --addon` can create, with the names accepted on the command line
 * @type {Record<string, { provider: string, aliases: string[] }>}
 */
export const DATABASE_ADDONS = {
  postgresql: { provider: 'postgresql-addon', aliases: ['postgres', 'pg'] },
  mysql: { provider: 'mysql-addon', aliases: [] },
  mongodb: { provider: 'mongodb-addon', aliases: ['mongo'] },
  redis: { provider: 'redis-addon', aliases: [] },
  elasticsearch: { provider: 'es-addon', aliases: ['es'] },
};

/** Plans listed when the requested one does not exist, the cheapest first */
const MAX_LISTED_PLANS = 8;

/** Runtimes without server-side code cannot connect to a database */
const RUNTIMES_WITHOUT_SERVER = new Set(['static']);

/**
 * @typedef {object} AddonRequest
 * @property {string} key name in DATABASE_ADDONS
 * @property {string} provider provider id for the Clever Cloud API
 * @property {string|null} plan plan slug asked with `--addon <database>:<plan>`, the cheapest one if null
 * @property {string} label
 * @property {string[]} variables environment variables injected in the application
 */

/**
 * @typedef {AddonRequest & { name: string, planSlug: string, price: number }} PlannedAddon
 */

/**
 * @param {string[]} values `--addon` values, e.g. ["postgresql", "redis:m_mono"]
 * @param {string} runtime
 * @returns {AddonRequest[]}
 */
export function parseAddonRequests(values, runtime) {
  if (values.length > 0 && RUNTIMES_WITHOUT_SERVER.has(runtime)) {
    throw new Error(
      `A ${runtime} application has no server-side code to connect to a database, --addon is not available`,
    );
  }
  /** @type {AddonRequest[]} */
  const requests = [];
  for (const value of values) {
    const [rawKey, plan, ...rest] = value.trim().toLowerCase().split(':');
    const key = findDatabaseKey(rawKey);
    if (key == null || rest.length > 0 || plan === '') {
      throw new Error(
        `Unknown add-on "${value}", use --addon <database>[:<plan>] with one of: ${Object.keys(DATABASE_ADDONS).join(', ')}`,
      );
    }
    if (requests.some((request) => request.key === key)) {
      throw new Error(`--addon ${key} is given twice`);
    }
    const { provider } = DATABASE_ADDONS[key];
    const mapping = getAddonMapping(provider);
    requests.push({
      key,
      provider,
      plan: plan ?? null,
      label: mapping?.label ?? key,
      variables: Object.values(mapping?.variables ?? {}),
    });
  }
  return requests;
}

/**
 * @param {string} name
 * @returns {string|null}
 */
function findDatabaseKey(name) {
  for (const [key, { aliases }] of Object.entries(DATABASE_ADDONS)) {
    if (key === name || aliases.includes(name)) {
      return key;
    }
  }
  return null;
}

/**
 * Resolve the plan of each add-on and check the region, before anything is created
 * @param {AddonRequest[]} requests
 * @param {object} context
 * @param {string} context.ownerId
 * @param {string} context.region
 * @param {string} context.appName
 * @param {boolean} context.acceptPaidPlans
 * @param {Pick<typeof Addon, 'getProvider'>} [api] Clever Cloud API, replaced in tests
 * @returns {Promise<PlannedAddon[]>}
 */
export async function planAddons(requests, { ownerId, region, appName, acceptPaidPlans }, api = Addon) {
  /** @type {PlannedAddon[]} */
  const planned = [];
  for (const request of requests) {
    const provider = await api.getProvider(request.provider, ownerId);
    if (!provider.regions.includes(region)) {
      throw new Error(
        `${request.label} is not available in region ${region}, available regions: ${provider.regions.join(', ')}`,
      );
    }
    const plan = choosePlan(request, provider.plans);
    planned.push({ ...request, name: `${appName}-${request.key}`, planSlug: plan.slug, price: plan.price });
  }

  const paid = planned.filter((addon) => addon.price > 0);
  if (paid.length > 0 && !acceptPaidPlans) {
    const list = paid.map((addon) => `${addon.label} (${addon.planSlug}): ${formatPrice(addon.price)}`).join(', ');
    throw new Error(
      `These add-ons are not free: ${list}. Run again with --yes to create them, nothing has been created`,
    );
  }
  return planned;
}

/**
 * @param {AddonRequest} request
 * @param {Array<{ slug: string, price: number }>} plans
 * @returns {{ slug: string, price: number }}
 */
function choosePlan(request, plans) {
  if (plans.length === 0) {
    throw new Error(`No plan available for ${request.label}`);
  }
  if (request.plan == null) {
    return [...plans].sort((a, b) => a.price - b.price)[0];
  }
  const plan = plans.find((candidate) => candidate.slug.toLowerCase() === request.plan);
  if (plan == null) {
    const cheapest = [...plans].sort((a, b) => a.price - b.price);
    const shown = cheapest
      .slice(0, MAX_LISTED_PLANS)
      .map((candidate) => `${candidate.slug} (${formatPrice(candidate.price)})`)
      .join(', ');
    const more =
      cheapest.length > MAX_LISTED_PLANS
        ? `, ... (${cheapest.length} plans, see \`clever addon providers show ${request.provider}\`)`
        : '';
    throw new Error(`Unknown plan "${request.plan}" for ${request.label}, cheapest plans: ${shown}${more}`);
  }
  return plan;
}

/**
 * @param {number} price
 * @returns {string}
 */
export function formatPrice(price) {
  return price === 0 ? 'free' : `${price} € per month`;
}

/**
 * Create the add-ons and link them to the application
 * @param {PlannedAddon[]} addons
 * @param {object} app
 * @param {string} app.ownerId
 * @param {string} app.id
 * @param {string} region
 * @param {Pick<typeof Addon, 'create'|'link'>} [api] Clever Cloud API, replaced in tests
 * @returns {Promise<Array<PlannedAddon & { id: string }>>}
 */
export async function createAddons(addons, app, region, api = Addon) {
  const created = [];
  for (const addon of addons) {
    let newAddon;
    try {
      newAddon = await api.create({
        ownerId: app.ownerId,
        name: addon.name,
        providerName: addon.provider,
        planName: addon.planSlug,
        region,
        version: undefined,
        addonOptions: {},
      });
    } catch (error) {
      throw new Error(
        `The ${addon.label} add-on could not be created: ${error.message}\n${remainingCommands(addons, addon, region)}`,
      );
    }
    try {
      await api.link(app.ownerId, app.id, { addon_id: newAddon.id });
    } catch (error) {
      throw new Error(
        `The ${addon.label} add-on ${addon.name} was created but could not be linked: ${error.message}\nLink it with \`clever service link-addon ${addon.name}\`\n${remainingCommands(addons, addons[addons.indexOf(addon) + 1], region)}`,
      );
    }
    created.push({ ...addon, id: newAddon.id });
  }
  return created;
}

/**
 * Commands creating the add-ons from `first` (included) to the end of the list
 * @param {PlannedAddon[]} addons
 * @param {PlannedAddon|undefined} first
 * @param {string} region
 * @returns {string}
 */
function remainingCommands(addons, first, region) {
  if (first == null) {
    return '';
  }
  const commands = addons
    .slice(addons.indexOf(first))
    .map(
      (addon) =>
        `clever addon create ${addon.provider} ${addon.name} --plan ${addon.planSlug} --region ${region} --link <alias>`,
    );
  return `Then create the remaining add-ons:\n${commands.join('\n')}`;
}
