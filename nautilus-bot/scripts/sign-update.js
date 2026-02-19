#!/usr/bin/env node

/**
 * Sign Tauri update artifacts with Ed25519
 * 
 * Usage: node sign-update.js --file path/to/artifact --key path/to/private.key
 * 
 * This script creates .sig signature files for Tauri update artifacts.
 * The private key should be kept secret and stored securely (e.g., GitHub secrets).
 * 
 * To generate a new keypair:
 *   node sign-update.js --generate-keypair --output ./keys
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Parse command line arguments
function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    file: null,
    key: null,
    generateKeypair: false,
    outputDir: './keys',
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case '--file':
      case '-f':
        options.file = args[++i];
        break;
      case '--key':
      case '-k':
        options.key = args[++i];
        break;
      case '--generate-keypair':
      case '-g':
        options.generateKeypair = true;
        break;
      case '--output':
      case '-o':
        options.outputDir = args[++i];
        break;
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
        break;
    }
  }

  return options;
}

function printHelp() {
  console.log(`
Sign Tauri update artifacts with Ed25519

Usage:
  # Sign an artifact
  node sign-update.js --file path/to/artifact.dmg --key path/to/private.key

  # Generate a new keypair
  node sign-update.js --generate-keypair --output ./keys

Options:
  --file, -f          Path to artifact file to sign
  --key, -k           Path to private key file
  --generate-keypair  Generate a new Ed25519 keypair
  --output, -o        Output directory for keys (default: ./keys)
  --help, -h          Show this help message

Environment Variables:
  TAURI_SIGNING_PRIVATE_KEY    Base64-encoded private key (alternative to --key)
  TAURI_SIGNING_PUBLIC_KEY     Base64-encoded public key (for verification)

Examples:
  # Sign with key file
  node sign-update.js -f ./Nautilus_1.2.3_aarch64.dmg -k ./keys/private.key

  # Sign with environment variable
  export TAURI_SIGNING_PRIVATE_KEY=$(cat ./keys/private.key | base64)
  node sign-update.js -f ./Nautilus_1.2.3_aarch64.dmg

  # Generate keypair
  node sign-update.js --generate-keypair
`);
}

// Generate a new Ed25519 keypair
function generateKeypair(outputDir) {
  console.log('Generating new Ed25519 keypair...');
  
  // Generate keypair using Node.js crypto
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519', {
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });

  // Ensure output directory exists
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // Write keys to files
  const privateKeyPath = path.join(outputDir, 'private.key');
  const publicKeyPath = path.join(outputDir, 'public.key');

  fs.writeFileSync(privateKeyPath, privateKey);
  fs.writeFileSync(publicKeyPath, publicKey);

  // Also create base64-encoded versions for environment variables
  const privateKeyBase64 = Buffer.from(privateKey).toString('base64');
  const publicKeyBase64 = Buffer.from(publicKey).toString('base64');

  fs.writeFileSync(`${privateKeyPath}.b64`, privateKeyBase64);
  fs.writeFileSync(`${publicKeyPath}.b64`, publicKeyBase64);

  console.log('\n✓ Keypair generated successfully!');
  console.log(`  Private key: ${privateKeyPath}`);
  console.log(`  Public key:  ${publicKeyPath}`);
  console.log(`\nPublic key for tauri.conf.json (base64):`);
  console.log(publicKeyBase64);
  console.log(`\n⚠️  IMPORTANT: Keep the private key secret!`);
  console.log('   Store it securely (e.g., GitHub Secrets) and never commit it.');
}

// Get private key from file or environment
function getPrivateKey(keyPath) {
  // First try environment variable
  const envKey = process.env.TAURI_SIGNING_PRIVATE_KEY;
  if (envKey) {
    console.log('Using private key from TAURI_SIGNING_PRIVATE_KEY environment variable');
    const keyData = Buffer.from(envKey, 'base64').toString('utf8');
    return crypto.createPrivateKey(keyData);
  }

  // Then try file
  if (keyPath && fs.existsSync(keyPath)) {
    console.log(`Using private key from file: ${keyPath}`);
    const keyData = fs.readFileSync(keyPath, 'utf8');
    return crypto.createPrivateKey(keyData);
  }

  throw new Error('No private key provided. Use --key or set TAURI_SIGNING_PRIVATE_KEY environment variable.');
}

// Sign a file
function signFile(filePath, privateKey) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  console.log(`Signing: ${filePath}`);

  // Read file
  const data = fs.readFileSync(filePath);

  // Sign the data
  const signature = crypto.sign(null, data, privateKey);

  // Write signature to .sig file
  const sigPath = `${filePath}.sig`;
  fs.writeFileSync(sigPath, signature.toString('base64'));

  console.log(`✓ Signature created: ${sigPath}`);
  console.log(`  Algorithm: Ed25519`);
  console.log(`  Signature length: ${signature.length} bytes`);
  console.log(`  File size: ${data.length} bytes`);

  // Verify the signature
  const publicKey = crypto.createPublicKey(privateKey);
  const isValid = crypto.verify(null, data, publicKey, signature);
  console.log(`  Verification: ${isValid ? '✓ Valid' : '✗ Invalid'}`);

  return sigPath;
}

// Main execution
function main() {
  const options = parseArgs();

  if (options.generateKeypair) {
    generateKeypair(options.outputDir);
    return;
  }

  if (!options.file) {
    console.error('Error: --file is required (or use --generate-keypair)');
    printHelp();
    process.exit(1);
  }

  try {
    const privateKey = getPrivateKey(options.key);
    signFile(options.file, privateKey);
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
}

main();
