/**
 * @typedef {'blocker'|'warning'|'info'} Severity
 */

/**
 * @typedef {object} Finding
 * @property {string} id stable identifier of the check
 * @property {Severity} severity
 * @property {string} title
 * @property {string} [details]
 * @property {string} [location] file or file:line
 * @property {string[]} [fix] actions to take, commands are wrapped in backquotes
 */

/**
 * @typedef {object} PlannedAddon
 * @property {string} provider
 * @property {string} name
 * @property {string} label
 * @property {string} [fromService] docker-compose service it replaces
 */

/**
 * @typedef {object} PlannedApp
 * @property {string} name
 * @property {string} type
 * @property {string} reason
 * @property {Record<string, string>} env
 * @property {boolean} [linkAddons] whether the planned add-ons must also be linked to this application
 */

export const SEVERITY_ORDER = /** @type {const} */ (['blocker', 'warning', 'info']);

export class MigrationReport {
  /**
   * @param {string} projectPath
   * @param {string} appName
   */
  constructor(projectPath, appName) {
    this.projectPath = projectPath;
    this.appName = appName;
    /** @type {{ type: string|null, reason: string, alternatives: string[] }} */
    this.runtime = { type: null, reason: 'No supported runtime detected', alternatives: [] };
    /** @type {string[]} */
    this.detected = [];
    /** @type {Finding[]} */
    this.findings = [];
    /** @type {PlannedAddon[]} */
    this.addons = [];
    /** @type {Record<string, { value: string, reason: string }>} */
    this.env = {};
    /** @type {Array<{ path: string, content: string, reason: string }>} */
    this.files = [];
    /** @type {PlannedApp[]} */
    this.extraApps = [];
    /** @type {string[]} */
    this.envFilesToImport = [];
  }

  /**
   * @param {Finding} finding
   */
  add(finding) {
    if (!this.findings.some((existing) => existing.id === finding.id && existing.location === finding.location)) {
      this.findings.push(finding);
    }
  }

  /**
   * @param {string} id
   * @returns {boolean}
   */
  hasFinding(id) {
    return this.findings.some((finding) => finding.id === id);
  }

  /**
   * First definition wins, so specific rules should run before generic ones
   * @param {string} name
   * @param {string} value
   * @param {string} reason
   */
  setEnv(name, value, reason) {
    if (this.env[name] == null) {
      this.env[name] = { value, reason };
    }
  }

  /**
   * @param {Omit<PlannedAddon, 'name'> & { suffix?: string }} addon
   * @returns {PlannedAddon}
   */
  addAddon({ provider, label, fromService, suffix }) {
    const existing = this.addons.find((addon) => addon.provider === provider);
    if (existing != null) {
      return existing;
    }
    const planned = {
      provider,
      label,
      fromService,
      name: `${this.appName}-${suffix ?? provider.replace(/-?addon-?/, '')}`,
    };
    this.addons.push(planned);
    return planned;
  }

  /**
   * @param {string} path
   * @param {string} content
   * @param {string} reason
   */
  addFile(path, content, reason) {
    if (!this.files.some((file) => file.path === path)) {
      this.files.push({ path, content, reason });
    }
  }

  /**
   * @returns {{ blocker: number, warning: number, info: number }}
   */
  get counts() {
    return {
      blocker: this.findings.filter((finding) => finding.severity === 'blocker').length,
      warning: this.findings.filter((finding) => finding.severity === 'warning').length,
      info: this.findings.filter((finding) => finding.severity === 'info').length,
    };
  }

  /**
   * Rough readiness indicator, 100 means "deployable as is"
   * @returns {number}
   */
  get score() {
    const { blocker, warning } = this.counts;
    return Math.max(0, 100 - blocker * 25 - warning * 8);
  }

  /**
   * Ordered list of shell commands to perform the migration
   * @returns {string[]}
   */
  get commands() {
    const commands = [];
    if (this.runtime.type != null) {
      commands.push(`clever create --type ${this.runtime.type} ${shellQuote(this.appName)}`);
    }
    for (const addon of this.addons) {
      commands.push(
        `clever addon create ${addon.provider} ${shellQuote(addon.name)} --link ${shellQuote(this.appName)}`,
      );
    }
    for (const file of this.envFilesToImport) {
      commands.push(`clever env import < ${shellQuote(file)}`);
    }
    for (const [name, { value }] of Object.entries(this.env)) {
      commands.push(`clever env set ${name} ${shellQuote(value)}`);
    }
    for (const app of this.extraApps) {
      commands.push(`clever create --type ${app.type} ${shellQuote(app.name)} --alias ${shellQuote(app.name)}`);
      for (const [name, value] of Object.entries(app.env)) {
        commands.push(`clever env set ${name} ${shellQuote(value)} --alias ${shellQuote(app.name)}`);
      }
      if (app.linkAddons) {
        for (const addon of this.addons) {
          commands.push(`clever service link-addon ${shellQuote(addon.name)} --alias ${shellQuote(app.name)}`);
        }
      }
    }
    if (this.runtime.type != null) {
      commands.push('git add . && git commit -m "Prepare deployment on Clever Cloud"');
      commands.push('clever deploy');
    }
    return commands;
  }

  toJSON() {
    const severityRank = (/** @type {Finding} */ finding) => SEVERITY_ORDER.indexOf(finding.severity);
    return {
      projectPath: this.projectPath,
      appName: this.appName,
      runtime: this.runtime,
      detected: this.detected,
      score: this.score,
      counts: this.counts,
      findings: [...this.findings].sort((a, b) => severityRank(a) - severityRank(b)),
      plan: {
        addons: this.addons,
        env: Object.fromEntries(Object.entries(this.env).map(([name, { value }]) => [name, value])),
        envDetails: this.env,
        envFilesToImport: this.envFilesToImport,
        files: this.files,
        extraApps: this.extraApps,
        commands: this.commands,
      },
    };
  }
}

/**
 * @param {string} value
 * @returns {string}
 */
export function shellQuote(value) {
  if (/^[\w./:@%+=,-]+$/.test(value)) {
    return value;
  }
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
