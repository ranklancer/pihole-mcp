import { test } from 'node:test';
import assert from 'node:assert/strict';
import { looksLikeRegex } from '../../types.js';

test('looksLikeRegex: plain domains are exact', () => {
  for (const d of ['example.com', 'sub.example.co.uk', 'a-b.example.org', 'xn--bcher-kva.example', 'localhost']) {
    assert.equal(looksLikeRegex(d), false, d);
  }
});

test('looksLikeRegex: any regex metacharacter routes to regex', () => {
  for (const d of ['^ads\\..*$', '(^|\\.)tracker\\.com$', 'ads?.example.com', 'a|b.com', '[0-9]+.example.com', 'x{2}.com', '*.example.com']) {
    assert.equal(looksLikeRegex(d), true, d);
  }
});
