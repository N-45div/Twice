// Hostile delivery orders for a list of events given in their true order.
// Each schedule is a list of indexes into that list, so repeats are retries.

export function schedules(n) {
  const all = [...Array(n).keys()];
  const list = [
    { name: 'In order', why: 'The order every test suite uses.', order: all },
    { name: 'Every event twice', why: 'Stripe can deliver the same event more than once.', order: all.flatMap((i) => [i, i]) },
    { name: 'Fully reversed', why: 'Stripe does not guarantee event order.', order: [...all].reverse() },
  ];
  for (let i = 0; i < n - 1; i++) {
    const order = [...all];
    [order[i], order[i + 1]] = [order[i + 1], order[i]];
    list.push({ name: `Events ${i + 1} and ${i + 2} swapped`, why: 'Two events raced each other.', order });
  }
  for (let i = 0; i < n - 1; i++) {
    list.push({ name: `Late retry of event ${i + 1}`, why: 'A failed delivery is retried after newer events landed.', order: [...all, i] });
  }
  for (let i = 0; i < n - 1; i++) {
    list.push({ name: `Event ${i + 1} never arrives`, why: 'A delivery is dropped for good.', order: all.filter((j) => j !== i) });
  }
  const seen = new Set();
  return list.filter((s) => {
    const key = s.order.join(',');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// The app should end up matching the newest event it was sent, whatever order
// the deliveries arrived in.
export function expected(spec, order) {
  return spec.expected_after[Math.max(...order)];
}

export function verdict(expectedRow, actualRow) {
  // null means the row should not exist (for example, deleted on cancellation).
  if (expectedRow === null) {
    return actualRow ? { ok: false, diffs: [{ column: '(row)', expected: 'no row', actual: actualRow }] } : { ok: true, diffs: [] };
  }
  if (expectedRow === undefined) return { ok: false, diffs: [{ column: '(spec)', expected: 'an expected_after entry', actual: 'missing' }] };
  if (!actualRow) return { ok: false, diffs: [{ column: '(row)', expected: expectedRow, actual: 'missing' }] };
  const diffs = [];
  for (const [column, want] of Object.entries(expectedRow)) {
    const got = actualRow[column] ?? null;
    if (String(want ?? null) !== String(got)) diffs.push({ column, expected: want ?? null, actual: got });
  }
  return { ok: diffs.length === 0, diffs };
}
