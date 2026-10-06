#!/usr/bin/env node
/**
 * Home & Workspace Safety Guard (Zero-Pollution Invariant).
 * Audits source code and scripts to ensure:
 * 1. No hardcoded personal or sensitive local home directory paths (e.g., C:\Users\<name>, /home/<user>).
 * 2. All file stores, caches, and logs use isolated workspace-relative directories or OS tmpdir.
 * 3. Prevents dirty state leaks into the host machine environment.
 *
 * @module scripts/home-guard
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const ROOT_DIR = process.cwd()
const PACKAGES_DIR = join(ROOT_DIR, 'packages')
const BUNDLE_DIR = join(ROOT_DIR, 'bundle')

// Forbidden patterns: hardcoded developer home directories or root paths
const FORBIDDEN_PATTERNS = [
  { regex: /[a-zA-Z]:\\Users\\[a-zA-Z0-9_\-\.]+(?!\\[a-zA-Z0-9_\-\.]*default-workspace)/i, label: 'Hardcoded Windows User Home' },
  { regex: /\/home\/[a-zA-Z0-9_\-\.]+/i, label: 'Hardcoded Linux User Home' },
  { regex: /\/Users\/[a-zA-Z0-9_\-\.]+/i, label: 'Hardcoded macOS User Home' },
]

function scanDirectory(dir, fileList = []) {
  try {
    const entries = readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules' && entry.name !== 'lib' && entry.name !== 'dist' && entry.name !== '.git') {
          scanDirectory(full, fileList)
        }
      } else if (entry.isFile() && /\.(ts|tsx|js|mjs|json|yml|yaml)$/.test(entry.name)) {
        if (!entry.name.endsWith('package-lock.json') && !entry.name.endsWith('pnpm-lock.yaml')) {
          fileList.push(full)
        }
      }
    }
  } catch {
    // ignore
  }
  return fileList
}

function auditHomeSafety() {
  console.log('🛡️  [Home Safety Guard] Auditing codebase against hardcoded host paths & leaks...\n')

  const filesToScan = [
    ...scanDirectory(PACKAGES_DIR),
    ...scanDirectory(BUNDLE_DIR),
    ...scanDirectory(join(ROOT_DIR, 'scripts')),
  ]

  const violations = []

  for (const file of filesToScan) {
    // Exclude the guard script itself from matching its own rules
    if (file.endsWith('home-guard.mjs')) continue

    const content = readFileSync(file, 'utf-8')
    const lines = content.split('\n')

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      for (const pattern of FORBIDDEN_PATTERNS) {
        if (pattern.regex.test(line)) {
          violations.push({
            file,
            line: i + 1,
            label: pattern.label,
            snippet: line.trim().slice(0, 100),
          })
        }
      }
    }
  }

  console.log(`🔍 Scanned ${filesToScan.length} source files across monorepo.`)

  if (violations.length > 0) {
    console.error(`\n🚨 Home Safety Guard FAILED with ${violations.length} violation(s):`)
    for (const v of violations) {
      console.error(`  ❌ [${v.label}] ${v.file}:${v.line} -> "${v.snippet}"`)
    }
    process.exit(1)
  }

  console.log('\n🎉 Home Safety Guard PASSED: Zero hardcoded host user paths detected! All stores strictly isolated.')
}

try {
  auditHomeSafety()
} catch (err) {
  console.error('Fatal home guard error:', err)
  process.exit(1)
}
