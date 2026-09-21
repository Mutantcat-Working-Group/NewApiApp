#!/usr/bin/env node
/**
 * Thin pass-through wrapper around the Tauri CLI.
 *
 * The macOS DMG bundler shells out to `SetFile`, which resolves through the
 * active Xcode developer directory. On a machine where Xcode is selected but
 * its license has never been accepted, that single call fails and aborts the
 * whole DMG step even though Command Line Tools are installed and usable.
 * Pointing DEVELOPER_DIR at Command Line Tools keeps bundling alive; when the
 * toolchain is healthy this script does nothing but forward the arguments.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const isWindows = process.platform === 'win32';
const args = process.argv.slice(2);

function repairDeveloperDir() {
  if (process.platform !== 'darwin') return;

  const cltDir = '/Library/Developer/CommandLineTools';
  if (!existsSync(path.join(cltDir, 'usr', 'bin', 'SetFile'))) return;

  // A zero exit means xcrun resolved SetFile, so the toolchain is fine.
  const probe = spawnSync('xcrun', ['--find', 'SetFile'], { stdio: 'ignore' });
  if (probe.status === 0) return;

  const previous = process.env.DEVELOPER_DIR;
  process.env.DEVELOPER_DIR = cltDir;
  console.info(
    '[tauri] Xcode license not accepted; using Command Line Tools for bundling. ' +
      `Run "sudo xcodebuild -license accept" to go back to ${previous || 'Xcode'}.`,
  );
}

repairDeveloperDir();

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const localBin = path.join(root, 'node_modules', '.bin', isWindows ? 'tauri.cmd' : 'tauri');
const bin = existsSync(localBin) ? localBin : 'tauri';

const child = spawn(bin, args, {
  cwd: process.cwd(),
  env: process.env,
  stdio: 'inherit',
  shell: isWindows,
});

child.on('error', (error) => {
  console.error(`[tauri] failed to launch ${bin}: ${error.message}`);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  if (signal) process.exit(1);
  process.exit(code ?? 1);
});
