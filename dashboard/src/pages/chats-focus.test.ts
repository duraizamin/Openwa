// Keyboard focus on the chat page stays visible: no `:focus-visible` rule in Chats.css may remove the outline
// the app draws for focus (index.css), since a hover-like tint alone is too faint to tell which control has it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const CSS = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'Chats.css'), 'utf8').replace(
  /\/\*[\s\S]*?\*\//g,
  '',
);

test('no :focus-visible rule in Chats.css removes the focus outline', () => {
  const offending: string[] = [];
  for (const [, selectors, body] of CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (selectors.includes(':focus-visible') && /outline\s*:\s*(none|0)\b/.test(body)) {
      offending.push(selectors.trim().replace(/\s+/g, ' '));
    }
  }
  assert.deepEqual(offending, []);
});
