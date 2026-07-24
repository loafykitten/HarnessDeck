export type DiffLine = { kind: "add" | "del" | "ctx" | "meta"; text: string };

/** Beyond this an LCS table costs more than the result is worth. */
const MAX_DIFF_LINES = 400;

/**
 * Line-level diff of two strings. Used for Edit-style permission prompts,
 * where the harness hands us `old_string`/`new_string` rather than a diff.
 */
export function lineDiff(before: string, after: string): DiffLine[] {
  const wholeA = before.split("\n");
  const wholeB = after.split("\n");

  // Trim the common prefix/suffix first: a small edit inside a large file
  // stays a small diff instead of tripping the size bailout below.
  let start = 0;
  while (start < wholeA.length && start < wholeB.length && wholeA[start] === wholeB[start]) start++;
  let endA = wholeA.length;
  let endB = wholeB.length;
  while (endA > start && endB > start && wholeA[endA - 1] === wholeB[endB - 1]) {
    endA--;
    endB--;
  }
  const head = wholeA.slice(0, start).map((text): DiffLine => ({ kind: "ctx", text }));
  const tail = wholeA.slice(endA).map((text): DiffLine => ({ kind: "ctx", text }));
  const a = wholeA.slice(start, endA);
  const b = wholeB.slice(start, endB);

  if (a.length > MAX_DIFF_LINES || b.length > MAX_DIFF_LINES) {
    return [
      ...head,
      ...a.map((text): DiffLine => ({ kind: "del", text })),
      ...b.map((text): DiffLine => ({ kind: "add", text })),
      ...tail,
    ];
  }

  // lcs[i][j] = length of the longest common subsequence of a[i:] and b[j:]
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const out: DiffLine[] = [...head];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: "ctx", text: a[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push({ kind: "del", text: a[i] });
      i++;
    } else {
      out.push({ kind: "add", text: b[j] });
      j++;
    }
  }
  while (i < a.length) out.push({ kind: "del", text: a[i++] });
  while (j < b.length) out.push({ kind: "add", text: b[j++] });
  out.push(...tail);
  return out;
}

/**
 * Classify an existing unified diff (Codex hands these over directly).
 * Leading markers are stripped so rendering matches a computed diff.
 * `+++`/`---` file headers only appear before a hunk — inside one, a line
 * like `+++counter;` is an added `++counter;`, not metadata.
 */
export function parseUnified(diff: string): DiffLine[] {
  let inHunk = false;
  return diff.split("\n").map((text): DiffLine => {
    if (text.startsWith("@@")) {
      inHunk = true;
      return { kind: "meta", text };
    }
    if (!inHunk && (text.startsWith("+++") || text.startsWith("---"))) return { kind: "meta", text };
    if (text.startsWith("+")) return { kind: "add", text: text.slice(1) };
    if (text.startsWith("-")) return { kind: "del", text: text.slice(1) };
    return { kind: "ctx", text: text.startsWith(" ") ? text.slice(1) : text };
  });
}

/** Every line of `content` as an addition — for Write-style previews. */
export function allAdded(content: string): DiffLine[] {
  return content.split("\n").map((text): DiffLine => ({ kind: "add", text }));
}
