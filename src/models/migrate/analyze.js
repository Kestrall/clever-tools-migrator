import path from 'node:path';
import { slugify } from '../../lib/slugify.js';
import { ProjectScanner } from './project-scanner.js';
import { MigrationReport } from './report.js';
import { checkDatabases } from './rules/database.js';
import {
  checkCompose,
  checkDockerfile,
  findComposeFile,
  findDevelopmentImageReason,
  findDockerfile,
} from './rules/docker.js';
import { checkForeignPlatforms, checkRepository, checkSourceCode } from './rules/general.js';
import { checkRuntime, detectRuntimes } from './rules/runtimes.js';

/**
 * Analyze a project and list what must change to run it on Clever Cloud
 * @param {string} projectPath
 * @param {{ type?: string|null, appName?: string|null, remote?: import('./remote-state.js').RemoteState|null }} [options]
 * @returns {MigrationReport}
 */
export function analyzeProject(projectPath, options = {}) {
  const scanner = new ProjectScanner(projectPath);
  // An application already linked with `clever link` / `clever create` keeps its name
  const linkedAlias = scanner.readJson('.clever.json')?.apps?.[0]?.alias;
  const appName =
    options.appName ??
    (typeof linkedAlias === 'string' ? linkedAlias : null) ??
    (slugify(path.basename(scanner.root)).toLowerCase() || 'my-app');
  const report = new MigrationReport(scanner.root, appName);

  if (scanner.files.length === 0) {
    report.add({ id: 'project.empty', severity: 'blocker', title: `No file found in ${scanner.root}` });
    return report;
  }
  if (scanner.truncated) {
    report.add({
      id: 'project.truncated',
      severity: 'info',
      title: 'Large project: only the first files were analyzed',
    });
  }

  const dockerfilePath = findDockerfile(scanner);
  const composePath = findComposeFile(scanner);
  const runtimes = detectRuntimes(scanner);
  const developmentImage = dockerfilePath != null ? findDevelopmentImageReason(scanner, dockerfilePath) : null;
  report.detected = [
    ...(dockerfilePath != null ? [`Dockerfile (${dockerfilePath})`] : []),
    ...(composePath != null ? [`Docker Compose (${composePath})`] : []),
    ...runtimes.map((runtime) => `${runtime.type} (${runtime.reason})`),
  ];

  // An existing Dockerfile is the most faithful way to reproduce what already works
  if (options.type != null) {
    report.runtime = { type: options.type, reason: 'Forced with --type', alternatives: [] };
  } else if (dockerfilePath != null && developmentImage != null && runtimes.length > 0) {
    // The Dockerfile is a local development tool: the native runtime runs the real application
    report.runtime = {
      type: runtimes[0].type,
      reason: `${runtimes[0].reason}, ${dockerfilePath} is a development image`,
      alternatives: ['docker'],
    };
  } else if (dockerfilePath != null) {
    report.runtime = {
      type: 'docker',
      reason: `${dockerfilePath} found`,
      alternatives: runtimes.map((runtime) => runtime.type),
    };
  } else if (runtimes.length > 0) {
    report.runtime = {
      type: runtimes[0].type,
      reason: runtimes[0].reason,
      alternatives: runtimes.slice(1).map((runtime) => runtime.type),
    };
  }
  const runtimeType = report.runtime.type;

  checkRepository(scanner, report);

  if (runtimeType == null) {
    report.add({
      id: 'runtime.unknown',
      severity: 'blocker',
      title: 'Unable to detect how to build and run this project',
      fix: ['Add a Dockerfile, or force the runtime with `--type`'],
    });
  } else if (runtimeType === 'docker') {
    if (dockerfilePath == null) {
      report.add({
        id: 'docker.missing',
        severity: 'blocker',
        title: 'Docker runtime selected but no Dockerfile found',
      });
    } else {
      checkDockerfile(scanner, report, dockerfilePath);
      if (developmentImage != null) {
        report.add({
          id: 'docker.dev-image',
          severity: 'blocker',
          title: `The image cannot serve the application: ${developmentImage}`,
          location: dockerfilePath,
          fix: [
            runtimes.length > 0
              ? `Use the native runtime: \`clever migrate --type ${runtimes[0].type}\``
              : 'Write a production Dockerfile that copies the code and starts an HTTP server on port 8080',
          ],
        });
      }
    }
    const nativeRuntime = runtimes[0]?.type;
    if (nativeRuntime != null) {
      report.add({
        id: 'runtime.native-alternative',
        severity: 'info',
        title: `A native ${nativeRuntime} runtime is also possible`,
        details: `Native runtimes give faster builds, build cache and FS Buckets. Run again with \`--type ${nativeRuntime}\` to see what it would require.`,
      });
    }
  } else {
    checkRuntime(runtimeType, scanner, report);
    if (developmentImage != null) {
      report.add({
        id: 'runtime.docker-dev-image',
        severity: 'info',
        title: `The Dockerfile is not used: ${developmentImage}`,
        details: `The native ${runtimeType} runtime of Clever Cloud builds and serves the application instead.`,
        location: dockerfilePath ?? undefined,
      });
    }
  }

  if (composePath != null) {
    checkCompose(scanner, report, composePath, { isDockerRuntime: runtimeType === 'docker' });
  }

  checkDatabases(scanner, report);
  if (options.remote != null) {
    applyRemoteState(report, options.remote);
  }

  checkForeignPlatforms(scanner, report, runtimeType);
  checkSourceCode(scanner, report, runtimeType);

  return report;
}

