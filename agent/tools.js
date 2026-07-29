const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

// Tool definitions in Ollama/OpenAI function-calling format.
const baseToolDefinitions = [
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
          content: { type: 'string', description: 'Content to write to the file.' }
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
          path: { type: 'string', description: 'Directory path, relative to the project working directory or absolute. Defaults to current directory.' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'run_shell',
      description: 'Run a shell command in the project working directory.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command to execute.' },
          timeout_seconds: { type: 'number', description: 'Maximum time in seconds to wait for command completion. Defaults to 120.' }
        },
        required: ['command']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'delete_file',
      description: 'Delete a file from the filesystem.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path to delete, relative to the project working directory or absolute.' }
        },
        required: ['path']
      }
    }
  }
];

function getToolDefinitions(allowGit = false) {
  return baseToolDefinitions.map(tool => {
    if (tool.function.name !== 'run_shell') return tool;
    return {
      ...tool,
      function: {
        ...tool.function,
        description: allowGit
          ? 'Run a shell command in the project working directory, including Git commands.'
          : 'Run a non-Git shell command in the project working directory. Git commands and access to Git metadata are blocked.'
      }
    };
  });
}

function resolvePath(cwd, p) {
  if (!p) return cwd;
  return path.isAbsolute(p) ? p : path.join(cwd, p);
}

function touchesGitMetadata(target) {
  return path.resolve(target).split(path.sep).some(part => part.toLowerCase() === '.git');
}

function attemptsGitAccess(command) {
  const gitExecutable = /(^|[\s;&|()])(?:[^\s;&|()]*[\\/])?git(?:\.exe)?(?=$|[\s;&|()])/i;
  const gitMetadata = /(^|[\\/\s'"])\.git(?:[\\/\s'"]|$)/i;
  return gitExecutable.test(command) || gitMetadata.test(command);
}

async function executeTool(name, rawArgs, cwd, { allowGit = false } = {}) {
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
        if (!allowGit && touchesGitMetadata(target)) {
          return { ok: false, error: 'Git metadata is protected and cannot be modified.' };
        }
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
        if (!allowGit && attemptsGitAccess(args.command || '')) {
          return { ok: false, error: 'Git commands and Git metadata access are disabled.' };
        }
        const timeoutMs = (args.timeout_seconds || 120) * 1000;
        const result = await new Promise((resolve) => {
          const env = allowGit
            ? process.env
            : {
                ...process.env,
                GIT_DIR: path.join(cwd, '.ghost-coder-git-disabled'),
                GIT_WORK_TREE: path.join(cwd, '.ghost-coder-git-disabled')
              };
          exec(args.command, { cwd, env, timeout: timeoutMs, maxBuffer: 1024 * 1024 * 10, shell: '/bin/bash' },
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

      case 'delete_file': {
        const target = resolvePath(cwd, args.path);
        if (!allowGit && touchesGitMetadata(target)) {
          return { ok: false, error: 'Git metadata is protected and cannot be deleted.' };
        }
        try {
          fs.unlinkSync(target);
          return { ok: true, path: target, deleted: true };
        } catch (err) {
          if (err.code === 'ENOENT') {
            return { ok: false, error: `File not found: ${target}` };
          }
          throw err;
        }
      }

      default:
        return { ok: false, error: `Unknown tool: ${name}` };
    }
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = { getToolDefinitions, executeTool };
