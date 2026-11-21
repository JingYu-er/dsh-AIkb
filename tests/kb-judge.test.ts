import assert from 'node:assert/strict';
import { test } from 'node:test';

import { judgePair } from '../src/application/kb-judge.js';

test('differing numbers on the same attribute are a conflict', () => {
  const outcome = judgePair('共模增益是 20 dB 左右，仍然很小', '共模增益是 40 dB，比差模大');
  assert.equal(outcome.verdict, '冲突');
  assert.match(outcome.basis, /20/);
});

test('equal numbers are the same statement, not a conflict', () => {
  assert.equal(judgePair('输入电阻是 10 kΩ', '输入电阻约为 10 kΩ').verdict, '无关');
});

test('one side negating the other is a conflict', () => {
  const outcome = judgePair('差分电路不会放大共模信号', '差分电路会放大共模信号');
  assert.equal(outcome.verdict, '冲突');
  assert.match(outcome.basis, /否定/);
});

test('different units are left to the agent stage', () => {
  assert.equal(judgePair('电源电压是 5 V', '电源电压是 5000 mV').verdict, '待复核');
});

test('an empty excerpt is never judged', () => {
  assert.equal(judgePair('', '共模增益是 40 dB').verdict, '待复核');
});
