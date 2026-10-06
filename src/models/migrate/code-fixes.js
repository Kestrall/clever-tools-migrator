import { getAddonMapping } from './catalog.js';
import { codeLineMask } from './project-scanner.js';
import { findHardcodedPhpConnections } from './rules/database.js';

/**
 * Automatic code changes, limited to well known patterns that keep the local behaviour:
 * the original value stays the fallback when the Clever Cloud variable is not defined.
 */

/**
 * @typedef {import('./project-scanner.js').ProjectScanner} ProjectScanner
 * @typedef {import('./report.js').MigrationReport} MigrationReport
 * @typedef {import('./migration-files.js').PlannedChange} PlannedChange
 */

/**
 * @typedef {object} CodeEdit
 * @property {string} file
 * @property {number} line
 * @property {string} before
 * @property {string} after
 * @property {string} reason
 */

const HTTP_PORT = '8080';
const NODE_EXTENSIONS = /\.(m?[jt]s|cjs)$/;
const LOOPBACK = /(['"`])(localhost|127\.0\.0\.1)\1/;

/**
 * Line rewriters for Node.js servers. Each one returns the new line, or null when it does not apply.
 * @type {Array<{ kind: 'port'|'host', reason: string, rewrite: (line: string, context: { content: string }) => string|null }>}
 */
const NODE_LINE_FIXES = [
  {
    // app.listen(3000) / server.listen(3000, cb)
    kind: 'port',
    reason: 'Listen on the PORT variable (8080 on Clever Cloud)',
    rewrite: (line) => {
      const match = /\.listen\(\s*(\d{2,5})(\s*[,)])/.exec(line);
      if (match == null || match[1] === HTTP_PORT || /process\.env/.test(line)) {
        return null;
      }
      return line.replace(match[0], `.listen(process.env.PORT || ${match[1]}${match[2]}`);
    },
  },
  {
    // const port = 3000; in a file starting a server with listen(port)
    kind: 'port',
    reason: 'Listen on the PORT variable (8080 on Clever Cloud)',
    rewrite: (line, { content }) => {
      const match = /^(\s*(?:export\s+)?(?:const|let|var)\s+(port|PORT)\s*=\s*)(\d{2,5})(\s*;?\s*)$/.exec(line);
      if (
        match == null ||
        match[3] === HTTP_PORT ||
        !new RegExp(`\\.listen\\(\\s*(\\{[^}]*\\b)?${match[2]}\\b`).test(content)
      ) {
        return null;
      }
      return `${match[1]}Number(process.env.PORT) || ${match[3]}${match[4]}`;
    },
  },
  {
    // fastify.listen({ port: 3000 }) and similar object forms
    kind: 'port',
    reason: 'Listen on the PORT variable (8080 on Clever Cloud)',
    rewrite: (line) => {
      const match = /(\.listen\(\s*\{[^}]*\bport\s*:\s*)(\d{2,5})\b/.exec(line);
      if (match == null || match[2] === HTTP_PORT || /process\.env/.test(line)) {
        return null;
      }
      return line.replace(match[0], `${match[1]}Number(process.env.PORT) || ${match[2]}`);
    },
  },
  {
    // app.listen(port, 'localhost') and listen({ host: '127.0.0.1' })
    kind: 'host',
    reason: 'Listen on all interfaces, not only on localhost',
    rewrite: (line) => {
      if (!/\.listen\(/.test(line) || !LOOPBACK.test(line)) {
        return null;
      }
      return line.replace(LOOPBACK, (_, quote) => `${quote}0.0.0.0${quote}`);
    },
  },
];

/**
 * @param {ProjectScanner} scanner
 * @param {MigrationReport} report
 * @returns {{ changes: PlannedChange[], edits: CodeEdit[], manual: import('./report.js').Finding[] }}
 */
export function planCodeFixes(scanner, report) {
  /** @type {CodeEdit[]} */
  const edits = [];
  /** @type {PlannedChange[]} */
  const changes = [];
  /** @type {import('./report.js').Finding[]} */
  const manual = [];

  /**
   * @param {string} file
   * @param {string} content
   * @param {CodeEdit[]} fileEdits
   */
  const addChange = (file, content, fileEdits) => {
    if (fileEdits.length === 0) {
      return;
    }
    edits.push(...fileEdits);
    changes.push({
      path: file,
      content,
      action: 'update',
      description: [...new Set(fileEdits.map((edit) => edit.reason))].join(', '),
      group: 'code',
    });
  };

  if (report.runtime.type === 'node') {
    const nodeFiles = scanner.sourceFiles.filter((candidate) => NODE_EXTENSIONS.test(candidate));
    // Only one server can receive the HTTP traffic: with several, we cannot guess which one gets PORT
    const portSites = nodeFiles.flatMap((file) => fixNodeFile(scanner, file, new Set(['port']))?.edits ?? []);
    if (portSites.length > 1) {
      manual.push({
        id: 'code.several-servers',
        severity: 'warning',
        title: 'Several servers listen on hard-coded ports: only one of them can receive HTTP traffic on PORT (8080)',
        details: portSites.map((edit) => `${edit.file}:${edit.line}  ${edit.before}`).join('\n'),
        fix: ['Make the main HTTP server listen on process.env.PORT, other servers must use other ports'],
      });
    }
    const kinds = new Set(portSites.length > 1 ? ['host'] : ['port', 'host']);
    for (const file of nodeFiles) {
      const result = fixNodeFile(scanner, file, kinds);
      if (result != null) {
        addChange(file, result.content, result.edits);
      }
    }
    const packageResult = fixPackageJson(scanner);
    if (packageResult != null) {
      addChange('package.json', packageResult.content, packageResult.edits);
    }
  }

  for (const connection of findHardcodedPhpConnections(scanner)) {
    const result = fixPhpConnection(scanner, connection);
    if (result != null) {
      addChange(connection.file, result.content, result.edits);
    }
  }

  if (report.runtime.type === 'php' && report.hasFinding('php.front-controller')) {
    changes.push({
      path: 'public/.htaccess',
      content: APACHE_FRONT_CONTROLLER,
      action: 'create',
      description: 'Send every request to index.php under Apache',
      group: 'code',
    });
    edits.push({
      file: 'public/.htaccess',
      line: 1,
      before: '',
      after: 'RewriteRule ^ index.php [L]  (front controller rules)',
      reason: 'Send every request to index.php under Apache',
    });
  }

  if (report.runtime.type === 'php' && report.composerPlatform.length > 0) {
    const composer = scanner.readJson('composer.json');
    if (composer != null) {
      composer.config = { ...composer.config, platform: { ...composer.config?.platform } };
      for (const { extension, version } of report.composerPlatform) {
        composer.config.platform[`ext-${extension}`] = version;
      }
      changes.push({
        path: 'composer.json',
        content: JSON.stringify(composer, null, 4).replaceAll('\\/', '/') + '\n',
        action: 'update',
        description: 'Resolve dependencies for the extensions of Clever Cloud (composer.lock is updated too)',
        group: 'code',
      });
    }
  }

  if (report.runtime.type === 'maven' || report.runtime.type === 'gradle') {
    const springResult = fixSpringPort(scanner);
    if (springResult != null) {
      addChange(springResult.file, springResult.content, springResult.edits);
    }
  }

  return { changes, edits, manual };
}

/**
 * @param {ProjectScanner} scanner
 * @param {string} file
 * @param {Set<string>} kinds fixes to apply
 * @returns {{ content: string, edits: CodeEdit[] }|null}
 */
function fixNodeFile(scanner, file, kinds) {
  const content = scanner.read(file);
  if (content == null || !/\.listen\(/.test(content)) {
    return null;
  }
  const lines = content.split('\n');
  const isCode = codeLineMask(file, lines);
  /** @type {CodeEdit[]} */
  const edits = [];
  for (let index = 0; index < lines.length; index++) {
    if (!isCode[index]) {
      continue;
    }
    for (const fix of NODE_LINE_FIXES.filter((candidate) => kinds.has(candidate.kind))) {
      const rewritten = fix.rewrite(lines[index], { content });
      if (rewritten != null && rewritten !== lines[index]) {
        edits.push({ file, line: index + 1, before: lines[index].trim(), after: rewritten.trim(), reason: fix.reason });
        lines[index] = rewritten;
      }
    }
  }
  return edits.length > 0 ? { content: lines.join('\n'), edits: mergeEditsByLine(edits) } : null;
}

/**
 * `next start -p 3000` ignores PORT: remove the hard-coded port from npm scripts
 * @param {ProjectScanner} scanner
 * @returns {{ content: string, edits: CodeEdit[] }|null}
 */
function fixPackageJson(scanner) {
  const content = scanner.read('package.json');
  const start = scanner.readJson('package.json')?.scripts?.start;
  if (content == null || typeof start !== 'string' || !/\bnext start\b/.test(start)) {
    return null;
  }
  const fixedStart = start.replace(/\s+(?:-p|--port)(?:\s+|=)\d+\b/, '');
  if (fixedStart === start) {
    return null;
  }
  const before = `"start": ${JSON.stringify(start)}`;
  const index = content.indexOf(before);
  if (index === -1) {
    return null;
  }
  const line = content.slice(0, index).split('\n').length;
  return {
    content: content.replace(before, `"start": ${JSON.stringify(fixedStart)}`),
    edits: [
      {
        file: 'package.json',
        line,
        before,
        after: `"start": ${JSON.stringify(fixedStart)}`,
        reason: 'Let Next.js read the PORT variable',
      },
    ],
  };
}

/**
 * @param {ProjectScanner} scanner
 * @returns {{ file: string, content: string, edits: CodeEdit[] }|null}
 */
function fixSpringPort(scanner) {
  const file = scanner.first([
    'src/main/resources/application.properties',
    'src/main/resources/application.yml',
    'src/main/resources/application.yaml',
  ]);
  const content = file != null ? scanner.read(file) : null;
  if (file == null || content == null) {
    return null;
  }
  const isProperties = file.endsWith('.properties');
  const lines = content.split('\n');
  /** @type {CodeEdit[]} */
  const edits = [];
  let inServerBlock = false;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    let rewritten = null;
    if (isProperties) {
      const match = /^(\s*server\.port\s*[=:]\s*)(\d+)\s*$/.exec(line);
      if (match != null && match[2] !== HTTP_PORT) {
        rewritten = `${match[1]}\${PORT:${HTTP_PORT}}`;
      }
    } else {
      if (/^\S/.test(line)) {
        inServerBlock = /^server:\s*$/.test(line);
      }
      const match = /^(\s+port:\s*)(\d+)\s*$/.exec(line);
      if (inServerBlock && match != null && match[2] !== HTTP_PORT) {
        rewritten = `${match[1]}\${PORT:${HTTP_PORT}}`;
      }
    }
    if (rewritten != null) {
      edits.push({
        file,
        line: index + 1,
        before: line.trim(),
        after: rewritten.trim(),
        reason: 'Listen on the PORT variable (8080 on Clever Cloud)',
      });
      lines[index] = rewritten;
    }
  }
  return edits.length > 0 ? { file, content: lines.join('\n'), edits } : null;
}

/**
 * Several fixes may touch the same line: keep one edit from the original line to the final one
 * @param {CodeEdit[]} edits
 * @returns {CodeEdit[]}
 */
function mergeEditsByLine(edits) {
  /** @type {Map<number, CodeEdit>} */
  const byLine = new Map();
  for (const edit of edits) {
    const existing = byLine.get(edit.line);
    if (existing == null) {
      byLine.set(edit.line, { ...edit });
    } else {
      existing.after = edit.after;
      if (!existing.reason.includes(edit.reason)) {
        existing.reason = `${existing.reason}, ${edit.reason.charAt(0).toLowerCase()}${edit.reason.slice(1)}`;
      }
    }
  }
  return [...byLine.values()];
}

/**
 * Read hard-coded PHP database settings from the add-on variables, keeping the current values as fallback
 * @param {ProjectScanner} scanner
 * @param {import('./rules/database.js').HardcodedConnection} connection
 * @returns {{ content: string, edits: CodeEdit[] }|null}
 */
function fixPhpConnection(scanner, connection) {
  const content = scanner.read(connection.file);
  const mapping = getAddonMapping(connection.engine.provider);
  if (content == null || mapping == null) {
    return null;
  }
  const lines = content.split('\n');
  /** @type {CodeEdit[]} */
  const edits = [];
  const reason = `Read the database settings from the ${mapping.label} add-on`;
  const edit = (/** @type {number} */ index, /** @type {string} */ rewritten) => {
    if (rewritten !== lines[index]) {
      edits.push({
        file: connection.file,
        line: index + 1,
        before: lines[index].trim(),
        after: rewritten.trim(),
        reason,
      });
      lines[index] = rewritten;
    }
  };

  for (const setting of connection.settings) {
    const variable = mapping.variables[setting.role];
    if (variable == null) {
      continue;
    }
    const index = setting.line - 1;
    const fallback = `'${setting.value.replaceAll("'", "\\'")}'`;
    if (setting.kind === 'variable') {
      edit(index, lines[index].replace(/=\s*(['"])[^'"]*\1\s*;/, `= getenv('${variable}') ?: ${fallback};`));
    } else {
      // WordPress-like DB_HOST accepts "host:port", the add-on port is not the default one
      const value =
        setting.role === 'host' && mapping.variables.port != null
          ? `getenv('${variable}') ? getenv('${variable}') . ':' . getenv('${mapping.variables.port}') : ${fallback}`
          : `getenv('${variable}') ?: ${fallback}`;
      edit(index, lines[index].replace(/,\s*(['"])[^'"]*\1\s*\)/, `, ${value})`));
    }
  }

  // Add-ons do not listen on the default port: add it to the PDO DSN
  const hasPort = connection.settings.some((setting) => setting.role === 'port');
  if (connection.dsnLine != null && connection.hostVariable != null && !hasPort && mapping.variables.port != null) {
    const portVariable = /\$port\b/.test(content) ? 'dbPort' : 'port';
    const dsnIndex = connection.dsnLine - 1;
    edit(
      dsnIndex,
      lines[dsnIndex].replace(
        new RegExp(`host=\\$${connection.hostVariable}\\b;?`),
        (match) => `${match.replace(/;$/, '')};port=$${portVariable};`,
      ),
    );
    const host = /** @type {import('./rules/database.js').HardcodedSetting} */ (
      connection.settings.find((setting) => setting.role === 'host')
    );
    const indent = /^\s*/.exec(lines[host.line - 1])?.[0] ?? '';
    const portLine = `${indent}$${portVariable} = getenv('${mapping.variables.port}') ?: '${connection.engine.defaultPort}';`;
    lines.splice(host.line, 0, portLine);
    // Lines after the insertion moved by one
    for (const existing of edits) {
      if (existing.line > host.line) {
        existing.line += 1;
      }
    }
    edits.push({ file: connection.file, line: host.line + 1, before: '', after: portLine.trim(), reason });
  }

  edits.sort((a, b) => a.line - b.line);
  return edits.length > 0 ? { content: lines.join('\n'), edits } : null;
}

/** Front controller rules for Apache, as symfony/apache-pack, with a relative target so that any CC_WEBROOT works */
const APACHE_FRONT_CONTROLLER = `# Apache front controller rules (Clever Cloud PHP runtime), generated by clever migrate apply
DirectoryIndex index.php

<IfModule mod_negotiation.c>
    Options -MultiViews
</IfModule>

<IfModule mod_rewrite.c>
    RewriteEngine On

    # Keep the Authorization header
    RewriteCond %{HTTP:Authorization} .+
    RewriteRule ^ - [E=HTTP_AUTHORIZATION:%0]

    # /index.php/foo → /foo
    RewriteCond %{ENV:REDIRECT_STATUS} =""
    RewriteRule ^index\\.php(?:/(.*)|$) /$1 [R=301,L]

    # Existing files are served directly, everything else goes to index.php
    RewriteCond %{REQUEST_FILENAME} -f
    RewriteRule ^ - [L]
    RewriteRule ^ index.php [L]
</IfModule>
`;
