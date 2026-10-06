import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { defineArgument } from '../../lib/define-argument.js';
import { defineCommand } from '../../lib/define-command.js';
import { defineOption } from '../../lib/define-option.js';
import { styleText } from '../../lib/style-text.js';
import { Logger } from '../../logger.js';
import { listAvailableTypes } from '../../models/application.js';
import { applyMigration } from '../../models/migrate/apply.js';
import { DATA_SCRIPT, ENV_FILE, MIGRATION_GUIDE, SETUP_SCRIPT } from '../../models/migrate/migration-files.js';
import { fetchRemoteState } from '../../models/migrate/remote-state.js';
import { humanJsonOutputFormatOption } from '../global.options.js';

export const migrateApplyCommand = defineCommand({
  description: 'Prepare the project for Clever Cloud on a new git branch or in a copy of the project',
  since: null,
  options: {
    mode: defineOption({
      name: 'mode',
      schema: z.enum(['auto', 'branch', 'folder']).default('auto'),
      description:
        'Where to write the changes: a new git branch, a copy of the project, or auto (branch if the git repository is clean, folder otherwise)',
      placeholder: 'mode',
    }),
    branch: defineOption({
      name: 'branch',
      schema: z.string().default('clever-cloud-migration'),
      description: 'Name of the branch to create',
      placeholder: 'branch-name',
    }),
    output: defineOption({
      name: 'output',
      schema: z.string().optional(),
      description: 'Folder of the copy in folder mode (default: <project>-clever next to the project)',
      aliases: ['o'],
      placeholder: 'folder',
    }),
    type: defineOption({
      name: 'type',
      schema: z.string().optional(),
      description: 'Force the target instance type instead of detecting it',
      aliases: ['t'],
      placeholder: 'instance-type',
      complete: listAvailableTypes,
    }),
    name: defineOption({
      name: 'name',
      schema: z.string().optional(),
      description: 'Application name (current directory name by default)',
      aliases: ['n'],
      placeholder: 'app-name',
    }),
    skipCode: defineOption({
      name: 'skip-code',
      schema: z.boolean().default(false),
      description: 'Do not modify source files, only generate configuration files',
    }),
    offline: defineOption({
      name: 'offline',
      schema: z.boolean().default(false),
      description: 'Do not query Clever Cloud for the add-ons that already exist',
    }),
    dryRun: defineOption({
      name: 'dry-run',
      schema: z.boolean().default(false),
      description: 'Show what would be done without writing anything',
    }),
    format: humanJsonOutputFormatOption,
  },
  args: [
    defineArgument({
      schema: z.string().optional(),
      description: 'Path of the project to migrate (current directory if not specified)',
      placeholder: 'path',
    }),
  ],
  async handler(options, projectPath) {
    const { mode, branch, output, type, name, dryRun, skipCode, offline, format } = options;
    const root = path.resolve(projectPath || '.');

    const stats = await fs.stat(root).catch(() => null);
    if (stats == null || !stats.isDirectory()) {
      throw new Error(`${root} is not a directory`);
    }
    if (type != null && !listAvailableTypes().includes(type)) {
      throw new Error(`Unknown instance type "${type}", available types: ${listAvailableTypes().join(', ')}`);
    }

    const { state: remote, missingApp } = offline ? { state: null, missingApp: null } : await fetchRemoteState(root);
    const result = await applyMigration(root, {
      mode,
      branch,
      output,
      type,
      appName: name,
      dryRun,
      skipCode,
      remote,
      missingApp,
    });

    if (format === 'json') {
      Logger.printJson({
        mode: result.mode,
        modeReason: result.modeReason,
        targetPath: result.targetPath,
        branch: result.branch,
        dryRun,
        commits: result.commits,
        changes: result.changes.map(({ path, action, description, group, status, reason }) => ({
          path,
          action,
          description,
          group,
          status,
          reason,
        })),
        codeEdits: result.edits,
        todo: result.todo,
      });
      return;
    }

    printResult(result, dryRun, branch);
  },
});

/**
 * @param {import('../../models/migrate/apply.js').ApplyResult} result
 * @param {boolean} dryRun
 * @param {string} branch requested branch name
 */
