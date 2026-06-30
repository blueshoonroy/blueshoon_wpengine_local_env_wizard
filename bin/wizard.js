#!/usr/bin/env node
// Entry point: start the local server and open the dashboard in a browser.
import { spawn } from 'node:child_process';
import { createServer } from '../src/server.js';

const PORT = Number(process.env.PORT) || 7878;
const { server } = createServer();

server.listen(PORT, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${PORT}`;
  console.log(`\n  WPEngine Local Env Wizard running at ${url}\n`);
  openBrowser(url);
});

function openBrowser(url) {
  const platform = process.platform;
  try {
    if (platform === 'win32') spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
    else if (platform === 'darwin') spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    else spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
  } catch {
    console.log(`  Open ${url} in your browser.`);
  }
}
