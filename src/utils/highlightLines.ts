/**
 * Splits highlight.js HTML output into one HTML string per source line, so a
 * file highlighted as a whole (multi-line comments/strings stay correct) can
 * be shown line by line. A span open across a line break is closed at the end
 * of the line and reopened at the start of the next. hljs output is only
 * `<span class="…">`, `</span>` and escaped text, which is all this handles.
 */
export function splitHighlightedLines(html: string): string[] {
  const lines: string[] = []
  const open: string[] = []
  let line = ''
  for (const part of html.split(/(<span[^>]*>|<\/span>|\n)/)) {
    if (part === '\n') {
      lines.push(line + '</span>'.repeat(open.length))
      line = open.join('')
    } else if (part.startsWith('<span')) {
      open.push(part)
      line += part
    } else if (part === '</span>') {
      open.pop()
      line += part
    } else {
      line += part
    }
  }
  lines.push(line + '</span>'.repeat(open.length))
  return lines
}
