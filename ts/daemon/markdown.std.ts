// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import {
  BodyRange,
  type BodyRange as BodyRangeType,
} from '../types/BodyRange.std.ts';

const DELIMITERS = [
  { marker: '**', style: BodyRange.Style.BOLD },
  { marker: '~~', style: BodyRange.Style.STRIKETHROUGH },
  { marker: '||', style: BodyRange.Style.SPOILER },
  { marker: '`', style: BodyRange.Style.MONOSPACE },
  { marker: '_', style: BodyRange.Style.ITALIC },
] as const;

function findUnescapedClosing(
  input: string,
  marker: string,
  start: number,
  end: number
): number | undefined {
  for (let index = start; index <= end - marker.length; index += 1) {
    if (input[index] === '\\') {
      index += 1;
      continue;
    }
    if (input.startsWith(marker, index)) return index;
  }
  return undefined;
}

type ParsedBody = Readonly<{
  body: string;
  bodyRanges: ReadonlyArray<BodyRangeType<BodyRange.Formatting>>;
}>;

function parseSegment(
  input: string,
  segmentStart: number,
  end: number
): ParsedBody {
  let output = '';
  const bodyRanges = new Array<BodyRangeType<BodyRange.Formatting>>();

  for (let index = segmentStart; index < end; ) {
    if (input[index] === '\\' && index + 1 < end) {
      output += input[index + 1];
      index += 2;
      continue;
    }
    const delimiter = DELIMITERS.find(candidate =>
      input.startsWith(candidate.marker, index)
    );
    if (!delimiter) {
      output += input[index];
      index += 1;
      continue;
    }
    const closing = findUnescapedClosing(
      input,
      delimiter.marker,
      index + delimiter.marker.length,
      end
    );
    if (closing == null) {
      output += delimiter.marker;
      index += delimiter.marker.length;
      continue;
    }
    const rangeStart = output.length;
    const inner = parseSegment(input, index + delimiter.marker.length, closing);
    if (inner.body.length === 0) {
      output += delimiter.marker.repeat(2);
      index = closing + delimiter.marker.length;
      continue;
    }
    output += inner.body;
    for (const range of inner.bodyRanges) {
      bodyRanges.push({ ...range, start: range.start + rangeStart });
    }
    bodyRanges.push({
      length: inner.body.length,
      start: rangeStart,
      style: delimiter.style,
    });
    index = closing + delimiter.marker.length;
  }

  return {
    body: output,
    bodyRanges,
  };
}

export function parseMarkdownBody(body: string): ParsedBody {
  const parsed = parseSegment(body, 0, body.length);
  return {
    ...parsed,
    bodyRanges: [...parsed.bodyRanges].sort(
      (left, right) => left.start - right.start || right.length - left.length
    ),
  };
}
