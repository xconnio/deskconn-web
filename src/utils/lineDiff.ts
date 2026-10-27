/**
 * Line-granular diff for the editor's added/modified line coloring, built on
 * diff-match-patch's line-mode helpers (already a dependency — see textPatch.ts):
 * diff_linesToChars_ collapses each line to one token so diff_main operates at
 * line granularity instead of character granularity, then diff_charsToLines_
 * expands the result back to real line text.
 */
import DiffMatchPatch from 'diff-match-patch'

export type LineDiffKind = 'added' | 'modified'
/** 1-based line number (in `current`) -> classification. */
export type LineDiffMap = Map<number, LineDiffKind>

// Diffing every keystroke on a huge file is wasted work the user will never
// see land before their next keystroke invalidates it.
// ponytail: flat size cap, not a debounce/worker — upgrade path if typing in
// large files ever feels janky.
const MAX_DIFF_SIZE = 2 * 1024 * 1024

function lineCount(text: string): number {
  if (text === '') return 0
  return text.endsWith('\n') ? text.split('\n').length - 1 : text.split('\n').length
}

export function computeLineDiff(original: string, current: string): LineDiffMap {
  const map: LineDiffMap = new Map()
  if (original === current) return map
  if (original.length > MAX_DIFF_SIZE || current.length > MAX_DIFF_SIZE) return map

  const dmp = new DiffMatchPatch()
  const { chars1, chars2, lineArray } = dmp.diff_linesToChars_(original, current)
  // No diff_cleanupSemantic here: it merges small equal spans sandwiched
  // between edits into the surrounding change for readability, which would
  // mark an untouched line 'modified' just for sitting next to a real edit.
  // The raw line-mode diff already gives the precise minimal edit we want.
  const diffs = dmp.diff_main(chars1, chars2, false)
  dmp.diff_charsToLines_(diffs, lineArray)

  let curLine = 1
  let prevOp: number | null = null
  for (const [op, text] of diffs) {
    if (op === DiffMatchPatch.DIFF_EQUAL) {
      curLine += lineCount(text)
    } else if (op === DiffMatchPatch.DIFF_INSERT) {
      const n = lineCount(text)
      const kind: LineDiffKind = prevOp === DiffMatchPatch.DIFF_DELETE ? 'modified' : 'added'
      for (let i = 0; i < n; i++) map.set(curLine + i, kind)
      curLine += n
    }
    // DIFF_DELETE: text no longer exists in `current`, nothing to color.
    prevOp = op
  }

  return map
}

// ── Review mode: full old-vs-new line listing (removed lines included) ─────
export interface ReviewLine {
  kind: 'context' | 'added' | 'removed'
  /** 1-based line number in the original / current text (null when absent). */
  oldNo: number | null
  newNo: number | null
  text: string
}
/** A run of unchanged lines collapsed out of view; `from` indexes the ReviewLine list. */
export interface ReviewFold {
  kind: 'fold'
  from: number
  count: number
}
export type ReviewRow = ReviewLine | ReviewFold

function splitLines(text: string): string[] {
  if (text === '') return []
  const lines = text.split('\n')
  if (text.endsWith('\n')) lines.pop()
  return lines
}

/** null when either side is over MAX_DIFF_SIZE. */
export function computeReviewLines(original: string, current: string): ReviewLine[] | null {
  if (original.length > MAX_DIFF_SIZE || current.length > MAX_DIFF_SIZE) return null

  const dmp = new DiffMatchPatch()
  const { chars1, chars2, lineArray } = dmp.diff_linesToChars_(original, current)
  const diffs = dmp.diff_main(chars1, chars2, false)
  dmp.diff_charsToLines_(diffs, lineArray)

  const lines: ReviewLine[] = []
  let oldNo = 1
  let newNo = 1
  for (const [op, text] of diffs) {
    for (const line of splitLines(text)) {
      if (op === DiffMatchPatch.DIFF_EQUAL) lines.push({ kind: 'context', oldNo: oldNo++, newNo: newNo++, text: line })
      else if (op === DiffMatchPatch.DIFF_DELETE) lines.push({ kind: 'removed', oldNo: oldNo++, newNo: null, text: line })
      else lines.push({ kind: 'added', oldNo: null, newNo: newNo++, text: line })
    }
  }
  return lines
}

/** Keeps `context` unchanged lines around each change and folds the rest,
 * except runs whose fold start is in `expanded` (or a single line, which a
 * fold row wouldn't save any space on). */
export function foldReviewLines(lines: ReviewLine[], context: number, expanded: ReadonlySet<number>): ReviewRow[] {
  const keep = new Array<boolean>(lines.length).fill(false)
  lines.forEach((line, i) => {
    if (line.kind === 'context') return
    for (let j = Math.max(0, i - context); j <= Math.min(lines.length - 1, i + context); j++) keep[j] = true
  })

  const rows: ReviewRow[] = []
  let i = 0
  while (i < lines.length) {
    if (keep[i]) {
      rows.push(lines[i]!)
      i++
      continue
    }
    let end = i
    while (end < lines.length && !keep[end]) end++
    if (end - i === 1 || expanded.has(i)) rows.push(...lines.slice(i, end))
    else rows.push({ kind: 'fold', from: i, count: end - i })
    i = end
  }
  return rows
}
