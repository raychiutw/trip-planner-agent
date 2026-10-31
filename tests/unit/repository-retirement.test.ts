import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '../..');

function activeRepositoryMatches(pattern: string) {
  const result = spawnSync(
    'git',
    [
      'grep',
      '-Iin',
      '-e',
      pattern,
      '--',
      '.',
      ':!CHANGELOG.md',
      ':!tests/unit/repository-retirement.test.ts',
    ],
    { cwd: REPO_ROOT, encoding: 'utf8' },
  );

  if (result.status === 1) return [];
  if (result.status !== 0) {
    throw new Error(result.stderr || `git grep failed with status ${result.status}`);
  }

  return result.stdout.trim().split(/\r?\n/).filter(Boolean);
}

describe('retired specification frameworks stay out of the repository', () => {
  it('daily-check does not restore retired YAML configuration readers', () => {
    const source = readFileSync(resolve(REPO_ROOT, 'scripts/daily-check.js'), 'utf8');

    expect(source).not.toContain('openspec/config.yaml');
    expect(source).not.toContain('loadConfigYaml');
  });

  it('has no active OpenSpec artifacts or references', () => {
    const artifactRoot = resolve(REPO_ROOT, 'openspec');
    const matches = activeRepositoryMatches('openspec');

    expect({
      exists: existsSync(artifactRoot),
      count: matches.length,
      sample: matches.slice(0, 20),
    }).toEqual({
      exists: false,
      count: 0,
      sample: [],
    });
  });

  it('has no active GBrain references', () => {
    const matches = activeRepositoryMatches('gbrain');

    expect({ count: matches.length, sample: matches.slice(0, 20) }).toEqual({
      count: 0,
      sample: [],
    });
  });

  it('has no active Superpowers document artifacts or references', () => {
    const documentRoot = resolve(REPO_ROOT, 'docs/superpowers');
    const matches = activeRepositoryMatches('docs/superpowers');

    expect({ exists: existsSync(documentRoot), count: matches.length }).toEqual({
      exists: false,
      count: 0,
    });
  });
});
