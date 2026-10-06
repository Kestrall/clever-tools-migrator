import { parse as parseYaml } from 'yaml';
import { findServiceMapping, guessVariableRole } from '../catalog.js';
import { analyzeDockerfile } from '../dockerfile.js';

const HTTP_PORT = 8080;
const COMPOSE_FILES = ['compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml'];

/**
 * @typedef {import('../project-scanner.js').ProjectScanner} ProjectScanner
 * @typedef {import('../report.js').MigrationReport} MigrationReport
 */

/**
 * @param {ProjectScanner} scanner
 * @returns {string|null}
 */
export function findDockerfile(scanner) {
  if (scanner.has('Dockerfile')) {
    return 'Dockerfile';
  }
  const candidates = scanner.find(/(^|\/)(Dockerfile(\.[\w-]+)?|[\w-]+\.Dockerfile|Containerfile)$/);
  // Prefer production-looking Dockerfiles, then the shallowest one
  const score = (/** @type {string} */ file) =>
    (/dev|test|local/i.test(file) ? 100 : 0) - (/prod/i.test(file) ? 10 : 0) + file.split('/').length;
  return candidates.sort((a, b) => score(a) - score(b))[0] ?? null;
}

/**
 * @param {ProjectScanner} scanner
 * @returns {string|null}
 */
export function findComposeFile(scanner) {
  return scanner.first(COMPOSE_FILES);
}

/**
 * Checks on the Dockerfile used by a Docker application
 * @param {ProjectScanner} scanner
 * @param {MigrationReport} report
 * @param {string} dockerfilePath
 * @returns {import('../dockerfile.js').DockerfileSummary|null}
 */
