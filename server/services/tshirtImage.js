import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import { serverConfig, ensureDataDir } from '../config.js';
import { atomicWriteFile } from '../../src/shared/atomicStore.js';

const TSHIRT_WIDTH = 585;
const TSHIRT_HEIGHT = 559;

async function buildDefaultTemplate() {
  const svg = `
    <svg width="${TSHIRT_WIDTH}" height="${TSHIRT_HEIGHT}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="#1a1a2e"/>
          <stop offset="100%" stop-color="#16213e"/>
        </linearGradient>
      </defs>
      <rect width="100%" height="100%" fill="url(#bg)"/>
      <rect x="24" y="24" width="${TSHIRT_WIDTH - 48}" height="${TSHIRT_HEIGHT - 48}" rx="18" fill="#0f3460" stroke="#e94560" stroke-width="4"/>
      <text x="50%" y="42%" text-anchor="middle" fill="#ffffff" font-family="Arial, sans-serif" font-size="36" font-weight="700">MONSTER BRICK BRONZE</text>
      <text x="50%" y="58%" text-anchor="middle" fill="#e94560" font-family="Arial, sans-serif" font-size="28">PREMIUM ITEM</text>
    </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

async function loadTemplateBuffer() {
  const templatePath = serverConfig.tshirtTemplatePath;
  if (fs.existsSync(templatePath)) {
    return fs.readFileSync(templatePath);
  }

  ensureDataDir();
  const generated = path.join(serverConfig.dataDir, 'generated-template.png');
  if (fs.existsSync(generated)) {
    return fs.readFileSync(generated);
  }

  const buffer = await buildDefaultTemplate();
  atomicWriteFile(generated, buffer, { backup: false });
  return buffer;
}

function truncate(text, max) {
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, max - 1)}…`;
}

export async function renderTshirtImage({ displayName, priceRobux, productKey }) {
  const template = await loadTemplateBuffer();
  const title = truncate(String(displayName || productKey), 28);
  const price = `${Number(priceRobux || 0)} R$`;

  const overlaySvg = `
    <svg width="${TSHIRT_WIDTH}" height="${TSHIRT_HEIGHT}" xmlns="http://www.w3.org/2000/svg">
      <rect x="40" y="360" width="505" height="150" rx="16" fill="rgba(0,0,0,0.55)"/>
      <text x="292" y="410" text-anchor="middle" fill="#ffffff" font-family="Arial, sans-serif" font-size="34" font-weight="700">${escapeXml(title)}</text>
      <text x="292" y="460" text-anchor="middle" fill="#ffd166" font-family="Arial, sans-serif" font-size="28">${escapeXml(price)}</text>
      <text x="292" y="495" text-anchor="middle" fill="#adb5bd" font-family="Arial, sans-serif" font-size="18">${escapeXml(String(productKey))}</text>
    </svg>`;

  return sharp(template)
    .composite([{ input: Buffer.from(overlaySvg), top: 0, left: 0 }])
    .png()
    .toBuffer();
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