/** Findings asking to create an add-on */
const ADDON_CREATION_FINDINGS = new Set(['database.addon', 'compose.service-to-addon']);

/**
 * Take what already exists on Clever Cloud into account: linked add-ons are not to be created again
 * @param {MigrationReport} report
 * @param {import('./remote-state.js').RemoteState} remote
 */
function applyRemoteState(report, remote) {
  for (const addon of report.addons) {
    const existing =
      remote.addons.find((candidate) => candidate.provider === addon.provider && candidate.isLinked) ??
      remote.addons.find((candidate) => candidate.name === addon.name);
    if (existing == null) {
      continue;
    }
    // Keep the real name everywhere: setup script, data script, rewired variables
    for (const variable of report.rewired.filter((candidate) => candidate.addonName === addon.name)) {
      variable.addonName = existing.name;
    }
    for (const database of report.databases.filter((candidate) => candidate.addonName === addon.name)) {
      database.addonName = existing.name;
    }
    const plannedName = addon.name;
    addon.name = existing.name;
    for (const finding of report.findings.filter((candidate) => candidate.location === plannedName)) {
      finding.location = existing.name;
    }
    addon.existing = existing.isLinked ? 'linked' : 'unlinked';

    report.findings = report.findings.filter(
      (finding) =>
        !(ADDON_CREATION_FINDINGS.has(finding.id) && (finding.fix ?? []).some((fix) => fix.includes(plannedName))),
    );
    if (existing.isLinked) {
      report.add({
        id: 'remote.addon-linked',
        severity: 'info',
        title: `The ${addon.label} add-on ${existing.name} already exists and is linked to ${remote.appAlias}`,
      });
    } else {
      report.add({
        id: 'remote.addon-unlinked',
        severity: 'warning',
        title: `The ${addon.label} add-on ${existing.name} exists but is not linked to ${remote.appAlias}: its variables are not injected`,
        fix: [`\`clever service link-addon ${existing.name} --alias ${remote.appAlias}\``],
      });
    }
  }

  if (remote.appType != null && report.runtime.type != null && isTypeMismatch(remote.appType, report.runtime.type)) {
    // A new application will be created: what is set on the old one does not count
    report.add({
      id: 'remote.app-type',
      severity: 'blocker',
      title: `${remote.appAlias} is a ${remote.appType} application on Clever Cloud, the project needs ${report.runtime.type}`,
      details: 'The type of an application cannot change.',
      fix: [
        `\`clever migrate apply\` then \`./clever-setup.sh\` creates ${remote.appAlias}-${report.runtime.type} and keeps ${remote.appAlias} untouched`,
      ],
    });
  } else {
    applyRemoteEnv(report, remote.env);
  }

  // The tables may already be there: the reminder stays, as information
  for (const finding of report.findings.filter((candidate) => candidate.id === 'database.import-data')) {
    if (report.addons.some((addon) => addon.existing != null && addon.name === finding.location)) {
      finding.severity = 'info';
      finding.title = `Make sure the schema and data are imported into the ${finding.location} add-on`;
    }
  }
}

