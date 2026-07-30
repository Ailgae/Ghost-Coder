(function exposeMarkdownTables(root, factory) {
  const helpers = factory();
  if (typeof module === 'object' && module.exports) module.exports = helpers;
  else root.GhostMarkdownTables = helpers;
}(typeof globalThis === 'object' ? globalThis : this, function createMarkdownTables() {
  function splitTableRow(line) {
    let source = String(line || '').trim();
    if (source.startsWith('|')) source = source.slice(1);
    if (source.endsWith('|') && !source.endsWith('\\|')) source = source.slice(0, -1);

    const cells = [];
    let cell = '';
    let escaped = false;
    for (const character of source) {
      if (escaped) {
        cell += character;
        escaped = false;
      } else if (character === '\\') {
        cell += character;
        escaped = true;
      } else if (character === '|') {
        cells.push(cell.trim().replace(/\\\|/g, '|'));
        cell = '';
      } else {
        cell += character;
      }
    }
    cells.push(cell.trim().replace(/\\\|/g, '|'));
    return cells;
  }

  function tableAlignments(line) {
    if (!String(line || '').includes('|')) return null;
    const cells = splitTableRow(line);
    if (!cells.length || cells.some(cell => !/^:?-{3,}:?$/.test(cell))) return null;
    return cells.map(cell => {
      if (cell.startsWith(':') && cell.endsWith(':')) return 'center';
      if (cell.endsWith(':')) return 'right';
      if (cell.startsWith(':')) return 'left';
      return null;
    });
  }

  return { splitTableRow, tableAlignments };
}));
