import fs from 'fs';
import path from 'path';
import sharp from 'sharp';

/** Roblox experience icons must be 512×512 PNG. */
export async function ensureExperienceIconFile(imagePath) {
  const resolved = path.resolve(imagePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Image not found: ${imagePath}`);
  }

  const image = sharp(resolved);
  const meta = await image.metadata();
  const width = meta.width || 0;
  const height = meta.height || 0;
  if (width !== 512 || height !== 512) {
    const tempPath = `${resolved}.tmp-${process.pid}.png`;
    await image.resize(512, 512, { fit: 'cover' }).png().toFile(tempPath);
    fs.renameSync(tempPath, resolved);
    return { path: resolved, resized: true, width: 512, height: 512 };
  }

  return { path: resolved, resized: false, width, height };
}

/**
 * Nudge one random pixel so PNG hash changes while staying visually identical.
 */
export async function freshenImageFile(imagePath) {
  const resolved = path.resolve(imagePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Image not found: ${imagePath}`);
  }

  const image = sharp(resolved);
  const meta = await image.metadata();
  const width = meta.width || 0;
  const height = meta.height || 0;
  if (width < 1 || height < 1) {
    throw new Error(`Invalid image dimensions: ${imagePath}`);
  }

  const { data, info } = await image.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const channels = info.channels;
  const x = Math.floor(Math.random() * width);
  const y = Math.floor(Math.random() * height);
  const idx = (y * width + x) * channels;

  const before = [];
  const after = [];
  for (let c = 0; c < Math.min(channels, 3); c += 1) {
    before.push(data[idx + c]);
  }

  for (let c = 0; c < Math.min(channels, 3); c += 1) {
    let v = data[idx + c];
    const delta = Math.random() < 0.5 ? -1 : 1;
    v = Math.max(0, Math.min(255, v + delta));
    if (v === data[idx + c]) {
      v = v >= 255 ? v - 1 : v + 1;
    }
    data[idx + c] = v;
    after.push(v);
  }

  const out = await sharp(data, {
    raw: { width, height, channels },
  })
    .png()
    .toBuffer();

  fs.writeFileSync(resolved, out);
  return { path: resolved, x, y, before, after };
}
