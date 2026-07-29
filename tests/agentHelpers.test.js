const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const helpers = require('../agent/agentHelpers');

describe('agent change tracking', () => {
  let cwd;

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ghost-coder-agent-'));
  });

  afterEach(() => {
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('distinguishes informational questions from edit requests', () => {
    assert.equal(helpers.requiresFileChange('How does this work?'), false);
    assert.equal(helpers.requiresFileChange('Please explain this module'), false);
    assert.equal(helpers.requiresFileChange('Add tests for this module'), true);
    assert.equal(helpers.requiresFileChange('I need better error handling'), true);
  });

  it('snapshots regular files while ignoring generated directories', () => {
    fs.writeFileSync(path.join(cwd, 'app.js'), 'one');
    fs.mkdirSync(path.join(cwd, 'node_modules'));
    fs.writeFileSync(path.join(cwd, 'node_modules', 'ignored.js'), 'x');
    const snapshot = helpers.projectSnapshot(cwd);
    assert.deepEqual([...snapshot.keys()], ['app.js']);
    assert.equal(snapshot.get('app.js').contents.toString(), 'one');
  });

  it('detects created, changed, and deleted paths', () => {
    fs.writeFileSync(path.join(cwd, 'changed.txt'), 'before');
    fs.writeFileSync(path.join(cwd, 'deleted.txt'), 'gone');
    const before = helpers.projectSnapshot(cwd);
    fs.writeFileSync(path.join(cwd, 'changed.txt'), 'after');
    fs.unlinkSync(path.join(cwd, 'deleted.txt'));
    fs.writeFileSync(path.join(cwd, 'created.txt'), 'new');
    const after = helpers.projectSnapshot(cwd);
    assert.deepEqual(helpers.changedPaths(before, after).sort(), [
      'changed.txt', 'created.txt', 'deleted.txt'
    ]);
  });

  it('counts inserted and removed lines with a shortest diff', () => {
    assert.deepEqual(helpers.changedLineCounts(
      Buffer.from('a\nb\nc\n'), Buffer.from('a\nx\nc\nd\n')
    ), { added: 2, removed: 1 });
    assert.deepEqual(helpers.changedLineCounts(undefined, Buffer.from('one\ntwo')), {
      added: 2, removed: 0
    });
  });

  it('builds summaries with file contents and line statistics', () => {
    fs.writeFileSync(path.join(cwd, 'file.txt'), 'a\nb\n');
    const before = helpers.projectSnapshot(cwd);
    fs.writeFileSync(path.join(cwd, 'file.txt'), 'a\nc\n');
    const summary = helpers.fileChangeSummary(before, helpers.projectSnapshot(cwd));
    assert.deepEqual(summary, [{
      path: 'file.txt', added: 1, removed: 1,
      before: 'a\nb\n', after: 'a\nc\n'
    }]);
  });

  it('appends machine-readable diff data that round trips', () => {
    const changes = [{ path: 'a.txt', added: 1, removed: 0, before: null, after: 'x' }];
    const result = helpers.appendChangeSummary('Finished.  ', changes);
    assert.match(result, /Files changed:\n- a\.txt: \+1 \/ -0/);
    const encoded = result.split('\n\nDiff data:\n')[1];
    assert.deepEqual(JSON.parse(Buffer.from(encoded, 'base64').toString()), [
      { path: 'a.txt', before: null, after: 'x' }
    ]);
    assert.equal(helpers.appendChangeSummary('unchanged', []), 'unchanged');
    assert.equal(helpers.stripChangeSummary(result), 'Finished.');
  });

  it('compacts tool traffic and normalizes stored agent/error roles', () => {
    const messages = helpers.compactPreviousContext([
      { role: 'system', content: 'old' },
      { role: 'user', content: 'keep' },
      { role: 'assistant', content: '', tool_calls: [{ function: { name: 'read_file' } }] },
      { role: 'tool', content: '{}' },
      { role: 'user', content: 'Continue implementing the original request: "x"' },
      { role: 'agent', content: helpers.appendChangeSummary('done', [
        { path: 'a.txt', added: 1, removed: 0, before: null, after: 'x' }
      ]) },
      { role: 'error', content: 'failed' }
    ]);
    assert.deepEqual(messages, [
      { role: 'system', content: 'old' },
      { role: 'user', content: 'keep' },
      { role: 'assistant', content: 'done' },
      { role: 'assistant', content: 'failed' }
    ]);
  });

  it('generates prompts with the working directory and Git policy', () => {
    assert.match(helpers.systemPrompt('/work/project', false), /\/work\/project/);
    assert.match(helpers.systemPrompt('/work/project', false), /Never run Git commands/);
    assert.match(helpers.systemPrompt('/work/project', true), /may run Git commands/);
  });
});
