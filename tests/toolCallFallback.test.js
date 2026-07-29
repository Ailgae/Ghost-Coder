const assert = require('node:assert/strict');
const { extractFallbackToolCalls } = require('../agent/toolCallFallback');

describe('extractFallbackToolCalls', () => {
  it('extracts a JSON tool call emitted as plain text', () => {
    const calls = extractFallbackToolCalls(
      'I will inspect the file.\n{"name":"read_file","arguments":{"path":"main.js"}}'
    );

    assert.deepEqual(calls, [{
      name: 'read_file',
      arguments: { path: 'main.js' }
    }]);
  });

  it('extracts an OpenAI-style JSON tool call', () => {
    const calls = extractFallbackToolCalls(
      '{"function":{"name":"run_shell","arguments":{"command":"npm test"}}}'
    );

    assert.deepEqual(calls, [{
      name: 'run_shell',
      arguments: { command: 'npm test' }
    }]);
  });

  it('extracts concise command-style tool calls', () => {
    const calls = extractFallbackToolCalls([
      'list_dir .',
      'read_file "renderer/renderer.js"',
      'run_shell "npm test"'
    ].join('\n'));

    assert.deepEqual(calls, [
      { name: 'list_dir', arguments: { path: '.' } },
      { name: 'read_file', arguments: { path: 'renderer/renderer.js' } },
      { name: 'run_shell', arguments: { command: 'npm test' } }
    ]);
  });

  it('ignores ordinary model prose', () => {
    assert.deepEqual(
      extractFallbackToolCalls('No tool call is needed for this answer.'),
      []
    );
  });

  it('extracts write and delete command-style calls', () => {
    assert.deepEqual(
      extractFallbackToolCalls('write_file "notes.txt" "line\\nnext"\ndelete_file old.txt'),
      [
        { name: 'write_file', arguments: { path: 'notes.txt', content: 'line\nnext' } },
        { name: 'delete_file', arguments: { path: 'old.txt' } }
      ]
    );
  });

  it('supports multiple JSON tool calls and string arguments', () => {
    assert.deepEqual(
      extractFallbackToolCalls(
        '{"name":"read_file","arguments":"{\\"path\\":\\"a\\"}"} ' +
        '{"function":{"name":"list_dir","arguments":{"path":"src"}}}'
      ),
      [
        { name: 'read_file', arguments: '{"path":"a"}' },
        { name: 'list_dir', arguments: { path: 'src' } }
      ]
    );
  });

  it('ignores malformed and incomplete JSON blocks', () => {
    assert.deepEqual(extractFallbackToolCalls('{"name":"read_file","arguments":'), []);
    assert.deepEqual(extractFallbackToolCalls('{"name":"read_file"}'), []);
    assert.deepEqual(extractFallbackToolCalls(null), []);
  });
});
