// Child-process helper that streams output line-by-line.
import { spawn } from 'node:child_process';

/**
 * Run a command, streaming each stdout/stderr line to onLine.
 * Uses a shell so Windows PATHEXT resolves `ddev`/`git`/`ssh` (.exe).
 * Returns { code } and never rejects on non-zero exit (caller checks code).
 */
export function run(command, { cwd, env, onLine } = {}) {
  return new Promise((resolve) => {
    const emit = (s) => {
      if (onLine) for (const line of s.split(/\r?\n/)) onLine(line);
    };
    const child = spawn(command, {
      cwd,
      env: { ...process.env, ...env },
      shell: true,
      windowsHide: true,
    });
    let outBuf = '';
    let errBuf = '';
    const flush = (buf, push) => {
      const parts = buf.split(/\r?\n/);
      const rest = parts.pop();
      for (const p of parts) push(p);
      return rest;
    };
    child.stdout.on('data', (d) => {
      outBuf += d.toString();
      outBuf = flush(outBuf, (l) => onLine && onLine(l));
    });
    child.stderr.on('data', (d) => {
      errBuf += d.toString();
      errBuf = flush(errBuf, (l) => onLine && onLine(l));
    });
    child.on('error', (e) => {
      emit(`process error: ${e.message}`);
      resolve({ code: -1 });
    });
    child.on('close', (code) => {
      if (outBuf) onLine && onLine(outBuf);
      if (errBuf) onLine && onLine(errBuf);
      resolve({ code: code ?? -1 });
    });
  });
}

/** Quote a path for safe use inside a shell command string. */
export function q(p) {
  return `"${String(p).replace(/"/g, '\\"')}"`;
}

/** Run a command and capture its full stdout as a string. */
export function capture(command, { cwd, env } = {}) {
  return new Promise((resolve) => {
    let out = '';
    const child = spawn(command, { cwd, env: { ...process.env, ...env }, shell: true, windowsHide: true });
    child.stdout.on('data', (d) => (out += d.toString()));
    child.on('error', () => resolve({ code: -1, stdout: '' }));
    child.on('close', (code) => resolve({ code: code ?? -1, stdout: out }));
  });
}
