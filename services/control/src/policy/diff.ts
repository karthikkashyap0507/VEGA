/**
 * A line diff (longest common subsequence) for the policy console's side-by-side view of two
 * versions (docs/module5.md §6.1). Policies are short: the quadratic table is a few KB.
 */
export type DiffLine = { op: 'same' | 'add' | 'del'; text: string };

export function lineDiff(a: string, b: string): DiffLine[] {
  const x = a.split('\n');
  const y = b.split('\n');
  const n = x.length;
  const m = y.length;
  const L: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i]![j] = x[i] === y[j] ? L[i + 1]![j + 1]! + 1 : Math.max(L[i + 1]![j]!, L[i]![j + 1]!);
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) {
      out.push({ op: 'same', text: x[i]! });
      i++;
      j++;
    } else if (L[i + 1]![j]! >= L[i]![j + 1]!) out.push({ op: 'del', text: x[i++]! });
    else out.push({ op: 'add', text: y[j++]! });
  }
  while (i < n) out.push({ op: 'del', text: x[i++]! });
  while (j < m) out.push({ op: 'add', text: y[j++]! });
  return out;
}
