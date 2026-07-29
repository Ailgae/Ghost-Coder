const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

// Tool definitions in Ollama/OpenAI function-calling format.
const toolDefinitions = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read the full text contents of a file.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path, relative to the project working directory or absolute.' }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Create or overwrite a file with the given content. Creates parent directories if needed.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path, relative to the project working directory or absolute.' },
          content: { type: 'string', description: 'Full content to write to the file.' }
        },
        required: ['path', 'content']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'list_dir',
      description: 'List files and subdirectories inside a directory.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory path, relative to the project working directory or absolute. Defaults to the working directory.' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'run_shell',
      description: 'Run a shell command (bash) in the project working directory. Use this for git, npm/pip/etc installs, running tests, builds, and any other command-line action.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The shell command to execute.' },
          timeout_seconds: { type: 'number', description: 'Max seconds to allow the command to run before it is killed. Defaults to 120.' }
        },
        required: ['command']
      }
    }
  }
];

function resolvePath(cwd, p) {
  if (!p) return cwd;
  return path.isAbsolute(p) ? p : path.join(cwd, p);
}

async function executeTool(name, rawArgs, cwd) {
  let args = rawArgs;
  if (typeof rawArgs === 'string') {
    try { args = JSON.parse(rawArgs); } catch (e) { args = {}; }
  }
  args = args || {};

  try {
    switch (name) {
      case 'read_file': {
        const target = resolvePath(cwd, args.path);
        const content = fs.readFileSync(target, 'utf8');
        return { ok: true, path: target, content };
      }

      case 'write_file': {
        const target = resolvePath(cwd, args.path);
        const content = args.content ?? '';
        let previousContent = null;
        try { previousContent = fs.readFileSync(target, 'utf8'); } catch (err) {
          if (err.code !== 'ENOENT') throw err;
        }
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, content, 'utf8');
        return {
          ok: true,
          path: target,
          bytesWritten: content.length,
          changed: previousContent !== content
        };
      }

      case 'list_dir': {
        const target = resolvePath(cwd, args.path);
        const entries = fs.readdirSync(target, { withFileTypes: true }).map(e => ({
          name: e.name,
          type: e.isDirectory() ? 'dir' : 'file'
        }));
        return { ok: true, path: target, entries };
      }

      case 'run_shell': {
        const timeoutMs = (args.timeout_seconds || 120) * 1000;
        const result = await new Promise((resolve) => {
          exec(args.command, { cwd, timeout: timeoutMs, maxBuffer: 1024 * 1024 * 10, shell: '/bin/bash' },
            (error, stdout, stderr) => {
              resolve({
                ok: !error,
                exitCode: error ? (error.code ?? 1) : 0,
                stdout,
                stderr,
                error: error ? error.message : null
              });
            });
        });
        return result;
      }

      default:
        return { ok: false, error: `Unknown tool: ${name}` };
    }
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = { toolDefinitions, executeTool };
