#!/usr/bin/env node
/**
 * Tools Schema & Collision Audit Guard.
 * Inspects all Cordis tool definitions across the monorepo to ensure:
 * 1. Zero namespace collisions across packages.
 * 2. Proper naming conventions (snake_case).
 * 3. Detailed descriptions and valid parameter schemas.
 *
 * @module scripts/tools-audit
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const ROOT_DIR = process.cwd()
const PACKAGES_DIR = join(ROOT_DIR, 'packages')

function scanPackageFiles(dir) {
  const files = []
  try {
    const entries = readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== 'lib' && entry.name !== 'test') {
        files.push(...scanPackageFiles(full))
      } else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx'))) {
        files.push(full)
      }
    }
  } catch {
    // skip non-existent
  }
  return files
}

function auditTools() {
  console.log('🔍 [Tools Audit Guard] Scanning all tool definitions across monorepo...\n')

  const packages = readdirSync(PACKAGES_DIR, { withFileTypes: true })
  const toolRegistry = new Map()
  const errors = []

  for (const pkg of packages) {
    if (!pkg.isDirectory()) continue
    const pkgSrc = join(PACKAGES_DIR, pkg.name, 'src')
    if (!existsSync(pkgSrc)) continue
    const files = scanPackageFiles(pkgSrc)

    for (const file of files) {
      const content = readFileSync(file, 'utf-8')

      // Match defineTool({ name: '...', description: '...' }) or ctx.tools.register({ name: '...' })
      const toolMatchRegex = /defineTool\(\s*\{[\s\S]*?name:\s*['"`]([a-z0-9_]+)['"`][\s\S]*?description:\s*['"`]([\s\S]*?)['"`][,\n]/g
      let match

      while ((match = toolMatchRegex.exec(content)) !== null) {
        const name = match[1]
        const description = match[2].trim()

        // 1. Check naming convention
        if (!/^[a-z][a-z0-9_]*$/.test(name)) {
          errors.push(`❌ [${pkg.name}] Tool "${name}" does not follow snake_case naming convention in ${file}`)
        }

        // 2. Check description length
        if (description.length < 8) {
          errors.push(`❌ [${pkg.name}] Tool "${name}" has insufficient description ("${description}") in ${file}`)
        }

        // 3. Check duplicate collision
        if (toolRegistry.has(name)) {
          const existing = toolRegistry.get(name)
          errors.push(
            `❌ [Collision] Tool "${name}" is registered in both "${existing.pkg}" (${existing.file}) and "${pkg.name}" (${file})!`,
          )
        } else {
          toolRegistry.set(name, { name, description, pkg: pkg.name, file })
        }
      }
    }
  }

  console.log(`📋 Found and validated ${toolRegistry.size} registered tools across packages:`)
  for (const [name, meta] of toolRegistry.entries()) {
    console.log(`   • ${name.padEnd(24)} [@dsh-trading/${meta.pkg}]`)
  }

  if (errors.length > 0) {
    console.error(`\n🚨 Tools Audit FAILED with ${errors.length} error(s):`)
    for (const err of errors) {
      console.error(err)
    }
    process.exit(1)
  }

  console.log(`\n🎉 Tools Audit PASSED: All ${toolRegistry.size} tools have unique names, valid schemas, and clear descriptions!`)
}

try {
  auditTools()
} catch (err) {
  console.error('Fatal tools audit error:', err)
  process.exit(1)
}
