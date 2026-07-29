const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { getToolDefinitions, executeTool } = require('../agent/tools');

describe('agent tools', () => {
  let cwd;

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ghost-coder-tools-'));
  });

  afterEach(() => {
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('publishes all tool definitions and adjusts the Git description', () => {
    const restricted = getToolDefinitions();
    const enabled = getToolDefinitions(true);
    assert.deepEqual(restricted.map(tool => tool.function.name), [
      'read_file', 'write_file', 'list_dir', 'run_shell', 'delete_file'
    ]);
    assert.match(restricted.find(tool => tool.function.name === 'run_shell').function.description, /Git commands.*blocked/);
    assert.match(enabled.find(tool => tool.function.name === 'run_shell').function.description, /including Git commands/);
  });

  it('writes, reads, and overwrites nested files while reporting changes', async () => {
    const created = await executeTool('write_file', {
      path: 'nested/file.txt', content: 'hello'
    }, cwd);
    assert.equal(created.ok, true);
    assert.equal(created.changed, true);
    assert.equal(created.bytesWritten, 5);

    const unchanged = await executeTool('write_file', JSON.stringify({
      path: 'nested/file.txt', content: 'hello'
    }), cwd);
    assert.equal(unchanged.changed, false);

    const read = await executeTool('read_file', { path: 'nested/file.txt' }, cwd);
    assert.equal(read.content, 'hello');
    assert.equal(read.path, path.join(cwd, 'nested/file.txt'));
  });

  it('uses empty content when write_file content is omitted', async () => {
    const result = await executeTool('write_file', { path: 'empty.txt' }, cwd);
    assert.equal(result.ok, true);
    assert.equal(fs.readFileSync(path.join(cwd, 'empty.txt'), 'utf8'), '');
  });

  it('lists files and directories', async () => {
    fs.mkdirSync(path.join(cwd, 'folder'));
    fs.writeFileSync(path.join(cwd, 'file.txt'), 'x');
    const result = await executeTool('list_dir', {}, cwd);
    assert.equal(result.ok, true);
    assert.deepEqual(result.entries.sort((a, b) => a.name.localeCompare(b.name)), [
      { name: 'file.txt', type: 'file' },
      { name: 'folder', type: 'dir' }
    ]);
  });

  it('deletes files and reports missing files without throwing', async () => {
    fs.writeFileSync(path.join(cwd, 'remove.txt'), 'x');
    assert.equal((await executeTool('delete_file', { path: 'remove.txt' }, cwd)).deleted, true);
    const missing = await executeTool('delete_file', { path: 'remove.txt' }, cwd);
    assert.equal(missing.ok, false);
    assert.match(missing.error, /File not found/);
  });

  it('returns filesystem errors as tool results', async () => {
    const result = await executeTool('read_file', { path: 'missing.txt' }, cwd);
    assert.equal(result.ok, false);
    assert.match(result.error, /ENOENT/);
  });

  it('runs shell commands in the project directory', async () => {
    const result = await executeTool('run_shell', {
      command: "pwd; printf 'ok'"
    }, cwd);
    assert.equal(result.ok, true);
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, `${fs.realpathSync(cwd)}\nok`);
  });

  it('captures failed shell command output and exit code', async () => {
    const result = await executeTool('run_shell', {
      command: "printf 'bad' >&2; exit 7"
    }, cwd);
    assert.equal(result.ok, false);
    assert.equal(result.exitCode, 7);
    assert.equal(result.stderr, 'bad');
    assert.match(result.error, /Command failed/);
  });

  for (const command of ['git status', '/usr/bin/git status', 'cat .git/config', 'echo x > ".git/config"']) {
    it(`blocks Git access: ${command}`, async () => {
      const result = await executeTool('run_shell', { command }, cwd);
      assert.equal(result.ok, false);
      assert.match(result.error, /Git commands and Git metadata access are disabled/);
    });
  }

  it('allows commands containing harmless words that include git', async () => {
    const result = await executeTool('run_shell', { command: "printf 'digital'" }, cwd);
    assert.equal(result.ok, true);
    assert.equal(result.stdout, 'digital');
  });

  it('protects Git metadata from write and delete tools', async () => {
    fs.mkdirSync(path.join(cwd, '.git'));
    fs.writeFileSync(path.join(cwd, '.git', 'config'), 'safe');
    const write = await executeTool('write_file', { path: '.git/config', content: 'changed' }, cwd);
    const remove = await executeTool('delete_file', { path: '.git/config' }, cwd);
    assert.equal(write.ok, false);
    assert.equal(remove.ok, false);
    assert.equal(fs.readFileSync(path.join(cwd, '.git', 'config'), 'utf8'), 'safe');
  });

  it('permits Git metadata changes when explicitly enabled', async () => {
    const result = await executeTool('write_file', {
      path: '.git/config', content: 'allowed'
    }, cwd, { allowGit: true });
    assert.equal(result.ok, true);
    assert.equal(fs.readFileSync(path.join(cwd, '.git', 'config'), 'utf8'), 'allowed');
  });

  it('rejects unknown tools and malformed JSON arguments', async () => {
    assert.deepEqual(await executeTool('unknown', {}, cwd), {
      ok: false, error: 'Unknown tool: unknown'
    });
    const malformed = await executeTool('read_file', '{bad json', cwd);
    assert.equal(malformed.ok, false);
    assert.match(malformed.error, /EISDIR/);
  });
});