function printResult(result, dryRun, branch) {
  const branchLabel = {
    new: 'on a new branch',
    current: 'on the existing branch',
    switched: 'on the existing branch (switched to it)',
  }[result.branchStatus];
  const where =
    result.mode === 'branch'
      ? `${branchLabel} ${styleText('blue', result.branch ?? '')}`
      : `in a copy: ${styleText('blue', result.targetPath)}${result.branch != null ? ` (branch ${result.branch})` : ''}`;

  Logger.println('');
  if (dryRun) {
    const dryRunTarget =
      result.mode === 'branch'
        ? `${result.branchStatus === 'new' ? 'on a new branch' : 'on the existing branch'} ${branch}`
        : `in ${result.targetPath}`;
    Logger.println(styleText('bold', `Dry run: the changes would be written ${dryRunTarget}`));
  } else {
    Logger.printSuccess(`Project prepared for Clever Cloud ${where}`);
  }
  if (result.modeReason != null) {
    Logger.println(styleText('grey', `  (${result.mode} mode: ${result.modeReason})`));
  }

  Logger.println('');
  Logger.println(styleText('bold', 'Files'));
  for (const change of result.changes) {
    const icon =
      change.status === 'skipped'
        ? styleText('yellow', '-')
        : styleText('green', change.action === 'create' ? '+' : '~');
    const suffix =
      change.status === 'skipped'
        ? styleText('yellow', ` skipped: ${change.reason}`)
        : change.group === 'secrets'
          ? styleText('yellow', ' (not committed, contains secrets)')
          : '';
    Logger.println(`  ${icon} ${change.path} ${styleText('grey', `# ${change.description}`)}${suffix}`);
  }

  if (result.edits.length > 0) {
    Logger.println('');
    Logger.println(styleText('bold', 'Code changes'));
    for (const edit of result.edits) {
      Logger.println(`  ${styleText('blue', `${edit.file}:${edit.line}`)} ${styleText('grey', `# ${edit.reason}`)}`);
      if (edit.before !== '') {
        Logger.println(`    ${styleText('red', `- ${edit.before}`)}`);
      }
      Logger.println(`    ${styleText('green', `+ ${edit.after}`)}`);
    }
  }

  if (result.branch != null && !dryRun) {
    Logger.println('');
    Logger.println(styleText('bold', 'Commits'));
    for (const commit of result.commits) {
      Logger.println(`  ${styleText('green', '•')} ${commit}`);
    }
    if (result.commits.length === 0) {
      Logger.println(styleText('grey', `  none: ${result.branch} was already up to date`));
    }
  }

  if (result.todo.length > 0) {
    Logger.println('');
    Logger.println(styleText('bold', `Still to do manually (${result.todo.length}), detailed in ${MIGRATION_GUIDE}`));
    for (const finding of result.todo) {
      const icon = finding.severity === 'blocker' ? styleText('red', '✘') : styleText('yellow', '!');
      Logger.println(`  ${icon} ${finding.title}`);
    }
  }

  if (dryRun) {
    Logger.println('');
    return;
  }

  const hasEnvFile = result.changes.some((change) => change.path === ENV_FILE && change.status === 'written');
  const hasDataScript = result.changes.some((change) => change.path === DATA_SCRIPT && change.status === 'written');
  const steps = [
    ...(result.mode === 'folder' ? [`cd ${result.targetPath}`] : []),
    ...(hasEnvFile
      ? [
          result.changes.some((change) => change.path === ENV_FILE && change.content.includes('# TODO'))
            ? `Review ${ENV_FILE} and fill the TODO lines`
            : `Review ${ENV_FILE}`,
        ]
      : []),
    `Review and run ./${SETUP_SCRIPT}`,
    ...(hasDataScript ? [`./${DATA_SCRIPT}  # copy your data into the add-ons`] : []),
    // On a branch, the generated files are already committed
    ...(result.branch == null ? ['git init && git add . && git commit -m "Prepare deployment on Clever Cloud"'] : []),
    'clever deploy',
  ];
  Logger.println('');
  Logger.println(styleText('bold', 'Next steps'));
  steps.forEach((step, index) => Logger.println(`  ${index + 1}. ${styleText('yellow', step)}`));
  Logger.println('');
}
