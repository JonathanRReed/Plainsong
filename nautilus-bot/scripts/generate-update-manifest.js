#!/usr/bin/env node

/**
 * Generate Tauri update manifest JSON
 * 
 * Usage: node generate-update-manifest.js --version 1.2.3 --platform darwin --arch aarch64 --channel stable
 * 
 * This script generates the JSON manifest that Tauri's updater uses to check for updates.
 * The manifest includes:
 * - Version number
 * - Release notes
 * - Publication date
 * - Platform-specific download URLs and signatures
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Parse command line arguments
function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    version: null,
    platform: 'darwin', // darwin or windows
    arch: 'aarch64',    // aarch64 or x86_64
    channel: 'stable',  // stable or beta
    artifactsDir: './src-tauri/target/release/bundle',
    outputDir: './manifests',
    notes: null,
    githubReleaseUrl: null,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case '--version':
      case '-v':
        options.version = args[++i];
        break;
      case '--platform':
      case '-p':
        options.platform = args[++i];
        break;
      case '--arch':
      case '-a':
        options.arch = args[++i];
        break;
      case '--channel':
      case '-c':
        options.channel = args[++i];
        break;
      case '--artifacts':
        options.artifactsDir = args[++i];
        break;
      case '--output':
      case '-o':
        options.outputDir = args[++i];
        break;
      case '--notes':
      case '-n':
        options.notes = args[++i];
        break;
      case '--github-url':
      case '-g':
        options.githubReleaseUrl = args[++i];
        break;
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
        break;
    }
  }

  if (!options.version) {
    console.error('Error: --version is required');
    printHelp();
    process.exit(1);
  }

  return options;
}

function printHelp() {
  console.log(`
Generate Tauri update manifest

Usage: node generate-update-manifest.js [options]

Options:
  --version, -v        Version number (required)
  --platform, -p       Target platform: darwin|windows (default: darwin)
  --arch, -a           Target arch: aarch64|x86_64 (default: aarch64)
  --channel, -c        Release channel: stable|beta (default: stable)
  --artifacts          Path to bundled artifacts (default: ./src-tauri/target/release/bundle)
  --output, -o         Output directory for manifest (default: ./manifests)
  --notes, -n          Release notes (default: from CHANGELOG.md or generic message)
  --github-url, -g     Base URL for GitHub release artifacts
  --help, -h           Show this help message

Examples:
  node generate-update-manifest.js --version 1.2.3
  node generate-update-manifest.js --version 1.2.3 --channel beta --platform darwin --arch x86_64
  node generate-update-manifest.js --version 1.2.3 --github-url https://github.com/user/repo/releases/download/v1.2.3
`);
}

// Read signature file for an artifact
function readSignature(artifactPath) {
  const sigPath = `${artifactPath}.sig`;
  if (fs.existsSync(sigPath)) {
    return fs.readFileSync(sigPath, 'utf8').trim();
  }
  return null;
}

// Find artifact file based on platform and arch
function findArtifact(options) {
  const { platform, arch, artifactsDir, version } = options;
  
  // Map platform/arch to Tauri bundle names
  const patterns = {
    'darwin-aarch64': [`Nautilus_${version}_aarch64.dmg`, `Nautilus_${version}_aarch64.app.tar.gz`],
    'darwin-x86_64': [`Nautilus_${version}_x64.dmg`, `Nautilus_${version}_x64.app.tar.gz`],
    'windows-x86_64': [`Nautilus_${version}_x64_en-US.msi`, `Nautilus_${version}_x64-setup.exe`],
  };

  const key = `${platform}-${arch}`;
  const candidates = patterns[key] || [];
  
  for (const pattern of candidates) {
    const fullPath = path.join(artifactsDir, platform === 'darwin' ? 'dmg' : 'msi', pattern);
    if (fs.existsSync(fullPath)) {
      return {
        path: fullPath,
        filename: pattern,
      };
    }
    // Also check in bundle root
    const rootPath = path.join(artifactsDir, pattern);
    if (fs.existsSync(rootPath)) {
      return {
        path: rootPath,
        filename: pattern,
      };
    }
  }

  return null;
}

// Generate release notes
function generateNotes(options) {
  if (options.notes) {
    return options.notes;
  }

  // Try to read from CHANGELOG.md
  const changelogPath = path.join(process.cwd(), 'CHANGELOG.md');
  if (fs.existsSync(changelogPath)) {
    const changelog = fs.readFileSync(changelogPath, 'utf8');
    // Extract version section
    const versionMatch = changelog.match(new RegExp(`## \\[?${options.version}\\]?[\\s\\S]*?(?=## \\[?\\d|$)`));
    if (versionMatch) {
      return versionMatch[0].trim();
    }
  }

  return `Nautilus ${options.version} - ${options.channel === 'beta' ? 'Beta' : 'Stable'} Release

This update includes bug fixes and improvements.

Full changelog available at: https://nautilusbot.jonathanrreed.com/changelog`;
}

// Build download URL
function buildDownloadUrl(options, filename) {
  if (options.githubReleaseUrl) {
    return `${options.githubReleaseUrl}/${filename}`;
  }
  // Default to placeholder - will be filled by CI/CD
  return `https://github.com/nautilusbot/nautilus/releases/download/v${options.version}/${filename}`;
}

// Generate the manifest
function generateManifest(options) {
  const artifact = findArtifact(options);
  
  if (!artifact) {
    console.error(`Error: Could not find artifact for ${options.platform}-${options.arch} in ${options.artifactsDir}`);
    console.error('Expected one of:');
    console.error(`  - Nautilus_${options.version}_${options.arch === 'aarch64' ? 'aarch64' : 'x64'}.dmg`);
    console.error(`  - Nautilus_${options.version}_${options.arch === 'aarch64' ? 'aarch64' : 'x64'}.app.tar.gz`);
    process.exit(1);
  }

  const signature = readSignature(artifact.path);
  if (!signature) {
    console.warn(`Warning: No signature file found at ${artifact.path}.sig`);
    console.warn('The update will not be installable without a valid signature.');
  }

  const notes = generateNotes(options);
  const pubDate = new Date().toISOString();

  // Build platform identifier
  let platformId;
  if (options.platform === 'darwin') {
    platformId = options.arch === 'aarch64' ? 'darwin-aarch64' : 'darwin-x86_64';
  } else if (options.platform === 'windows') {
    platformId = 'windows-x86_64';
  } else {
    platformId = `${options.platform}-${options.arch}`;
  }

  const manifest = {
    version: options.version,
    notes: notes,
    pub_date: pubDate,
    platforms: {
      [platformId]: {
        signature: signature,
        url: buildDownloadUrl(options, artifact.filename),
      },
    },
  };

  // Add channel metadata if beta
  if (options.channel === 'beta') {
    manifest.channel = 'beta';
  }

  return manifest;
}

// Main execution
function main() {
  const options = parseArgs();
  
  console.log(`Generating update manifest...`);
  console.log(`  Version: ${options.version}`);
  console.log(`  Platform: ${options.platform}`);
  console.log(`  Arch: ${options.arch}`);
  console.log(`  Channel: ${options.channel}`);
  console.log(`  Artifacts: ${options.artifactsDir}`);

  const manifest = generateManifest(options);

  // Ensure output directory exists
  if (!fs.existsSync(options.outputDir)) {
    fs.mkdirSync(options.outputDir, { recursive: true });
  }

  // Write manifest file
  const channelSuffix = options.channel === 'beta' ? '-beta' : '';
  const manifestFilename = `manifest-${options.platform}-${options.arch}${channelSuffix}.json`;
  const manifestPath = path.join(options.outputDir, manifestFilename);

  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  console.log(`\n✓ Manifest generated: ${manifestPath}`);
  console.log(`  Platform ID: ${Object.keys(manifest.platforms)[0]}`);
  console.log(`  URL: ${manifest.platforms[Object.keys(manifest.platforms)[0]].url}`);
  console.log(`  Signature: ${manifest.platforms[Object.keys(manifest.platforms)[0]].signature ? 'Present' : 'Missing'}`);
  
  // Also write to channel-specific directory structure
  const channelDir = path.join(options.outputDir, options.channel);
  if (!fs.existsSync(channelDir)) {
    fs.mkdirSync(channelDir, { recursive: true });
  }
  
  const latestPath = path.join(channelDir, `latest-${options.platform}-${options.arch}.json`);
  fs.writeFileSync(latestPath, JSON.stringify(manifest, null, 2));
  console.log(`  Also written to: ${latestPath}`);
}

main();
