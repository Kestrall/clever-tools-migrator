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
 * @param {{ type?: string|null, appName?: string|null }} [options]
 * @returns {MigrationReport}
 */
export function analyzeProject(projectPath, options = {}) {
  const scanner = new ProjectScanner(projectPath);
  const appName = options.appName ?? (slugify(path.basename(scanner.root)).toLowerCase() || 'my-app');
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

  checkForeignPlatforms(scanner, report, runtimeType);
  checkSourceCode(scanner, report, runtimeType);

  return report;
}
