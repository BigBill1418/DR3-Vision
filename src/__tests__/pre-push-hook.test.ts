import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import path from 'node:path'

// The pre-push gate (ADR-0033 / P0-4) must NOT run tsc/vitest for pushes that
// carry no code. Git feeds pre-push one line per ref on stdin:
//   "<local ref> <local sha> <remote ref> <remote sha>"
// where a deletion has the all-zero local sha. Regression for the 2026-07-02
// incident: a remote-branch sweep (`git push --delete ...`) was blocked by type
// errors from a stale generated Prisma client.

const HOOK = path.resolve(__dirname, '../../.husky/pre-push')
const REPO_ROOT = path.resolve(__dirname, '../..')
const ZERO = '0'.repeat(40)
const FAKE = 'a'.repeat(40)

function runHook(stdin: string, env: Record<string, string> = {}) {
  return spawnSync('sh', [HOOK], {
    cwd: REPO_ROOT,
    input: stdin,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout: 15_000, // far below a tsc run — proves we skipped, not passed, the gate
  })
}

describe('.husky/pre-push deletion-only skip', () => {
  it('skips the gate when every pushed ref is a deletion', () => {
    const res = runHook(
      `(delete) ${ZERO} refs/heads/stale-branch ${FAKE}\n` +
        `(delete) ${ZERO} refs/heads/other-stale ${FAKE}\n`,
    )
    expect(res.status).toBe(0)
    expect(res.stdout).toContain('deletion-only push')
  })

  it('exits 0 on an empty ref list (nothing to push)', () => {
    const res = runHook('')
    expect(res.status).toBe(0)
  })

  it('still reaches the gate for a mixed push (deletion + real ref)', () => {
    // SKIP_PREPUSH=1 halts the hook right AFTER the deletion check, so the
    // observed message proves the mixed push fell through to the gate path
    // instead of being wrongly classified as deletion-only.
    const res = runHook(
      `(delete) ${ZERO} refs/heads/stale-branch ${FAKE}\n` +
        `refs/heads/main ${FAKE} refs/heads/main ${FAKE}\n`,
      { SKIP_PREPUSH: '1' },
    )
    expect(res.status).toBe(0)
    expect(res.stdout).not.toContain('deletion-only push')
    expect(res.stdout).toContain('SKIP_PREPUSH=1')
  })

  it('still reaches the gate for a normal code push', () => {
    const res = runHook(`refs/heads/main ${FAKE} refs/heads/main ${FAKE}\n`, {
      SKIP_PREPUSH: '1',
    })
    expect(res.status).toBe(0)
    expect(res.stdout).not.toContain('deletion-only push')
    expect(res.stdout).toContain('SKIP_PREPUSH=1')
  })
})
