// Shared newline splitter for streaming CLI stdout. Every provider adapter parses line-delimited
// output; the buffering + trailing-flush is identical, so it lives here (not copy-pasted 3×).
export async function* lines(readable: AsyncIterable<unknown>): AsyncIterable<string> {
  let buf = '';
  for await (const chunk of readable) {
    buf += typeof chunk === 'string' ? chunk : (chunk as Buffer).toString();
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      yield buf.slice(0, nl);
      buf = buf.slice(nl + 1);
    }
  }
  if (buf.length > 0) yield buf; // flush the trailing partial line
}
