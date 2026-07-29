(function exposeDiffRows(root, factory) {
  const diffRows = factory();
  if (typeof module === 'object' && module.exports) module.exports = { diffRows };
  else root.GhostDiff = { diffRows };
}(typeof globalThis === 'object' ? globalThis : this, function createDiffRows() {
  function linesIn(text) {
    if (text === null || text === '') return [];
    const lines = text.split('\n');
    if (text.endsWith('\n')) lines.pop();
    return lines;
  }

  function operationsFor(before, after) {
    const oldLines = linesIn(before);
    const newLines = linesIn(after);
    const furthestX = new Map([[1, 0]]);
    const trace = [];

    for (let edits = 0; edits <= oldLines.length + newLines.length; edits++) {
      trace.push(new Map(furthestX));
      for (let diagonal = -edits; diagonal <= edits; diagonal += 2) {
        let x;
        if (
          diagonal === -edits ||
          (diagonal !== edits &&
            (furthestX.get(diagonal - 1) ?? -Infinity) < (furthestX.get(diagonal + 1) ?? -Infinity))
        ) {
          x = furthestX.get(diagonal + 1) ?? 0;
        } else {
          x = (furthestX.get(diagonal - 1) ?? 0) + 1;
        }

        let y = x - diagonal;
        while (x < oldLines.length && y < newLines.length && oldLines[x] === newLines[y]) {
          x++;
          y++;
        }
        furthestX.set(diagonal, x);

        if (x >= oldLines.length && y >= newLines.length) {
          const operations = [];
          for (let depth = edits; depth > 0; depth--) {
            const previous = trace[depth];
            const currentDiagonal = x - y;
            const previousDiagonal = (
              currentDiagonal === -depth ||
              (currentDiagonal !== depth &&
                (previous.get(currentDiagonal - 1) ?? -Infinity) <
                  (previous.get(currentDiagonal + 1) ?? -Infinity))
            ) ? currentDiagonal + 1 : currentDiagonal - 1;
            const previousX = previous.get(previousDiagonal) ?? 0;
            const previousY = previousX - previousDiagonal;

            while (x > previousX && y > previousY) {
              operations.push({ type: 'same', value: oldLines[--x] });
              y--;
            }
            if (x === previousX) operations.push({ type: 'added', value: newLines[--y] });
            else operations.push({ type: 'removed', value: oldLines[--x] });
          }
          while (x > 0 && y > 0) {
            operations.push({ type: 'same', value: oldLines[--x] });
            y--;
          }
          return operations.reverse();
        }
      }
    }
    return [];
  }

  function diffRows(before, after) {
    const rows = [];
    const operations = operationsFor(before, after);
    let index = 0;

    while (index < operations.length) {
      if (operations[index].type === 'same') {
        const value = operations[index++].value;
        rows.push({ before: value, after: value, type: 'same' });
        continue;
      }

      const removed = [];
      const added = [];
      while (index < operations.length && operations[index].type !== 'same') {
        const operation = operations[index++];
        (operation.type === 'removed' ? removed : added).push(operation.value);
      }
      const changedLength = Math.max(removed.length, added.length);
      for (let offset = 0; offset < changedLength; offset++) {
        rows.push({ before: removed[offset], after: added[offset], type: 'changed' });
      }
    }
    return rows;
  }

  return diffRows;
}));
