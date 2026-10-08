import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createAddons, parseAddonRequests, planAddons } from '../../src/models/init/addons.js';
import { STARTER_TEMPLATES } from '../../src/models/init/templates.js';

/** Plans of the Clever Cloud API (2026-10), prices in € per month */
const PROVIDERS = {
  'postgresql-addon': {
    regions: ['par', 'rbx'],
    plans: [
      { slug: 'xxs_sml', price: 5.25 },
      { slug: 'dev', price: 0 },
    ],
  },
  'mysql-addon': { regions: ['par'], plans: [{ slug: 'dev', price: 0 }] },
  'redis-addon': { regions: ['par'], plans: [{ slug: 's_mono', price: 5 }] },
};

const api = {
  /** @param {string} provider */
  getProvider: async (provider) => /** @type {any} */ (PROVIDERS)[provider],
};

const context = { ownerId: 'user_1', region: 'par', appName: 'monapp', acceptPaidPlans: false };

describe('clever init --addon', () => {
  it('accepts the database names, their aliases and a plan', () => {
    const requests = parseAddonRequests(['PG', 'mysql', 'mongo', 'redis:M_MONO', 'es'], 'node');
    assert.deepEqual(
      requests.map(({ key, provider, plan }) => [key, provider, plan]),
      [
        ['postgresql', 'postgresql-addon', null],
        ['mysql', 'mysql-addon', null],
        ['mongodb', 'mongodb-addon', null],
        ['redis', 'redis-addon', 'm_mono'],
        ['elasticsearch', 'es-addon', null],
      ],
    );
    assert.deepEqual(requests[0].variables.slice(0, 2), ['POSTGRESQL_ADDON_URI', 'POSTGRESQL_ADDON_HOST']);
  });

  it('rejects unknown databases, duplicates and static applications', () => {
    assert.throws(() => parseAddonRequests(['oracle'], 'node'), /Unknown add-on "oracle".*postgresql, mysql/);
    assert.throws(() => parseAddonRequests(['pg:'], 'node'), /Unknown add-on/);
    assert.throws(() => parseAddonRequests(['pg', 'postgresql'], 'node'), /--addon postgresql is given twice/);
    assert.throws(() => parseAddonRequests(['pg'], 'static'), /no server-side code/);
    assert.deepEqual(parseAddonRequests([], 'static'), []);
  });

  it('picks the cheapest plan and names the add-on after the application', async () => {
    const [postgresql] = await planAddons(parseAddonRequests(['pg'], 'node'), context, api);
    assert.equal(postgresql.name, 'monapp-postgresql');
    assert.equal(postgresql.planSlug, 'dev');
    assert.equal(postgresql.price, 0);
  });

  it('refuses paid plans without --yes, before anything is created', async () => {
    await assert.rejects(
      planAddons(parseAddonRequests(['pg', 'redis'], 'node'), context, api),
      /not free: Redis \(s_mono\): 5 € per month\. Run again with --yes/,
    );
    await assert.rejects(
      planAddons(parseAddonRequests(['pg:xxs_sml'], 'node'), context, api),
      /PostgreSQL \(xxs_sml\): 5\.25 € per month/,
    );
    const planned = await planAddons(parseAddonRequests(['redis'], 'node'), { ...context, acceptPaidPlans: true }, api);
    assert.equal(planned[0].planSlug, 's_mono');
  });

  it('rejects unknown plans and unavailable regions', async () => {
    await assert.rejects(
      planAddons(parseAddonRequests(['pg:huge'], 'node'), context, api),
      /Unknown plan "huge" for PostgreSQL, cheapest plans: dev \(free\), xxs_sml \(5\.25 € per month\)$/,
    );
    await assert.rejects(
      planAddons(parseAddonRequests(['mysql'], 'node'), { ...context, region: 'rbx' }, api),
      /MySQL is not available in region rbx/,
    );
  });

  it('creates and links each add-on, and lists what is left when one fails', async () => {
    const planned = await planAddons(parseAddonRequests(['pg', 'mysql'], 'node'), context, api);
    /** @type {string[]} */
    const calls = [];
    const working = {
      create: async (/** @type {any} */ addon) => {
        calls.push(`create ${addon.name} ${addon.planName}`);
        return { id: `addon_${addon.name}` };
      },
      link: async (/** @type {string} */ _ownerId, /** @type {string} */ appId, /** @type {any} */ addon) => {
        calls.push(`link ${addon.addon_id} ${appId}`);
      },
    };
    const created = await createAddons(
      planned,
      { ownerId: 'user_1', id: 'app_1' },
      'par',
      /** @type {any} */ (working),
    );
    assert.deepEqual(calls, [
      'create monapp-postgresql dev',
      'link addon_monapp-postgresql app_1',
      'create monapp-mysql dev',
      'link addon_monapp-mysql app_1',
    ]);
    assert.equal(created.length, 2);

    const failing = {
      ...working,
      create: async () => {
        throw new Error('quota reached');
      },
    };
    await assert.rejects(
      createAddons(planned, { ownerId: 'user_1', id: 'app_1' }, 'par', /** @type {any} */ (failing)),
      /PostgreSQL add-on could not be created: quota reached\n.*clever addon create postgresql-addon monapp-postgresql --plan dev[^\n]*\nclever addon create mysql-addon monapp-mysql/s,
    );
  });

  it('describes the linked add-ons in the welcome page and the README', () => {
    const addons = [{ label: 'PostgreSQL', variables: ['POSTGRESQL_ADDON_URI', 'POSTGRESQL_ADDON_HOST'] }];
    const files = STARTER_TEMPLATES.python.files('monapp', addons);
    assert.match(
      files['app.py'],
      /<li>PostgreSQL: <code>POSTGRESQL_ADDON_URI<\/code>, <code>POSTGRESQL_ADDON_HOST<\/code><\/li>/,
    );
    assert.match(files['README.md'], /## Add-ons/);
    assert.match(files['README.md'], /os\.environ\["POSTGRESQL_ADDON_URI"\]/);
    assert.doesNotMatch(STARTER_TEMPLATES.python.files('monapp')['README.md'], /## Add-ons/);
  });

  it('keeps the exported credentials out of git in every starter', () => {
    for (const [runtime, template] of Object.entries(STARTER_TEMPLATES)) {
      assert.match(template.files('monapp')['.gitignore'], /^\.env\.clever$/m, runtime);
    }
  });
});
