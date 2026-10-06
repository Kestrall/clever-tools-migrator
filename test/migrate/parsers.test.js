import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { findServiceMapping, guessVariableRole } from '../../src/models/migrate/catalog.js';
import {
  analyzeDockerfile,
  parseDockerfileInstructions,
  parseEnvInstruction,
} from '../../src/models/migrate/dockerfile.js';
import { shellQuote } from '../../src/models/migrate/report.js';
import { findMainService, parseCompose } from '../../src/models/migrate/rules/docker.js';

describe('dockerfile parser', () => {
  it('joins continuation lines and skips comments', () => {
    const instructions = parseDockerfileInstructions(
      'FROM node:22\n# comment\nRUN apt-get update \\\n  && apt-get install -y curl\nCMD ["node", "app.js"]\n',
    );
    assert.deepEqual(
      instructions.map((instruction) => instruction.name),
      ['FROM', 'RUN', 'CMD'],
    );
    assert.match(instructions[1].value, /^apt-get update\s+&& apt-get install -y curl$/);
    assert.equal(instructions[2].line, 5);
  });

  it('only keeps the final stage for ports, volumes and env', () => {
    const summary = analyzeDockerfile(
      'FROM golang:1.23 AS build\nEXPOSE 9999\nENV CGO_ENABLED=0\nFROM gcr.io/distroless/static\nENV PORT=8000\nEXPOSE ${PORT}/tcp\nVOLUME ["/data"]\nENTRYPOINT ["/app"]\n',
    );
    assert.deepEqual(summary.baseImages, ['golang:1.23', 'gcr.io/distroless/static']);
    assert.deepEqual(summary.exposedPorts, [8000]);
    assert.deepEqual(summary.volumes, ['/data']);
    assert.deepEqual(summary.env, { PORT: '8000' });
    assert.equal(summary.hasEntrypoint, true);
    assert.equal(summary.hasCmd, false);
    assert.equal(summary.cmd, '/app');
  });

  it('parses both ENV syntaxes', () => {
    assert.deepEqual(parseEnvInstruction('A=1 B="two words" C=\'x\''), { A: '1', B: 'two words', C: 'x' });
    assert.deepEqual(parseEnvInstruction('NODE_ENV production'), { NODE_ENV: 'production' });
  });
});

describe('compose parser', () => {
  const services = parseCompose(`
services:
  web:
    build:
      context: .
      dockerfile: docker/Dockerfile
    ports: ["127.0.0.1:8000:3000/tcp", { target: 9229, published: 9229 }]
    environment: ["A=1", "B"]
    env_file: [.env, { path: .env.local }]
  db:
    image: postgres:16
`);

  it('normalizes services', () => {
    const web = services[0];
    assert.deepEqual(web.build, { context: '.', dockerfile: 'docker/Dockerfile' });
    assert.deepEqual(web.ports, [
      { published: '8000', target: 3000 },
      { published: '9229', target: 9229 },
    ]);
    assert.deepEqual(web.environment, { A: '1', B: null });
    assert.deepEqual(web.envFiles, ['.env', '.env.local']);
  });

  it('finds the application service', () => {
    assert.equal(findMainService(services)?.name, 'web');
  });
});

describe('catalog', () => {
  it('maps images to add-ons', () => {
    assert.equal(findServiceMapping('postgres:16-alpine')?.kind, 'addon');
    assert.equal(/** @type {any} */ (findServiceMapping('docker.io/library/mariadb:11'))?.provider, 'mysql-addon');
    assert.equal(/** @type {any} */ (findServiceMapping('bitnami/redis'))?.provider, 'redis-addon');
    assert.equal(findServiceMapping('traefik:v3')?.kind, 'not-needed');
    assert.equal(findServiceMapping('rabbitmq:3-management')?.kind, 'unsupported');
    assert.equal(findServiceMapping('my-company/api:1.0'), null);
    assert.equal(findServiceMapping('postgresql-client'), null);
  });

  it('guesses which add-on variable replaces a variable', () => {
    assert.equal(guessVariableRole('DATABASE_URL'), 'uri');
    assert.equal(guessVariableRole('DB_HOST'), 'host');
    assert.equal(guessVariableRole('POSTGRES_PASSWORD'), 'password');
    assert.equal(guessVariableRole('LOG_LEVEL'), null);
  });
});

describe('shellQuote', () => {
  it('quotes only when needed', () => {
    assert.equal(shellQuote('/public'), '/public');
    assert.equal(shellQuote('npm ci && npm run build'), "'npm ci && npm run build'");
    assert.equal(shellQuote("it's"), `'it'\\''s'`);
  });
});
