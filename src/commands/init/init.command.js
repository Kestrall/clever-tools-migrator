import path from 'node:path';
import { z } from 'zod';
import { config } from '../../config/config.js';
import { defineArgument } from '../../lib/define-argument.js';
import { defineCommand } from '../../lib/define-command.js';
import { defineOption } from '../../lib/define-option.js';
import { styleText } from '../../lib/style-text.js';
import { Logger } from '../../logger.js';
import * as AppConfig from '../../models/app_configuration.js';
import * as Application from '../../models/application.js';
import { AVAILABLE_ZONES, listAvailableZones } from '../../models/application.js';
import {
  checkCanScaffold,
  checkProjectDirectory,
  getStarterTemplate,
  scaffoldProject,
} from '../../models/init/scaffold.js';
import { listStarterRuntimes } from '../../models/init/templates.js';
import { deployCommand } from '../deploy/deploy.command.js';
import { aliasCreationOption, humanJsonOutputFormatOption, orgaIdOrNameOption } from '../global.options.js';

export const initCommand = defineCommand({
  description: 'Generate a minimal working project for a runtime in the current directory and create its application',
  since: null,
  options: {
    region: defineOption({
      name: 'region',
      schema: z.string().default('par'),
      description: `Region, can be ${AVAILABLE_ZONES.map((name) => `'${name}'`).join(', ')}`,
      aliases: ['r'],
      placeholder: 'zone',
      complete: listAvailableZones,
    }),
    local: defineOption({
      name: 'local',
      schema: z.boolean().default(false),
      description: 'Only generate the project files, do not create the application on Clever Cloud',
    }),
    deploy: defineOption({
      name: 'deploy',
      schema: z.boolean().default(false),
      description: 'Deploy the application right after its creation',
      aliases: ['d'],
    }),
    org: orgaIdOrNameOption,
    alias: aliasCreationOption,
    format: humanJsonOutputFormatOption,
  },
  args: [
    defineArgument({
      schema: z.string(),
      description: `Runtime of the project: ${listStarterRuntimes().join(', ')}`,
      placeholder: 'runtime',
      complete: listStarterRuntimes,
    }),
    defineArgument({
      schema: z.string().optional(),
      description:
        'Application name, the project is generated in a new directory with this name (current directory and its name if not specified)',
      placeholder: 'app-name',
    }),
  ],
  async handler(options, runtime, rawName) {
    const { region, local, deploy, org: orgaIdOrName, alias, format } = options;
    const template = getStarterTemplate(runtime);
    const hasName = rawName != null && rawName !== '';
    const directory = hasName ? await checkProjectDirectory(process.cwd(), rawName) : process.cwd();
    const name = hasName ? rawName : path.basename(directory);
    // Shown in the next steps when the project is in a new directory
    const cdCommand = hasName ? `cd ${rawName}` : null;

    // Fail before writing anything
    if (deploy && local) {
      throw new Error('--deploy needs the application on Clever Cloud, it cannot be used with --local');
    }
    if (deploy && format === 'json') {
      throw new Error('--deploy streams the deployment logs, it cannot be used with --format json');
    }
    await checkCanScaffold(directory, runtime, name);
    if (!local && !hasName) {
      const { apps } = await AppConfig.loadApplicationConf();
      AppConfig.checkAlreadyLinked(apps, name, alias);
    }

    const scaffold = await scaffoldProject(directory, runtime, name);
    if (hasName) {
      // The application is linked and deployed from the new directory, like a command run inside it
      process.chdir(directory);
      config.APP_CONFIGURATION_FILE = path.join(directory, '.clever.json');
    }

    let app = null;
    let linkedAlias = null;
    if (!local) {
      try {
        app = await Application.create(name, runtime, region, orgaIdOrName, null, false, template.env);
      } catch (error) {
        throw new Error(
          `The project files are ready but the application could not be created: ${error.message}\nCreate it later with \`${cdCommand != null ? `${cdCommand} && ` : ''}clever create --type ${runtime} ${name}\`${envHint(template.env)}`,
        );
      }
      ({ alias: linkedAlias } = await AppConfig.addLinkedApplication(app, alias));
    }

    if (format === 'json') {
      Logger.printJson({
        runtime,
        directory,
        files: scaffold.files,
        commit: scaffold.commit,
        commitError: scaffold.commitError,
        env: template.env,
        app: app == null ? null : { id: app.id, name: app.name, deployUrl: app.deployUrl },
      });
      return;
    }

    printResult({ runtime, name, directory, cdCommand, template, scaffold, app, local, deploy });

    if (deploy) {
      if (scaffold.commit == null) {
        throw new Error('Nothing to deploy: the files could not be committed, commit them then run `clever deploy`');
      }
      Logger.println();
      await deployCommand.handler({
        alias: linkedAlias,
        branch: '',
        tag: '',
        force: false,
        sameCommitPolicy: 'error',
        quiet: false,
        follow: false,
        exitOnDeploy: 'deploy-end',
      });
    }
  },
});

