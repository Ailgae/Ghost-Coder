const assert = require('assert');
const { splitTableRow, tableAlignments } = require('../renderer/markdownTables');

describe('Markdown tables', () => {
  it('parses table rows with optional outer pipes and escaped pipes', () => {
    assert.deepEqual(splitTableRow('| Name | A \\| B |'), ['Name', 'A | B']);
    assert.deepEqual(splitTableRow('Name | Value'), ['Name', 'Value']);
  });

  it('recognizes separator rows and their alignment', () => {
    assert.deepEqual(
      tableAlignments('| :--- | :---: | ---: | --- |'),
      ['left', 'center', 'right', null]
    );
  });

  it('does not mistake a horizontal rule for a table separator', () => {
    assert.equal(tableAlignments('---'), null);
    assert.equal(tableAlignments('| not dashes | --- |'), null);
  });
});
