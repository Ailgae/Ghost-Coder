const assert = require('assert');
const { diffRows } = require('../renderer/diffRows');

describe('diffRows', () => {
  it('keeps unchanged lines between separate edits unhighlighted', () => {
    const before = ['one', 'old first', 'three', 'four', 'old second', 'six'].join('\n');
    const after = ['one', 'new first', 'three', 'four', 'new second', 'six'].join('\n');

    assert.deepEqual(diffRows(before, after), [
      { before: 'one', after: 'one', type: 'same' },
      { before: 'old first', after: 'new first', type: 'changed' },
      { before: 'three', after: 'three', type: 'same' },
      { before: 'four', after: 'four', type: 'same' },
      { before: 'old second', after: 'new second', type: 'changed' },
      { before: 'six', after: 'six', type: 'same' }
    ]);
  });

  it('aligns inserted and removed lines without highlighting nearby context', () => {
    assert.deepEqual(diffRows('one\ntwo\nthree\n', 'zero\none\nthree\nfour\n'), [
      { before: undefined, after: 'zero', type: 'changed' },
      { before: 'one', after: 'one', type: 'same' },
      { before: 'two', after: undefined, type: 'changed' },
      { before: 'three', after: 'three', type: 'same' },
      { before: undefined, after: 'four', type: 'changed' }
    ]);
  });
});