/**
 * @param {Record<string, string>} env
 * @returns {string}
 */
function envHint(env) {
  const entries = Object.entries(env);
  if (entries.length === 0) {
    return '';
  }
  return ` then ${entries.map(([key, value]) => `\`clever env set ${key} ${value}\``).join(', ')}`;
}

/**
 * @param {object} result
 * @param {string} result.runtime
 * @param {string} result.name
 * @param {string} result.directory
 * @param {string|null} result.cdCommand
 * @param {import('../../models/init/templates.js').StarterTemplate} result.template
 * @param {import('../../models/init/scaffold.js').ScaffoldResult} result.scaffold
 * @param {any} result.app
 * @param {boolean} result.local
 * @param {boolean} result.deploy
 */
function printResult({ runtime, name, directory, cdCommand, template, scaffold, app, local, deploy }) {
  const check = styleText('green', '✓');
  Logger.println(`${check} ${styleText('bold', runtime)} project generated in ${directory}: ${template.description}`);
  for (const file of scaffold.files) {
    Logger.println(`    ${styleText('grey', file)}`);
  }
  if (scaffold.repository === 'created') {
    Logger.println(`${check} Git repository initialized`);
  }
  if (scaffold.commit != null) {
    Logger.println(`${check} Files committed ${styleText('grey', `(${scaffold.commit.slice(0, 7)})`)}`);
  } else {
    Logger.println(`${styleText('yellow', '!')} The files could not be committed: ${scaffold.commitError}`);
  }
  if (app != null) {
    Logger.println(`${check} Application ${styleText('green', app.name)} created ${styleText('grey', `(${app.id})`)}`);
    for (const [key, value] of Object.entries(template.env)) {
      Logger.println(`    ${styleText('grey', `${key}=${value}`)}`);
    }
  }

  Logger.println();
  Logger.println(styleText('bold', 'Next steps:'));
  if (cdCommand != null) {
    Logger.println(`  ${styleText('blue', '→')} ${styleText('yellow', cdCommand)}`);
  }
  if (scaffold.commit == null) {
    Logger.println(`  ${styleText('blue', '→')} ${styleText('yellow', 'git add . && git commit -m "Initial commit"')}`);
  }
  if (local) {
    Logger.println(`  ${styleText('blue', '→')} ${styleText('yellow', `clever create --type ${runtime} ${name}`)}`);
    for (const [key, value] of Object.entries(template.env)) {
      Logger.println(`  ${styleText('blue', '→')} ${styleText('yellow', `clever env set ${key} ${value}`)}`);
    }
  }
  if (deploy) {
    Logger.println(`  ${styleText('blue', '→')} ${styleText('yellow', 'clever open')} once deployed`);
  } else {
    Logger.println(`  ${styleText('blue', '→')} ${styleText('yellow', 'clever deploy')} to deploy it`);
  }
  Logger.println(`  ${styleText('blue', '→')} ${styleText('yellow', template.runLocally)} to run it locally`);
  if (app != null) {
    Logger.println(
      `  ${styleText('blue', '→')} Manage your application at: ${styleText('underline', `${config.GOTO_URL}/${app.id}`)}`,
    );
  }
}
