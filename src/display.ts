/** Start a private virtual display only when the caller has not supplied one. */
import { spawn, type ChildProcess } from 'node:child_process';
import { BrowserError } from './errors.ts';
let owned: ChildProcess | null = null, booting: Promise<string> | null = null, display = '';
export const displaySetting = (env: NodeJS.ProcessEnv = process.env): string => env.XIANYU_DISPLAY?.trim() || env.DISPLAY?.trim() || '';
export const stopDisplay = () => { owned?.kill('SIGTERM'); owned = null; display = ''; booting = null; };
export const acquireDisplay = async (): Promise<string> => {
  const supplied = displaySetting();
  if (supplied) return supplied;
  if (display && owned?.exitCode === null) return display;
  if (booting) return booting;
  booting = new Promise<string>((resolve, reject) => {
    // -displayfd lets Xvfb allocate a free display atomically, avoiding :99 collisions.
    const child = spawn(process.env.XIANYU_XVFB_PATH || 'Xvfb', ['-displayfd', '3', '-screen', '0', '1440x900x24', '-nolisten', 'tcp', '-ac'], { stdio: ['ignore', 'ignore', 'pipe', 'pipe'] });
    owned = child;
    let stderr = '', output = '', settled = false;
    const fail = (cause: string) => {
      if (settled) return;
      settled = true; clearTimeout(timer); child.kill('SIGTERM'); owned = null;
      reject(new BrowserError(`No display is available and Xvfb could not start: ${cause}. Install xvfb, set XIANYU_XVFB_PATH to its binary, or set XIANYU_DISPLAY to an existing display. ${stderr.slice(-300)}`));
    };
    const timer = setTimeout(() => fail('startup timed out'), 5000);
    child.stderr?.on('data', chunk => { stderr = (stderr + chunk).slice(-1000); });
    child.on('error', e => fail(e.message));
    child.on('exit', code => { if (!settled) fail(`exit ${code}`); if (owned === child) { owned = null; display = ''; } });
    child.stdio[3]?.on('data', (chunk: Buffer) => {
      output += chunk.toString();
      if (!/^\d+\n/.test(output)) return;
      settled = true; clearTimeout(timer); display = `:${output.trim()}`; resolve(display);
    });
  }).finally(() => { booting = null; });
  return booting;
};
