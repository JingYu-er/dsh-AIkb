import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const skill = new URL('../../skills/kb-search/SKILL.md', import.meta.url);
const skillReadme = new URL('../../skills/kb-search/README.md', import.meta.url);
const pkgPath = new URL('../../package.json', import.meta.url);
const patchPath = new URL('../../cordis.patch.yml', import.meta.url);

describe('shipped kb-search skill', () => {
  it('ships a skill file with the frontmatter the loader needs', () => {
    const text = readFileSync(skill, 'utf8');
    assert.match(text, /^---\r?\n/);
    assert.match(text, /\nname: kb-search\r?\n/);
    assert.match(text, /\ndescription: >-\r?\n/);
    assert.match(text, /\nlicense: MIT\r?\n/);
    assert.ok(text.length > 3000, 'the body must carry the full search procedure');
  });

  it('keeps a short readme beside the skill', () => {
    const text = readFileSync(skillReadme, 'utf8');
    assert.ok(text.length > 100);
    assert.match(text, /kb_query/);
  });

  it('packs the skills directory', () => {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { files?: string[] };
    assert.ok(pkg.files?.includes('skills'), 'files must include skills');
  });

  it('mounts a skill provider from the plugin bundle', () => {
    const patch = readFileSync(patchPath, 'utf8');
    assert.match(patch, /dsh-skill-filesystem/);
    assert.match(patch, /providerName: dsh-kb-plugin/);
    assert.match(patch, /resolve\('dsh-kb\/package\.json'\)/);
    assert.match(patch, /'skills'/);
  });
});
