import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { claimConflict, claimsByKey, extractClaims } from '../src/application/kb-claims.js';

function claim(key: string, value: string) {
  return { key, rawKey: key, value, sentence: '' };
}

describe('claim extraction', () => {
  it('reads a parameter table row and a copula sentence', () => {
    const claims = extractClaims(['| 稳压值 | 3.3 V |', '稳压管的稳压值 为 5 V'].join('\n'));
    assert.equal(claims.length, 2);
    assert.deepEqual(claims.map((c) => c.value), ['3.3 V', '5 V']);
  });

  it('reads key: value lines and ignores urls', () => {
    const claims = extractClaims(['波特率: 115200', '来源: https://example.com/3.3'].join('\n'));
    assert.deepEqual(claims.map((c) => [c.key, c.value]), [['波特率', '115200']]);
  });

  it('skips fenced code and file metadata', () => {
    const body = ['---', 'type: concept', '---', '```c', 'baud = 9600;', '```'].join('\n');
    assert.deepEqual(extractClaims(body), []);
  });

  it('extracts nothing comparable from two tutorials', () => {
    const ssh = ['1. 安装 OpenSSH 服务', '2. 启动 sshd 服务', '3. 放行端口 22'].join('\n');
    const vscode = ['1. 安装 VSCode 插件 Remote-SSH', '2. 新建连接 用户名 主机'].join('\n');
    const left = extractClaims(ssh);
    const right = extractClaims(vscode);
    const shared = left.filter((a) => right.some((b) => claimConflict(a, b) !== undefined));
    assert.deepEqual(shared, []);
  });
});

describe('claim conflict', () => {
  it('flags one attribute with two values', () => {
    const basis = claimConflict(claim('稳压值', '3.3 V'), claim('稳压值', '5 V'));
    assert.match(String(basis), /稳压值/);
    assert.match(String(basis), /3\.3 V/);
  });

  it('treats convertible units as the same value', () => {
    assert.equal(claimConflict(claim('开关频率', '1000 Hz'), claim('开关频率', '1 kHz')), undefined);
    assert.equal(claimConflict(claim('稳压值', '3.3 V'), claim('稳压值', '3300 mV')), undefined);
  });

  it('does not compare different attributes or different unit families', () => {
    assert.equal(claimConflict(claim('稳压值', '3.3 V'), claim('限流值', '3.3 V')), undefined);
    assert.equal(claimConflict(claim('上限', '3.3 V'), claim('上限', '5 A')), undefined);
  });

  it('flags opposite polarity and refines containment', () => {
    assert.notEqual(claimConflict(claim('支持 DMA', '支持'), claim('支持 DMA', '不支持')), undefined);
    assert.equal(claimConflict(claim('输出级', '推挽'), claim('输出级', '推挽输出')), undefined);
  });

  it('groups claims by attribute only', () => {
    const index = claimsByKey(extractClaims(['| 稳压值 | 3.3 V |', '| 限流值 | 200 mA |'].join('\n')));
    assert.equal(index.size, 2);
    assert.ok(index.has('稳压值'));
    assert.ok(index.has('限流值'));
  });
});
