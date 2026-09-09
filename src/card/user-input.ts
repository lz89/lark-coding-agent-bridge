/**
 * Markdown for a message the user sent mid-run, as both reply modes show it.
 *
 * Every line is quoted, blank ones included. A quote that only covers the
 * first line lets the second paragraph — or the next sender in a merged batch
 * — fall out of the quote and read as the agent's own words, which is the one
 * thing this block must never do.
 */
export function quoteUserInput(content: string): string {
  const lines = content.replace(/\r\n?/g, '\n').split('\n');
  return lines
    .map((line, i) => {
      const body = i === 0 ? `💬 ${line}` : line;
      return body ? `> ${body}` : '>';
    })
    .join('\n');
}
