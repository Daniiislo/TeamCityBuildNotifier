import * as esbuild from 'esbuild';
import * as fs from 'fs';
import * as path from 'path';

const distDir = 'dist';

// Clean dist directory
if (fs.existsSync(distDir)) {
  fs.rmSync(distDir, { recursive: true });
}
fs.mkdirSync(distDir, { recursive: true });

// Bundle JavaScript files
await esbuild.build({
  entryPoints: [
    'src/background.js',
    'src/options.js',
    'src/popup.js'
  ],
  bundle: true,
  format: 'esm',
  target: 'chrome116',
  outdir: distDir,
  platform: 'browser'
});

// Copy static files
const filesToCopy = [
  'manifest.json',
  'src/options.html',
  'src/popup.html'
];

for (const file of filesToCopy) {
  const dest = path.join(distDir, path.basename(file));
  fs.copyFileSync(file, dest);
}

// Copy icons directory
const iconsDir = 'icons';
const iconsDistDir = path.join(distDir, 'icons');
if (fs.existsSync(iconsDir)) {
  fs.mkdirSync(iconsDistDir, { recursive: true });
  const iconFiles = fs.readdirSync(iconsDir);
  for (const file of iconFiles) {
    fs.copyFileSync(path.join(iconsDir, file), path.join(iconsDistDir, file));
  }
}

console.log('Build complete: dist/');