export function checkDockerfile(scanner, report, dockerfilePath) {
  const content = scanner.read(dockerfilePath);
  if (content == null) {
    return null;
  }
  const dockerfile = analyzeDockerfile(content);

  if (dockerfilePath !== 'Dockerfile') {
    report.setEnv('CC_DOCKERFILE', dockerfilePath, 'Dockerfile is not named "Dockerfile" at the root of the project');
    report.add({
      id: 'docker.dockerfile-location',
      severity: 'blocker',
      title: `Dockerfile found at ${dockerfilePath}, Clever Cloud builds ./Dockerfile by default`,
      location: dockerfilePath,
      fix: [`\`clever env set CC_DOCKERFILE ${dockerfilePath}\``],
    });
    const buildContext = dockerfilePath.split('/').slice(0, -1).join('/');
    if (buildContext !== '' && /^\s*(COPY|ADD)\s+(--\S+\s+)*\.\s/m.test(content)) {
      report.add({
        id: 'docker.build-context',
        severity: 'warning',
        title: 'The Dockerfile seems to expect its own folder as build context',
        details: `Clever Cloud runs the build from the repository root, so "COPY . ..." copies the whole repository, not only ${buildContext}/.`,
        location: dockerfilePath,
        fix: [
          'Adapt COPY/ADD paths to be relative to the repository root, or deploy that folder as its own repository',
        ],
      });
    }
  }

  if (!dockerfile.hasCmd && !dockerfile.hasEntrypoint) {
    report.add({
      id: 'docker.no-command',
      severity: 'warning',
      title: 'No CMD or ENTRYPOINT in the final stage',
      details: `The container will rely on the default command of the base image (${dockerfile.baseImages.at(-1) ?? 'unknown'}). Make sure it starts your application.`,
      location: dockerfilePath,
      fix: ['Add a CMD instruction that starts the application'],
    });
  }

  const envPort = parseInt(dockerfile.env.PORT ?? '', 10);
  const declaredPorts =
    dockerfile.exposedPorts.length > 0 ? dockerfile.exposedPorts : Number.isInteger(envPort) ? [envPort] : [];
  if (declaredPorts.length === 0) {
    report.add({
      id: 'docker.no-expose',
      severity: 'info',
      title: `No EXPOSE instruction: the application must listen on 0.0.0.0:${HTTP_PORT}`,
      location: dockerfilePath,
      fix: [`Add \`EXPOSE ${HTTP_PORT}\` and make the server listen on port ${HTTP_PORT}`],
    });
  } else if (!declaredPorts.includes(HTTP_PORT)) {
    const [httpPort, ...otherPorts] = declaredPorts;
    report.setEnv(
      'CC_DOCKER_EXPOSED_HTTP_PORT',
      String(httpPort),
      `The image listens on ${httpPort} instead of ${HTTP_PORT}`,
    );
    report.add({
      id: 'docker.http-port',
      severity: 'blocker',
      title: `The image exposes port ${httpPort}, Clever Cloud routes HTTP traffic to ${HTTP_PORT}`,
      location: dockerfilePath,
      fix: [
        `\`clever env set CC_DOCKER_EXPOSED_HTTP_PORT ${httpPort}\``,
        `or make the application listen on ${HTTP_PORT}`,
      ],
    });
    if (otherPorts.length > 0) {
      reportExtraPorts(report, otherPorts, dockerfilePath);
    }
  } else if (declaredPorts.length > 1) {
    reportExtraPorts(
      report,
      declaredPorts.filter((port) => port !== HTTP_PORT),
      dockerfilePath,
    );
  }

  if (dockerfile.volumes.length > 0) {
    report.add({
      id: 'docker.volume',
      severity: 'warning',
      title: `VOLUME ${dockerfile.volumes.join(', ')}: the filesystem is not persistent`,
      details:
        'Every deployment starts from a fresh container and FS Buckets are not available for Docker applications. Data written in these folders is lost on redeploy or scaling.',
      location: dockerfilePath,
      fix: [
        'Store files in Cellar (S3 compatible): `clever addon create cellar-addon <name> --link <app>`',
        'Store structured data in a database add-on',
      ],
    });
  }

  const argsWithoutDefault = dockerfile.args.filter((arg) => !arg.hasDefault).map((arg) => arg.name);
  if (argsWithoutDefault.length > 0) {
    report.add({
      id: 'docker.build-args',
      severity: 'info',
      title: `Build arguments without default value: ${argsWithoutDefault.join(', ')}`,
      details:
        'Every environment variable of the application is passed as --build-arg, define them with `clever env set`.',
      location: dockerfilePath,
    });
  }

  const privateRegistryImage = dockerfile.baseImages.find((image) =>
    /^(?!docker\.io|ghcr\.io\/[\w-]+\/[\w-]+:|quay\.io|mcr\.microsoft\.com|public\.ecr\.aws|gcr\.io\/distroless)[\w-]+(\.[\w-]+)+(:\d+)?\//.test(
      image,
    ),
  );
  if (privateRegistryImage != null) {
    report.add({
      id: 'docker.private-registry',
      severity: 'info',
      title: `Base image ${privateRegistryImage} may come from a private registry`,
      location: dockerfilePath,
      fix: [
        'Set CC_DOCKER_LOGIN_SERVER, CC_DOCKER_LOGIN_USERNAME and CC_DOCKER_LOGIN_PASSWORD if authentication is needed',
      ],
    });
  }

  if (dockerfile.hasHealthcheck) {
    report.add({
      id: 'docker.healthcheck',
      severity: 'info',
      title: 'HEALTHCHECK found: Clever Cloud checks deployments with CC_HEALTH_CHECK_PATH',
      location: dockerfilePath,
      fix: ['`clever env set CC_HEALTH_CHECK_PATH /health` (use your own route)'],
    });
  }

  if (!scanner.has('.dockerignore')) {
    report.add({
      id: 'docker.dockerignore',
      severity: 'info',
      title: 'No .dockerignore: the whole repository is sent as build context',
      fix: ['Add a .dockerignore (node_modules, .git, .env, build outputs...) to speed up builds'],
    });
  }

  return dockerfile;
}

/**
 * @param {MigrationReport} report
 * @param {number[]} ports
 * @param {string} location
 */
function reportExtraPorts(report, ports, location) {
  report.add({
    id: 'docker.extra-ports',
    severity: 'warning',
    title: `Additional ports ${ports.join(', ')} are not reachable by default`,
    details:
      'Only one HTTP port is routed. One extra TCP port can be exposed with CC_DOCKER_EXPOSED_TCP_PORT (default 4040) and a TCP redirection.',
    location,
    fix: [`\`clever env set CC_DOCKER_EXPOSED_TCP_PORT ${ports[0]}\``, '`clever tcp-redirs add --namespace default`'],
  });
}

/**
 * @typedef {object} ComposeService
 * @property {string} name
 * @property {string|null} image
 * @property {{ context: string, dockerfile: string }|null} build
 * @property {Array<{ published: string|null, target: number }>} ports
 * @property {Array<{ source: string, target: string, isBind: boolean }>} volumes
 * @property {Record<string, string|null>} environment
 * @property {string[]} envFiles
 * @property {string|null} command
 * @property {boolean} hasHealthcheck
 */

