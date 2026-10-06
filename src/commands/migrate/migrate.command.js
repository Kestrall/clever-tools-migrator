import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { defineArgument } from '../../lib/define-argument.js';
import { defineCommand } from '../../lib/define-command.js';
import { defineOption } from '../../lib/define-option.js';
import { styleText } from '../../lib/style-text.js';
import { Logger } from '../../logger.js';
import { listAvailableTypes } from '../../models/application.js';
import { analyzeProject } from '../../models/migrate/analyze.js';
import { renderReport } from '../../models/migrate/render.js';
import { humanJsonOutputFormatOption } from '../global.options.js';

export const migrateCommand = defineCommand({
  description: 'Analyze a project and list what is missing to deploy it on Clever Cloud',
  since: null,
  options: {
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
      description: 'Application name used in the migration plan (current directory name by default)',
      aliases: ['n'],
      placeholder: 'app-name',
    }),
    write: defineOption({
      name: 'write',
      schema: z.boolean().default(false),
      description: 'Write the proposed configuration files (existing files are never overwritten)',
    }),
    strict: defineOption({
      name: 'strict',
      schema: z.boolean().default(false),
      description: 'Exit with code 1 if blockers are found (useful in CI)',
    }),
    format: humanJsonOutputFormatOption,
  },
  args: [
    defineArgument({
      schema: z.string().optional(),
      description: 'Path of the project to analyze (current directory if not specified)',
      placeholder: 'path',
    }),
  ],
  async handler(options, projectPath) {
    const { type, name, write, strict, format } = options;
    const root = path.resolve(projectPath || '.');

    const stats = await fs.stat(root).catch(() => null);
    if (stats == null || !stats.isDirectory()) {
      throw new Error(`${root} is not a directory`);
    }
    if (type != null && !listAvailableTypes().includes(type)) {
      throw new Error(`Unknown instance type "${type}", available types: ${listAvailableTypes().join(', ')}`);
    }

    const report = analyzeProject(root, { type, appName: name });

    /** @type {string[]} */
    const written = [];
    if (write) {
      for (const file of report.files) {
        const target = path.join(root, file.path);
        const exists = await fs.stat(target).catch(() => null);
        if (exists == null) {
          await fs.mkdir(path.dirname(target), { recursive: true });
          await fs.writeFile(target, file.content);
          written.push(file.path);
        }
      }
    }

    switch (format) {
      case 'json': {
        Logger.printJson({ ...report.toJSON(), written });
        break;
      }
      case 'human':
      default: {
        Logger.println(renderReport(report));
        for (const file of written) {
          Logger.printSuccess(`${styleText('green', file)} written`);
        }
      }
    }

    if (strict && report.counts.blocker > 0) {
      process.exitCode = 1;
    }
  },
});
