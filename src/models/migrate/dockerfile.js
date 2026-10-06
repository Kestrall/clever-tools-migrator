/**
 * @typedef {object} DockerInstruction
 * @property {string} name instruction name, uppercased
 * @property {string} value raw arguments
 * @property {number} line 1-based line where the instruction starts
 */

/**
 * @typedef {object} DockerfileSummary
 * @property {DockerInstruction[]} instructions
 * @property {string[]} baseImages
 * @property {number[]} exposedPorts
 * @property {string[]} volumes
 * @property {Array<{ name: string, hasDefault: boolean }>} args
 * @property {Record<string, string>} env env defined in the final stage
 * @property {boolean} hasCmd
 * @property {boolean} hasEntrypoint
 * @property {boolean} hasHealthcheck
 * @property {string|null} cmd
 */

/**
 * Split a Dockerfile into instructions, handling line continuations and comments
 * @param {string} content
 * @returns {DockerInstruction[]}
 */
export function parseDockerfileInstructions(content) {
  const instructions = [];
  const lines = content.split(/\r?\n/);
  let buffer = '';
  let startLine = 0;
  let escapeChar = '\\';

  for (let index = 0; index < lines.length; index++) {
    const rawLine = lines[index];
    const trimmed = rawLine.trim();

    const directive = /^#\s*escape\s*=\s*(\S)/i.exec(trimmed);
    if (directive != null && instructions.length === 0 && buffer === '') {
      escapeChar = directive[1];
      continue;
    }
    if (trimmed.startsWith('#') || (trimmed === '' && buffer === '')) {
      continue;
    }
    if (buffer === '') {
      startLine = index + 1;
    }
    if (trimmed.endsWith(escapeChar)) {
      buffer += trimmed.slice(0, -1) + ' ';
      continue;
    }
    buffer += trimmed;
    pushInstruction(instructions, buffer, startLine);
    buffer = '';
  }
  if (buffer !== '') {
    pushInstruction(instructions, buffer, startLine);
  }
  return instructions;
}

/**
 * @param {DockerInstruction[]} instructions
 * @param {string} text
 * @param {number} line
 */
function pushInstruction(instructions, text, line) {
  const match = /^(\w+)\s*(.*)$/s.exec(text.trim());
  if (match != null) {
    instructions.push({ name: match[1].toUpperCase(), value: match[2].trim(), line });
  }
}

/**
 * @param {string} content
 * @returns {DockerfileSummary}
 */
export function analyzeDockerfile(content) {
  const instructions = parseDockerfileInstructions(content);

  // Only the last stage ends up in the final image
  const lastFromIndex = instructions.findLastIndex((instruction) => instruction.name === 'FROM');
  const finalStage = lastFromIndex === -1 ? instructions : instructions.slice(lastFromIndex);

  /** @type {Record<string, string>} */
  const env = {};
  for (const instruction of finalStage.filter((i) => i.name === 'ENV')) {
    Object.assign(env, parseEnvInstruction(instruction.value));
  }

  const exposedPorts = finalStage
    .filter((instruction) => instruction.name === 'EXPOSE')
    .flatMap((instruction) => instruction.value.split(/\s+/))
    .map((port) => resolveVariables(port, env))
    .map((port) => parseInt(port.split('/')[0], 10))
    .filter((port) => Number.isInteger(port));

  const volumes = finalStage
    .filter((instruction) => instruction.name === 'VOLUME')
    .flatMap((instruction) => parseListValue(instruction.value));

  const args = instructions
    .filter((instruction) => instruction.name === 'ARG')
    .map((instruction) => {
      const [name, ...rest] = instruction.value.split('=');
      return { name: name.trim(), hasDefault: rest.length > 0 };
    });

  const cmdInstruction = finalStage.findLast((instruction) => instruction.name === 'CMD');
  const entrypointInstruction = finalStage.findLast((instruction) => instruction.name === 'ENTRYPOINT');

  return {
    instructions,
    baseImages: instructions
      .filter((instruction) => instruction.name === 'FROM')
      .map((instruction) => instruction.value.replace(/--platform=\S+\s+/, '').split(/\s+/)[0]),
    exposedPorts: [...new Set(exposedPorts)],
    volumes,
    args,
    env,
    hasCmd: cmdInstruction != null,
    hasEntrypoint: entrypointInstruction != null,
    hasHealthcheck: finalStage.some((instruction) => instruction.name === 'HEALTHCHECK'),
    cmd:
      [entrypointInstruction, cmdInstruction]
        .filter((instruction) => instruction != null)
        .map((instruction) => parseListValue(instruction.value).join(' '))
        .join(' ') || null,
  };
}

/**
 * Parse `ENV KEY=value OTHER="x y"` and the legacy `ENV KEY value` syntax
 * @param {string} value
 * @returns {Record<string, string>}
 */
export function parseEnvInstruction(value) {
  /** @type {Record<string, string>} */
  const result = {};
  if (!/^[\w.-]+=/.test(value)) {
    const [key, ...rest] = value.split(/\s+/);
    result[key] = unquote(rest.join(' '));
    return result;
  }
  const pairPattern = /([\w.-]+)=("(?:[^"\\]|\\.)*"|'[^']*'|\S*)/g;
  let match;
  while ((match = pairPattern.exec(value)) != null) {
    result[match[1]] = unquote(match[2]);
  }
  return result;
}

/**
 * Parse a JSON array form (`["a", "b"]`) or a shell form value
 * @param {string} value
 * @returns {string[]}
 */
function parseListValue(value) {
  if (value.startsWith('[')) {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) {
        return parsed.map(String);
      }
    } catch {
      // fallback to shell form
    }
  }
  return value.split(/\s+/).filter((item) => item !== '');
}

/**
 * @param {string} value
 * @param {Record<string, string>} env
 * @returns {string}
 */
function resolveVariables(value, env) {
  return value.replace(/\$\{?(\w+)(?::-([^}]*))?\}?/g, (_, name, fallback) => env[name] ?? fallback ?? '');
}

/**
 * @param {string} value
 * @returns {string}
 */
function unquote(value) {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}