/**
 * @param {string} content
 * @returns {ComposeService[]}
 */
export function parseCompose(content) {
  const document = parseYaml(content, { merge: true });
  const services = document?.services ?? {};
  return Object.entries(services).map(([name, service]) => normalizeService(name, service ?? {}));
}

/**
 * @param {string} name
 * @param {any} service
 * @returns {ComposeService}
 */
function normalizeService(name, service) {
  let build = null;
  if (typeof service.build === 'string') {
    build = { context: service.build, dockerfile: 'Dockerfile' };
  } else if (service.build != null) {
    build = { context: service.build.context ?? '.', dockerfile: service.build.dockerfile ?? 'Dockerfile' };
  }

  /** @type {Record<string, string|null>} */
  let environment = {};
  if (Array.isArray(service.environment)) {
    for (const entry of service.environment) {
      const [key, ...rest] = String(entry).split('=');
      environment[key] = rest.length > 0 ? rest.join('=') : null;
    }
  } else if (service.environment != null) {
    environment = Object.fromEntries(
      Object.entries(service.environment).map(([key, value]) => [key, value == null ? null : String(value)]),
    );
  }

  const ports = (service.ports ?? []).map((/** @type {any} */ port) => {
    if (typeof port === 'object') {
      return { published: port.published != null ? String(port.published) : null, target: parseInt(port.target, 10) };
    }
    const parts = String(port).split('/')[0].split(':');
    return { published: parts.length > 1 ? (parts.at(-2) ?? null) : null, target: parseInt(parts.at(-1) ?? '', 10) };
  });

  const volumes = (service.volumes ?? []).map((/** @type {any} */ volume) => {
    if (typeof volume === 'object') {
      return {
        source: String(volume.source ?? ''),
        target: String(volume.target ?? ''),
        isBind: volume.type === 'bind',
      };
    }
    const [source, target] = String(volume).split(':');
    if (target == null) {
      return { source: '', target: source, isBind: false };
    }
    return { source, target, isBind: /^[./~]/.test(source) };
  });

  const envFiles = [service.env_file ?? []]
    .flat()
    .map((/** @type {any} */ file) => (typeof file === 'object' ? file.path : file))
    .filter(Boolean);

  return {
    name,
    image: service.image ?? null,
    build,
    ports,
    volumes,
    environment,
    envFiles,
    command: Array.isArray(service.command) ? service.command.join(' ') : (service.command ?? null),
    hasHealthcheck: service.healthcheck != null,
  };
}

/**
 * Pick the service that most likely is the application itself
 * @param {ComposeService[]} services
 * @returns {ComposeService|null}
 */
export function findMainService(services) {
  const built = services.filter((service) => service.build != null && findServiceMapping(service.image ?? '') == null);
  const candidates =
    built.length > 0 ? built : services.filter((service) => findServiceMapping(service.image ?? '') == null);
  return (
    candidates.find((service) => service.build?.context === '.' && service.ports.length > 0) ??
    candidates.find((service) => service.ports.length > 0) ??
    candidates[0] ??
    null
  );
}

/**
 * Translate a docker-compose stack into Clever Cloud add-ons and applications
 * @param {ProjectScanner} scanner
 * @param {MigrationReport} report
 * @param {string} composePath
 * @param {{ isDockerRuntime: boolean }} options
 * @returns {ComposeService|null} the main service
 */
