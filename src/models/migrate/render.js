import { styleText } from '../../lib/style-text.js';
import { shellQuote } from './report.js';

/**
 * @typedef {import('./report.js').MigrationReport} MigrationReport
 * @typedef {import('./report.js').Finding} Finding
 */

const SECTIONS = /** @type {const} */ ([
  {
    severity: 'blocker',
    icon: '✘',
    color: 'red',
    title: 'Blockers: the application will not work without these changes',
  },
  { severity: 'warning', icon: '!', color: 'yellow', title: 'Warnings: likely to break or lose data in production' },
  { severity: 'info', icon: 'i', color: 'blue', title: 'Information' },
]);

/**
 * Human readable report
 * @param {MigrationReport} report
 * @param {{ pathArgument?: string }} [options] project path as typed by the user, repeated in the reminder
 * @returns {string}
 */
export function renderReport(report, { pathArgument = '' } = {}) {
  const lines = [];
  const { blocker, warning, info } = report.counts;

  lines.push('', styleText('bold', `Clever Cloud migration report for ${report.projectPath}`), '');
  lines.push(
    ...renderFields({
      Detected: report.detected.length > 0 ? report.detected.join(', ') : 'nothing',
      Runtime:
        report.runtime.type != null
          ? `${styleText(['bold', 'blue'], `⬢ ${report.runtime.type}`)} ${styleText('grey', `(${report.runtime.reason})`)}`
          : styleText('red', 'unknown'),
      Readiness: `${renderScore(report.score)}  ${styleText('red', `${blocker} blocker(s)`)} · ${styleText('yellow', `${warning} warning(s)`)} · ${styleText('blue', `${info} info`)}`,
    }),
  );

  for (const section of SECTIONS) {
    const findings = report.findings.filter((finding) => finding.severity === section.severity);
    if (findings.length === 0) {
      continue;
    }
    lines.push('', styleText(['bold', section.color], `${section.icon} ${section.title}`));
    for (const finding of findings) {
      lines.push(...renderFinding(finding, section.icon, section.color));
    }
  }

  lines.push(...renderPlan(report));
  lines.push(...renderReminder(pathArgument));
  return lines.join('\n');
}

/**
 * @param {string} pathArgument
 * @returns {string[]}
 */
function renderReminder(pathArgument) {
  const target = pathArgument !== '' ? ` ${shellQuote(pathArgument)}` : '';
  const commands = [
    [`clever migrate${target}`, 'analyze again after your changes'],
    [`clever migrate apply${target} --dry-run`, 'preview the changes, nothing is written'],
    [`clever migrate apply${target}`, 'write the changes on a new branch or in a copy'],
  ];
  const width = Math.max(...commands.map(([command]) => command.length));
  return [
    styleText('bold', 'Reminder'),
    ...commands.map(
      ([command, description]) =>
        `  ${styleText('yellow', command.padEnd(width))}  ${styleText('grey', `# ${description}`)}`,
    ),
    '',
  ];
}

/**
 * @param {Finding} finding
 * @param {string} icon
 * @param {'red'|'yellow'|'blue'} color
 * @returns {string[]}
 */
function renderFinding(finding, icon, color) {
  const lines = [`  ${styleText(color, icon)} ${finding.title}`];
  if (finding.location != null) {
    lines.push(`    ${styleText('grey', finding.location)}`);
  }
  if (finding.details != null) {
    lines.push(...finding.details.split('\n').map((line) => `    ${styleText('grey', line)}`));
  }
  for (const fix of finding.fix ?? []) {
    lines.push(`    ${styleText('green', '→')} ${highlightCommands(fix)}`);
  }
  return lines;
}

/**
 * @param {MigrationReport} report
 * @returns {string[]}
 */
function renderPlan(report) {
  const lines = ['', styleText('bold', 'Migration plan')];

  if (report.addons.length > 0) {
    lines.push('', `  ${styleText('bold', 'Add-ons')}`);
    for (const addon of report.addons) {
      const origin = addon.fromService != null ? styleText('grey', ` (replaces "${addon.fromService}")`) : '';
      const status =
        addon.existing === 'linked'
          ? styleText('green', ' ✓ already linked')
          : addon.existing === 'unlinked'
            ? styleText('yellow', ' exists, not linked')
            : '';
      lines.push(`    ${styleText('blue', addon.provider)} ${addon.name}${origin}${status}`);
    }
  }

  const envEntries = Object.entries(report.env);
  if (envEntries.length > 0 || report.envFilesToImport.length > 0) {
    lines.push('', `  ${styleText('bold', 'Environment variables')}`);
    for (const file of report.envFilesToImport) {
      lines.push(`    ${styleText('grey', `import ${file} (review the values first)`)}`);
    }
    const nameWidth = Math.max(0, ...envEntries.map(([name]) => name.length));
    for (const [name, { value, reason }] of envEntries) {
      lines.push(`    ${styleText('blue', name.padEnd(nameWidth))} = ${value}  ${styleText('grey', `# ${reason}`)}`);
    }
  }

  if (report.files.length > 0) {
    lines.push('', `  ${styleText('bold', 'Files to create')} ${styleText('grey', '(use --write to generate them)')}`);
    for (const file of report.files) {
      lines.push(`    ${styleText('blue', file.path)} ${styleText('grey', `# ${file.reason}`)}`);
      lines.push(
        ...file.content
          .trimEnd()
          .split('\n')
          .map((line) => `      ${styleText('grey', line)}`),
      );
    }
  }

  if (report.extraApps.length > 0) {
    lines.push('', `  ${styleText('bold', 'Additional applications')}`);
    for (const app of report.extraApps) {
      lines.push(`    ${styleText('blue', `⬢ ${app.type}`)} ${app.name} ${styleText('grey', `# ${app.reason}`)}`);
    }
  }

  const commands = report.commands;
  if (commands.length > 0) {
    lines.push('', `  ${styleText('bold', 'Commands')}`);
    for (const command of commands) {
      lines.push(`    ${styleText('grey', '$')} ${styleText('yellow', command)}`);
    }
  }

  lines.push('');
  if (report.counts.blocker > 0) {
    lines.push(
      styleText(
        'grey',
        'Code changes listed in the blockers are not covered by these commands: fix them before deploying.',
      ),
      '',
    );
  }
  return lines;
}

/**
 * @param {Record<string, string>} fields
 * @returns {string[]}
 */
function renderFields(fields) {
  const width = Math.max(...Object.keys(fields).map((label) => label.length));
  return Object.entries(fields).map(([label, value]) => `  ${styleText('bold', label.padEnd(width))}  ${value}`);
}

/**
 * @param {number} score
 * @returns {string}
 */
function renderScore(score) {
  const filled = Math.round(score / 10);
  const color = score >= 80 ? 'green' : score >= 50 ? 'yellow' : 'red';
  return `${styleText(['bold', color], `${score}/100`)} ${styleText(color, '■'.repeat(filled))}${styleText('grey', '□'.repeat(10 - filled))}`;
}

/**
 * @param {string} text
 * @returns {string}
 */
function highlightCommands(text) {
  return text.replace(/`([^`]+)`/g, (_, command) => styleText('yellow', command));
}
