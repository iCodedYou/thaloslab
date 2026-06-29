// Minimal append-only file logger → `~/.thaloslab/logs/daemon.log`. The CLI surfaces this
// path when a boot times out, so failures are diagnosable (DECISIONS #13, working-style).
import fs from 'node:fs';
import { daemonLogPath, ensureAppDir } from './config/paths';

type Level = 'info' | 'warn' | 'error';

let stream: fs.WriteStream | null = null;

export function initLogger(): void {
  ensureAppDir();
  stream = fs.createWriteStream(daemonLogPath(), { flags: 'a' });
}

export function log(level: Level, msg: string): void {
  const line = `${new Date().toISOString()} [${level}] ${msg}\n`;
  stream?.write(line);
  (level === 'error' ? process.stderr : process.stdout).write(line);
}
