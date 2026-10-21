import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Error text in dark mode lands on the card surface and on the 10 to 20 percent error tints that
// pills and danger buttons paint over it, so it has to clear WCAG AA (4.5:1) on the darkest of those.

const CSS = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'App.css'), 'utf8');

const rgb = (hex: string): number[] => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
const luminance = (c: number[]): number => {
  const [r, g, b] = c.map(v => (v / 255 <= 0.03928 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: number[], b: number[]): number => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
const token = (block: string, name: string): string => {
  const value = block.match(new RegExp(`${name}:\\s*(#[0-9a-f]{6})`, 'i'))?.[1];
  assert.ok(value, `${name} is not a hex colour in the block`);
  return value;
};
const blockAfter = (anchor: string): string => {
  const from = CSS.indexOf(anchor);
  assert.notEqual(from, -1, `App.css no longer contains "${anchor}"`);
  return CSS.slice(from, CSS.indexOf('}', from));
};

test('dark --error-text clears AA on every error tint it lands on, in both dark blocks', () => {
  const error = rgb(token(blockAfter(':root {'), '--error'));
  for (const anchor of ["[data-theme='dark'] {", ":root:not([data-theme='light']) {"]) {
    const block = blockAfter(anchor);
    const text = rgb(token(block, '--error-text'));
    const surface = rgb(token(block, '--bg-white'));
    for (const alpha of [0, 0.1, 0.12, 0.15, 0.18, 0.2]) {
      const bg = error.map((c, i) => c * alpha + surface[i] * (1 - alpha));
      const ratio = contrast(text, bg);
      assert.ok(ratio >= 4.5, `${anchor} --error-text is ${ratio.toFixed(2)}:1 on a ${alpha * 100}% error tint`);
    }
  }
});

// The chat page's own palette (pages/Chats.css): every text token against every surface it lands on, in the
// light set and both dark sets. Light --chat-panel is the app's white card, so it resolves through App.css.
const CHATS_CSS = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'pages', 'Chats.css'), 'utf8');
const chatBlock = (anchor: string): string => {
  const from = CHATS_CSS.indexOf(anchor);
  assert.notEqual(from, -1, `Chats.css no longer contains "${anchor}"`);
  return CHATS_CSS.slice(from, CHATS_CSS.indexOf('}', from));
};
const chatToken = (block: string, name: string): string =>
  block.match(new RegExp(`${name}:\\s*var\\(--bg-white\\)`))
    ? token(blockAfter(':root {'), '--bg-white')
    : token(block, name);

const CHAT_TEXT_ON: Array<[string, string[]]> = [
  ['--chat-meta', ['--chat-panel', '--chat-hover', '--chat-active', '--chat-bubble-in']],
  ['--chat-accent-text', ['--chat-panel', '--chat-hover', '--chat-active']],
  ['--chat-meta-out', ['--chat-bubble-out']],
];

for (const anchor of [
  '.chats-page {',
  "[data-theme='dark'] .chats-page {",
  ":root:not([data-theme='light']) .chats-page {",
]) {
  test(`chat text clears AA on every surface it lands on (${anchor})`, () => {
    const block = chatBlock(anchor);
    for (const [text, surfaces] of CHAT_TEXT_ON) {
      for (const surface of surfaces) {
        const ratio = contrast(rgb(chatToken(block, text)), rgb(chatToken(block, surface)));
        assert.ok(ratio >= 4.5, `${anchor} ${text} is ${ratio.toFixed(2)}:1 on ${surface}`);
      }
    }
  });
}
