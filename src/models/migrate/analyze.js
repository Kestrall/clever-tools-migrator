import path from 'node:path';
import { slugify } from '../../lib/slugify.js';
import { ProjectScanner } from './project-scanner.js';
import { MigrationReport } from './report.js';
import { checkDatabases } from './rules/database.js';
import { checkCompose, checkDockerfile, findComposeFile, findDockerfile } from './rules/docker.js';
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
  report.detected = [
    ...(dockerfilePath != null ? [`Dockerfile (${dockerfilePath})`] : []),
    ...(composePath != null ? [`Docker Compose (${composePath})`] : []),
    ...runtimes.map((runtime) => `${runtime.type} (${runtime.reason})`),
  ];

  // An existing Dockerfile is the most faithful way to reproduce what already works
  if (options.type != null) {
    report.runtime = { type: options.type, reason: 'Forced with --type', alternatives: [] };
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

  // The tables may already be there: the reminder stays, as information
  for (const finding of report.findings.filter((candidate) => candidate.id === 'database.import-data')) {
    if (report.addons.some((addon) => addon.existing != null && addon.name === finding.location)) {
      finding.severity = 'info';
      finding.title = `Make sure the schema and data are imported into the ${finding.location} add-on`;
    }
  }
}
