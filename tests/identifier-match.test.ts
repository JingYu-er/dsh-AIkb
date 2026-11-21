import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractIdentifiers, identifierBoost, matchIdentifiers, normalizeIdentifier } from '../src/application/identifier-match.js';

test('normalizeIdentifier folds dash variants, spaces and case', () => {
  assert.equal(normalizeIdentifier('gb/t 1234'), 'GB/T1234');
  assert.equal(normalizeIdentifier('STM32F103\u2013C8T6'), 'STM32F103-C8T6');
  assert.equal(normalizeIdentifier('  pa0 '), 'PA0');
});

test('extractIdentifiers finds standards, sections, parts, registers and pins', () => {
  const ids = extractIdentifiers('见 GB/T 1234 与 ISO 9001，第 3.2.1 节，芯片 STM32F103C8T6，脚 PA0，寄存器 RCC_CR。');
  assert.ok(ids.includes('GB/T1234'));
  assert.ok(ids.includes('ISO9001'));
  assert.ok(ids.includes('3.2.1'));
  assert.ok(ids.includes('STM32F103C8T6'));
  assert.ok(ids.includes('PA0'));
  assert.ok(ids.includes('RCC_CR'));
});

test('extractIdentifiers ignores values with units and plain numbers', () => {
  const ids = extractIdentifiers('电压 3.3V，电流 100mA，电容 100nF，温度 25，共 12 页。');
  assert.deepEqual(ids, []);
});

test('matchIdentifiers matches only identifiers that literally occur', () => {
  const text = 'STM32F103C8T6 的 PA0 脚在第 3.2.1 节，工作电压 3.3V。';
  const hit = matchIdentifiers('STM32F103C8T6 的 PA0 怎么接，见 3.2.1 节', text);
  assert.deepEqual(hit.matched.slice().sort(), ['3.2.1', 'PA0', 'STM32F103C8T6']);
  assert.ok(hit.score > 0);

  const miss = matchIdentifiers('STM32F401 的 PA0 怎么接', text);
  assert.deepEqual(miss.matched, ['PA0']);
});

test('a rarer identifier outweighs a section number', () => {
  const query = 'GB/T 1234 与 3.2.1';
  const standards = matchIdentifiers(query, 'GB/T 1234 定义了量具标准。');
  const section = matchIdentifiers(query, '第 3.2.1 节给出限值。');
  assert.ok(standards.score > section.score);
});

test('repeats help but are capped', () => {
  const once = matchIdentifiers('ISO 9001', 'ISO 9001');
  const many = matchIdentifiers('ISO 9001', 'ISO 9001 ISO 9001 ISO 9001 ISO 9001 ISO 9001');
  assert.ok(many.score > once.score);
  assert.equal(many.score, 9, 'three capped occurrences of a weight-3 standard');
});

test('queries without identifiers never score', () => {
  assert.deepEqual(matchIdentifiers('怎么配置时钟', '时钟配置见另一章'), { matched: [], score: 0 });
  assert.deepEqual(matchIdentifiers('', 'STM32F103'), { matched: [], score: 0 });
  assert.deepEqual(matchIdentifiers('ISO 9001', ''), { matched: [], score: 0 });
});

test('identifierBoost lifts a page that carries the named identifier', () => {
  assert.equal(identifierBoost('GB/T 19001 质量管理', '见 GB/T 19001 第 4 章'), 1.45);
  assert.equal(identifierBoost('GB/T 19001', '见 GB∕T 19001 第 4 章'), 1.45, 'a PDF division slash still matches');
  assert.equal(identifierBoost('GB/T 19001', '质量管理体系要求'), 1);
  assert.equal(identifierBoost('怎么配置时钟', '时钟配置见另一章'), 1, 'plain prose never boosts');
});

test('the boost is capped so one repeated number cannot dominate', () => {
  const once = identifierBoost('ISO 9001', 'ISO 9001');
  const many = identifierBoost('ISO 9001', 'ISO 9001 '.repeat(20));
  assert.ok(once > 1);
  assert.equal(many, 1.75, 'cap is 1 + 0.75');
});