export function checkCompose(scanner, report, composePath, { isDockerRuntime }) {
  const content = scanner.read(composePath);
  if (content == null) {
    return null;
  }
  let services;
  try {
    services = parseCompose(content);
  } catch (error) {
    report.add({
      id: 'compose.invalid',
      severity: 'warning',
      title: `Unable to parse ${composePath}`,
      details: error.message,
      location: composePath,
    });
    return null;
  }
  if (services.length === 0) {
    return null;
  }

  report.add({
    id: 'compose.not-supported',
    severity: services.length > 1 ? 'blocker' : 'warning',
    title: `${composePath} defines ${services.length} service(s): Docker Compose is not supported on Clever Cloud`,
    details:
      'One Clever Cloud application runs one container. Databases and caches become managed add-ons, other services become separate applications.',
    location: composePath,
  });

  const main = findMainService(services);
  /** @type {Map<string, import('../catalog.js').AddonMapping>} */
  const replacedByAddon = new Map();

  for (const service of services) {
    if (service === main) {
      continue;
    }
    const mapping = findServiceMapping(service.image ?? '');
    const location = `${composePath} (service "${service.name}")`;

    if (mapping?.kind === 'addon') {
      const addon = report.addAddon({ provider: mapping.provider, label: mapping.label, fromService: service.name });
      replacedByAddon.set(service.name, mapping);
      report.add({
        id: 'compose.service-to-addon',
        severity: 'blocker',
        title: `Service "${service.name}" (${service.image}) must be replaced by the ${mapping.label} add-on`,
        details: mapping.note,
        location,
        fix: [`\`clever addon create ${mapping.provider} ${addon.name} --link ${report.appName}\``],
      });
      const initScripts = service.volumes.filter((volume) => volume.target.includes('docker-entrypoint-initdb.d'));
      if (initScripts.length > 0) {
        report.add({
          id: 'compose.init-scripts',
          severity: 'warning',
          title: `Initialization scripts of "${service.name}" are not executed by managed add-ons`,
          location,
          fix: initScripts.map(
            (volume) => `Run ${volume.source} manually against the add-on, or turn it into a migration`,
          ),
        });
      }
      continue;
    }

    if (mapping != null) {
      report.add({
        id: `compose.service-${mapping.kind}`,
        severity: mapping.kind === 'unsupported' ? 'warning' : 'info',
        title: `Service "${service.name}" (${service.image}): ${mapping.label.toLowerCase()} ${mapping.kind === 'unsupported' ? 'has no managed equivalent' : 'is not needed'}`,
        details: mapping.note,
        location,
      });
      continue;
    }

    // Unknown service: it has to run as its own application
    const appName = `${report.appName}-${service.name}`;
    /** @type {Record<string, string>} */
    const env = {};
    let reason;
    if (service.build != null) {
      const dockerfile = joinPath(service.build.context, service.build.dockerfile);
      if (dockerfile !== 'Dockerfile') {
        env.CC_DOCKERFILE = dockerfile;
      }
      const isWorker = service.ports.length === 0 && main?.build?.context === service.build.context;
      reason = isWorker
        ? `Background worker built from the same sources (command: ${service.command ?? 'default'})`
        : `Built from ${service.build.context}`;
      if (isWorker && service.command != null && !isDockerRuntime) {
        report.setEnv('CC_WORKER_COMMAND', service.command, `Replaces the "${service.name}" worker service`);
        report.add({
          id: 'compose.worker',
          severity: 'warning',
          title: `Service "${service.name}" looks like a background worker`,
          location,
          fix: [
            `\`clever env set CC_WORKER_COMMAND ${JSON.stringify(service.command)}\` to run it next to the web process`,
          ],
        });
        continue;
      }
    } else {
      reason = `Runs the ${service.image} image (create a Dockerfile containing "FROM ${service.image}")`;
    }
    const sharesSources = service.build != null && service.build.context === main?.build?.context;
    report.extraApps.push({ name: appName, type: 'docker', reason, env, linkAddons: sharesSources });
    /** @type {string[]} */
    const fix = [`\`clever create --type docker ${appName}\``];
    if (service.command != null && service.build != null) {
      fix.push(
        `Clever Cloud runs the CMD of the Dockerfile: give this application its own Dockerfile running "${service.command}" (selected with CC_DOCKERFILE)`,
      );
    }
    fix.push(
      sharesSources
        ? 'Link the same add-ons to it: `clever service link-addon <addon> --alias ' + appName + '`'
        : `Link it to the main application: \`clever service link-app ${appName}\``,
    );
    report.add({
      id: 'compose.extra-app',
      severity: 'warning',
      title: `Service "${service.name}" must be deployed as a separate application`,
      details: reason,
      location,
      fix,
    });
  }

  if (main != null) {
    checkMainService(report, composePath, main, services, replacedByAddon, { isDockerRuntime });
  }
  return main;
}

/**
 * @param {MigrationReport} report
 * @param {string} composePath
 * @param {ComposeService} main
 * @param {ComposeService[]} services
 * @param {Map<string, import('../catalog.js').AddonMapping>} replacedByAddon
 * @param {{ isDockerRuntime: boolean }} options
 */
