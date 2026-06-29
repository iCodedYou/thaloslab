import { describe, expect, it } from 'vitest';
import { lines } from './stream';

async function* chunks(...cs: string[]): AsyncIterable<string> {
  for (const c of cs) yield c;
}

async function collect(it: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const l of it) out.push(l);
  return out;
}

describe('util/stream lines()', () => {
  it('splits across chunk boundaries and flushes a trailing partial line', async () => {
    expect(await collect(lines(chunks('a\nb', 'c\n', 'd')))).toEqual(['a', 'bc', 'd']);
  });
  it('emits empty lines between consecutive newlines', async () => {
    expect(await collect(lines(chunks('\n\nx\n')))).toEqual(['', '', 'x']);
  });
  it('no trailing flush when input ends on a newline', async () => {
    expect(await collect(lines(chunks('one\ntwo\n')))).toEqual(['one', 'two']);
  });
});
