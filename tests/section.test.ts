import assert from 'node:assert/strict';
import { test } from 'node:test';
import { headingFromText } from '../src/domain/section.js';

test('recovers a numbered heading after the printed page number', () => {
  assert.equal(headingFromText('447 9.4稳压管稳压电路\n从稳压管稳压电路可得两个基本关系式'), '9.4 稳压管稳压电路');
});

test('strips a trailing bracket left by a two-column split', () => {
  assert.equal(headingFromText('9.4稳压管稳压电路 (\n正文'), '9.4 稳压管稳压电路');
});

test('ignores formula and figure heads that start with a number', () => {
  assert.equal(headingFromText('3.3V 供电时的电流\n图9.4.2稳压管的伏安特性'), undefined);
  assert.equal(headingFromText('图9.4.2稳压管的伏安特性'), undefined);
});

test('ignores long lines, which are body text rather than a heading', () => {
  const long = '9.4' + '稳压管'.repeat(20);
  assert.equal(headingFromText(long), undefined);
});
