import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { judgeLink } from '../src/domain/link-policy.js';
import { note } from './fixtures/note.js';

const concept = note({ path: '学习/硬件/概念/镜像电流源.md', kind: 'concept' });
const thought = note({ path: '项目/电流源选型.md', kind: 'thought' });
const why = '这里用镜像电流源解释偏置电流的温漂，定义页没有覆盖温漂这一维。';

function codeOf(r: { ok: boolean; error?: { code: string } }): string {
  return r.ok ? 'accepted' : String(r.error?.code);
}

describe('link policy', () => {
  it('accepts a thought -> concept link that states a relationship', () => {
    const r = judgeLink({
      from: thought,
      to: concept,
      alreadyLinked: false,
      proposal: { fromPath: thought.path, toPath: concept.path, reason: 'refinement', why },
    });
    assert.equal(codeOf(r), 'accepted');
  });

  it('rejects filler why', () => {
    for (const filler of ['相关', '参考', 'see also']) {
      const r = judgeLink({
        from: thought,
        to: concept,
        alreadyLinked: false,
        proposal: { fromPath: thought.path, toPath: concept.path, reason: 'first-occurrence', why: filler },
      });
      assert.equal(codeOf(r), 'link.why-empty', filler);
    }
  });

  it('rejects a note linking to itself', () => {
    const r = judgeLink({
      from: concept,
      to: concept,
      alreadyLinked: false,
      proposal: { fromPath: concept.path, toPath: concept.path, reason: 'first-occurrence', why },
    });
    assert.equal(codeOf(r), 'link.self');
  });

  it('rejects a non-definition target', () => {
    const log = note({ path: '随记/今天.md', kind: 'log' });
    const r = judgeLink({
      from: thought,
      to: log,
      alreadyLinked: false,
      proposal: { fromPath: thought.path, toPath: log.path, reason: 'new-application', why },
    });
    assert.equal(codeOf(r), 'link.target-not-definition');
  });

  it('rejects duplicates', () => {
    const r = judgeLink({
      from: thought,
      to: concept,
      alreadyLinked: true,
      proposal: { fromPath: thought.path, toPath: concept.path, reason: 'first-occurrence', why },
    });
    assert.equal(codeOf(r), 'link.duplicate');
  });
});
