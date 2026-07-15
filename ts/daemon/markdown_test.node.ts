// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BodyRange } from '../types/BodyRange.std.ts';
import { parseMarkdownBody } from './markdown.std.ts';

void test('parses supported markdown-like formatting', () => {
  assert.deepEqual(
    parseMarkdownBody(
      '**bold** _italic_ ~~strike~~ `mono` ||secret|| and 😀 **emoji**'
    ),
    {
      body: 'bold italic strike mono secret and 😀 emoji',
      bodyRanges: [
        { length: 4, start: 0, style: BodyRange.Style.BOLD },
        { length: 6, start: 5, style: BodyRange.Style.ITALIC },
        { length: 6, start: 12, style: BodyRange.Style.STRIKETHROUGH },
        { length: 4, start: 19, style: BodyRange.Style.MONOSPACE },
        { length: 6, start: 24, style: BodyRange.Style.SPOILER },
        { length: 5, start: 38, style: BodyRange.Style.BOLD },
      ],
    }
  );
});

void test('supports nesting, escapes, and unmatched literal markers', () => {
  assert.deepEqual(
    parseMarkdownBody('**bold _and italic_** \\*\\*literal\\*\\* ~~open ****'),
    {
      body: 'bold and italic **literal** ~~open ****',
      bodyRanges: [
        { length: 15, start: 0, style: BodyRange.Style.BOLD },
        { length: 10, start: 5, style: BodyRange.Style.ITALIC },
      ],
    }
  );
});
