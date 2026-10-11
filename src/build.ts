/** Build metadata published by the server's `capabilities` tool. It adds commit and freshness
 * information to the version already included in the MCP handshake. */
import { buildInfo, deployVerdict } from './build-info.ts';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
// Identify the implementation loaded at process start, including uncommitted edits.
const implementationHash = createHash('sha256');
for (const name of readdirSync(import.meta.dirname).filter(n => /\.(?:js|ts)$/.test(n)).sort()) {
  implementationHash.update(name).update(readFileSync(join(import.meta.dirname, name)));
}
const runtimeFingerprint = implementationHash.digest('hex');

/** Build metadata and deployment status for the current server. */
export const buildBlock = (root?: string) => {
  const info = buildInfo(root);
  const { ok, reasons } = deployVerdict(info);
  return {
    implementation: 'typescript', runtime_fingerprint: runtimeFingerprint,
    version: info.version,
    commit: info.commit || '(unrecorded)',
    describe: info.describe || '(unrecorded)',
    branch: info.branch || '(unknown)',
    dirty: info.dirty,
    /** Metadata source: the build stamp or the git checkout fallback. */
    provenance: info.source,
    built_at: info.built_at || '(no dist/)',
    compared_against: info.base,
    base_commit: info.base_commit || '(unresolved)',
    ahead: info.ahead,
    behind: info.behind,
    /** True, false, or null when freshness could not be measured. */
    stale: info.stale,
    deployable: ok,
    // Empty when the build has no deployment warnings.
    reasons,
  };
};
