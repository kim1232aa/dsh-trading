#!/usr/bin/env node
/**
 * Architecture Layering and Dependency Boundary Guard.
 * Ensures strict directional dependencies and prevents architectural erosion across monorepo packages.
 *
 * Layers:
 * - L0: Core Data Contracts & Registry (@dsh-trading/market-data)
 * - L1: Providers & Domain Subsystems (@dsh-trading/provider-*, risk-guard, holdings, watchlist)
 * - L2: Research & Verification Engines (@dsh-trading/tool-market, verdict)
 * - L3: Client UI Components (@dsh-trading/client-frame, client-chart)
 * - L4: Bundle Assembly (@dsh-trading/bundle-trading)
 *
 * Invariant: Packages in layer Ln may only depend on packages in Lm where m <= n.
 * Any upward dependency (e.g. L0 depending on L1, or L1 depending on L3) fails with exit code 1.
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { resolve, join } from 'node:path'

const ROOT_DIR = process.cwd()

const LAYERS = {
  // L0: Core Contracts
  '@dsh-trading/market-data': 0,

  // L1: Providers & Subsystems
  '@dsh-trading/provider-binance': 1,
  '@dsh-trading/provider-cn': 1,
  '@dsh-trading/provider-csv': 1,
  '@dsh-trading/provider-futu': 1,
  '@dsh-trading/risk-guard': 1,
  '@dsh-trading/holdings': 1,
  '@dsh-trading/watchlist': 1,
  '@dsh-trading/knowledge': 1,

  // L2: Engines & Tools
  '@dsh-trading/tool-market': 2,
  '@dsh-trading/verdict': 2,

  // L3: UI Layers
  '@dsh-trading/client-frame': 3,
  '@dsh-trading/client-chart': 3,

  // L4: Top Bundle
  '@dsh-trading/bundle': 4,
  '@dsh-trading/bundle-trading': 4,
}

function findWorkspacePackages() {
  const pkgs = []

  // Check packages/
  const packagesDir = resolve(ROOT_DIR, 'packages')
  if (existsSync(packagesDir)) {
    for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        const pkgJsonPath = join(packagesDir, entry.name, 'package.json')
        if (existsSync(pkgJsonPath)) {
          const content = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'))
          pkgs.push({ name: content.name, dir: join('packages', entry.name), json: content })
        }
      }
    }
  }

  // Check bundle/
  const bundleDir = resolve(ROOT_DIR, 'bundle')
  if (existsSync(bundleDir)) {
    for (const entry of readdirSync(bundleDir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        const pkgJsonPath = join(bundleDir, entry.name, 'package.json')
        if (existsSync(pkgJsonPath)) {
          const content = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'))
          pkgs.push({ name: content.name, dir: join('bundle', entry.name), json: content })
        }
      }
    }
  }

  return pkgs
}

function checkBoundaries() {
  console.log('🔍 [Boundary Guard] Scanning monorepo architecture and dependency boundaries...\n')
  const pkgs = findWorkspacePackages()
  const violations = []
  let totalChecked = 0

  for (const pkg of pkgs) {
    const pkgName = pkg.name
    const currentLayer = LAYERS[pkgName]

    if (currentLayer === undefined) {
      console.warn(`⚠️ Warning: Package "${pkgName}" is not registered in architecture LAYERS map.`)
      continue
    }

    const allDeps = {
      ...(pkg.json.dependencies || {}),
      ...(pkg.json.peerDependencies || {}),
    }

    for (const [depName, version] of Object.entries(allDeps)) {
      if (depName.startsWith('@dsh-trading/')) {
        totalChecked++
        const depLayer = LAYERS[depName]

        if (depLayer === undefined) {
          violations.push(
            `❌ [Unregistered Dependency] Package "${pkgName}" (L${currentLayer}) depends on unknown internal package "${depName}".`
          )
        } else if (depLayer > currentLayer) {
          violations.push(
            `❌ [Layer Inversion Violation] Package "${pkgName}" (Layer ${currentLayer}) illegally depends upward on "${depName}" (Layer ${depLayer}). Upward dependencies violate architectural boundaries.`
          )
        } else {
          // Valid downward or same-layer dependency
        }
      }
    }
  }

  console.log(`✅ Checked ${totalChecked} internal dependency edges across ${pkgs.length} packages.`)

  if (violations.length > 0) {
    console.error('\n🚨 Architecture Boundary Check FAILED with the following violations:\n')
    for (const v of violations) {
      console.error(v)
    }
    process.exit(1)
  } else {
    console.log('🎉 Architecture Boundary Check PASSED: All dependencies strictly adhere to L0-L4 layer hierarchy!\n')
    process.exit(0)
  }
}

checkBoundaries()