/** Clever Cloud types whose application variant has another name */
const JAVA_TYPES = new Set(['jar', 'maven', 'gradle', 'war', 'sbt', 'play1', 'play2']);

/**
 * @param {string} remoteType
 * @param {string} plannedType
 * @returns {boolean}
 */
function isTypeMismatch(remoteType, plannedType) {
  if (JAVA_TYPES.has(plannedType)) {
    return remoteType === 'docker';
  }
  return remoteType !== plannedType;
}

/** Findings solved as soon as the variable has a value on the application */
const SECRET_FINDINGS = {
  'php.symfony-secret': 'APP_SECRET',
  'php.laravel-key': 'APP_KEY',
  'ruby.rails-secret': 'SECRET_KEY_BASE',
};

/**
 * Remove what the application on Clever Cloud already has: the report then shows what is really left
 * @param {MigrationReport} report
 * @param {Record<string, string>} env
 */
function applyRemoteEnv(report, env = {}) {
  if (Object.keys(env).length === 0) {
    return;
  }
  const isSet = (/** @type {string} */ name, /** @type {string} */ value) => env[name] === value;

  for (const [name, { value }] of Object.entries(report.env)) {
    if (isSet(name, value)) {
      delete report.env[name];
    }
  }
  // A rewired variable is done when its remote value no longer points to a local host or a compose service
  report.rewired = report.rewired.filter(
    (variable) =>
      env[variable.name] == null ||
      (/(localhost|127\.0\.0\.1|@\w+:\d|^\w+$)/.test(env[variable.name]) && env[variable.name] === variable.value),
  );

  report.findings = report.findings.filter((finding) => {
    const secret = SECRET_FINDINGS[/** @type {keyof typeof SECRET_FINDINGS} */ (finding.id)];
    if (secret != null) {
      return (env[secret] ?? '') === '';
    }
    if (finding.id === 'compose.service-hostnames' || finding.id === 'database.env-rewired') {
      return report.rewired.length > 0;
    }
    if (finding.id === 'env.dotenv' || finding.id === 'env.dotenv-committed') {
      return !report.envFilesToImport.some((file) => file.startsWith('.env'));
    }
    if (finding.id === 'env.dev-values') {
      return report.devValues.some((devValue) => env[devValue.name] == null || env[devValue.name] === devValue.value);
    }
    // Findings fixed by `clever env set NAME value` commands
    const commands = (finding.fix ?? [])
      .map((fix) => /`clever env set (\w+) ([^`]+)`/.exec(fix))
      .filter((match) => match != null);
    if (commands.length > 0 && commands.every((match) => isSet(match[1], unquote(match[2])))) {
      return false;
    }
    return true;
  });

  // Once the services are replaced, docker-compose is only a local development tool
  const composeLeft = report.findings.some(
    (finding) =>
      finding.id.startsWith('compose.') && finding.id !== 'compose.not-supported' && finding.severity !== 'info',
  );
  for (const finding of report.findings.filter((candidate) => candidate.id === 'compose.not-supported')) {
    if (!composeLeft) {
      finding.severity = 'info';
      finding.title = `${finding.location} stays for local development: its services are replaced on Clever Cloud`;
      finding.details = undefined;
    }
  }
}

/**
 * @param {string} value
 * @returns {string}
 */
function unquote(value) {
  const trimmed = value.trim();
  if (/^(['"]).*\1$/.test(trimmed)) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}