function checkMainService(report, composePath, main, services, replacedByAddon, { isDockerRuntime }) {
  const location = `${composePath} (service "${main.name}")`;
  const serviceNames = services.map((service) => service.name);

  /** @type {string[]} */
  const rewired = [];
  /** @type {string[]} */
  const unresolved = [];
  for (const [name, value] of Object.entries(main.environment)) {
    if (value == null || /\$\{?\w+/.test(value)) {
      unresolved.push(name);
      continue;
    }
    const referencedService = serviceNames.find((serviceName) =>
      new RegExp(`(^|[@/:,])${escapeRegExp(serviceName)}($|[:/?,])`).test(value),
    );
    if (referencedService == null) {
      if (!/(SECRET|PASSWORD|TOKEN|PRIVATE|API_KEY)/i.test(name)) {
        report.setEnv(name, value, `Copied from ${location}`);
      } else {
        unresolved.push(name);
      }
      continue;
    }
    const mapping = replacedByAddon.get(referencedService);
    const role = guessVariableRole(name);
    const addonVariable = mapping != null && role != null ? mapping.variables[role] : null;
    if (addonVariable === name) {
      rewired.push(`${name}=${value} → already injected by the add-on, remove it`);
    } else if (addonVariable != null) {
      rewired.push(`${name}=${value} → use ${addonVariable}`);
    } else {
      rewired.push(`${name}=${value} → points to "${referencedService}", use the matching Clever Cloud variable`);
    }
  }

  if (rewired.length > 0) {
    report.add({
      id: 'compose.service-hostnames',
      severity: 'blocker',
      title: 'Environment variables point to docker-compose hostnames that will not exist',
      details: rewired.join('\n'),
      location,
      fix: [
        'Read the add-on variables in your code (e.g. process.env.POSTGRESQL_ADDON_URI), or copy their values with `clever env` once the add-on is linked',
      ],
    });
  }
  if (unresolved.length > 0) {
    report.add({
      id: 'compose.unresolved-env',
      severity: 'warning',
      title: `Variables to define manually: ${unresolved.join(', ')}`,
      details: 'Their value is a secret, comes from the shell or from an env_file.',
      location,
      fix: unresolved.map((name) => `\`clever env set ${name} <value>\``),
    });
  }
  for (const envFile of main.envFiles) {
    if (!report.envFilesToImport.includes(envFile)) {
      report.envFilesToImport.push(envFile);
    }
  }

  const httpPort = main.ports.find((port) => Number.isInteger(port.target))?.target;
  if (isDockerRuntime && httpPort != null && httpPort !== HTTP_PORT && !report.hasFinding('docker.http-port')) {
    report.setEnv('CC_DOCKER_EXPOSED_HTTP_PORT', String(httpPort), `${location} publishes container port ${httpPort}`);
    report.add({
      id: 'docker.http-port',
      severity: 'blocker',
      title: `The container listens on ${httpPort}, Clever Cloud routes HTTP traffic to ${HTTP_PORT}`,
      location,
      fix: [`\`clever env set CC_DOCKER_EXPOSED_HTTP_PORT ${httpPort}\``],
    });
  }

  for (const volume of main.volumes) {
    if (volume.source.endsWith('docker.sock')) {
      report.setEnv('CC_MOUNT_DOCKER_SOCKET', 'true', 'The application needs the Docker socket');
      report.add({
        id: 'compose.docker-socket',
        severity: 'warning',
        title: 'The application mounts the Docker socket',
        details: 'Possible with CC_MOUNT_DOCKER_SOCKET=true, but it breaks container isolation.',
        location,
      });
      continue;
    }
    // Bind mounts of the sources are a development convenience, the image already contains the code
    if (volume.isBind && /^\.\/?$/.test(volume.source)) {
      continue;
    }
    report.add({
      id: 'compose.volume',
      severity: 'warning',
      title: `Volume ${volume.source || '(anonymous)'} → ${volume.target} will not be persisted`,
      details: 'The local filesystem is reset on each deployment.',
      location,
      fix: [
        isDockerRuntime
          ? 'Use Cellar (S3) or a database add-on to store this data'
          : 'Use an FS Bucket add-on (`clever addon create fs-bucket ...`) or Cellar (S3)',
      ],
    });
  }

  if (main.command != null && isDockerRuntime) {
    report.add({
      id: 'compose.command-override',
      severity: 'warning',
      title: `docker-compose overrides the command (${main.command}), Clever Cloud uses the Dockerfile CMD`,
      location,
      fix: ['Move this command into the CMD of the Dockerfile'],
    });
  }
}

/**
 * @param {string} directory
 * @param {string} file
 * @returns {string}
 */
function joinPath(directory, file) {
  const parts = [...directory.split('/'), ...file.split('/')].filter((part) => part !== '' && part !== '.');
  return parts.join('/');
}

/**
 * @param {string} value
 * @returns {string}
 */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
