import { randomBytes } from 'node:crypto';
import { decodeBlock, encodeBlockHC, encodeBound } from 'lz4-browser';
import * as fzstd from 'fzstd';

/** Fixed-length marker embedded in a Script/ModuleScript source inside the place file. */
export const DEFAULT_RBXL_UPLOAD_STAMP_MARKER = '__ARMORY_STAMP__';
const BUILD_STAMP_ASSIGNMENT_PREFIX = 'local BUILD_STAMP = "';

const FILE_HEADER_SIZE = 32;
const CHUNK_HEADER_SIZE = 16;
const RBXL_MAGIC = Buffer.from('<roblox!');
const RBXLX_PREFIX = Buffer.from('<roblox');
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

const STAMP_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

export function buildUploadStamp(length = DEFAULT_RBXL_UPLOAD_STAMP_MARKER.length) {
  const bytes = randomBytes(length);
  let stamp = '';
  for (let i = 0; i < length; i += 1) {
    stamp += STAMP_ALPHABET[bytes[i] % STAMP_ALPHABET.length];
  }
  return stamp;
}

function countMarkers(buf, markerBuf) {
  let index = 0;
  let count = 0;
  while ((index = buf.indexOf(markerBuf, index)) !== -1) {
    count += 1;
    index += markerBuf.length;
  }
  return count;
}

function replaceMarkers(buf, markerBuf, stampBuf) {
  let index = 0;
  let count = 0;
  while ((index = buf.indexOf(markerBuf, index)) !== -1) {
    stampBuf.copy(buf, index);
    count += 1;
    index += markerBuf.length;
  }
  return count;
}

/** Replace the quoted BUILD_STAMP value (marker or any prior upload stamp). */
function replaceBuildStampAssignments(buf, stampLen, stampBuf) {
  const prefixBuf = Buffer.from(BUILD_STAMP_ASSIGNMENT_PREFIX, 'utf8');
  let index = 0;
  let count = 0;
  while ((index = buf.indexOf(prefixBuf, index)) !== -1) {
    const valueStart = index + prefixBuf.length;
    const valueEnd = valueStart + stampLen;
    if (valueEnd < buf.length && buf[valueEnd] === 0x22) {
      stampBuf.copy(buf, valueStart);
      count += 1;
    }
    index += 1;
  }
  return count;
}

function stampBuffer(buf, markerBuf, stampBuf) {
  const markerHits = replaceMarkers(buf, markerBuf, stampBuf);
  const assignmentHits = replaceBuildStampAssignments(buf, markerBuf.length, stampBuf);
  return markerHits + assignmentHits;
}

function isRbxlx(buf) {
  return buf.length >= 7 && buf.subarray(0, 7).equals(RBXLX_PREFIX) && !buf.subarray(0, 8).equals(RBXL_MAGIC);
}

function isRbxl(buf) {
  return buf.length >= FILE_HEADER_SIZE && buf.subarray(0, 8).equals(RBXL_MAGIC);
}

function decompressChunk(compressedLen, uncompressedLen, chunkData) {
  if (compressedLen === 0) {
    return {
      data: Buffer.from(chunkData.subarray(0, uncompressedLen)),
      compression: 'none',
    };
  }

  if (chunkData.length >= 4 && chunkData.subarray(0, 4).equals(ZSTD_MAGIC)) {
    return {
      data: Buffer.from(fzstd.decompress(new Uint8Array(chunkData))),
      compression: 'zstd',
    };
  }

  const out = Buffer.alloc(uncompressedLen);
  const decoded = decodeBlock(chunkData, out, 0, chunkData.length);
  if (decoded <= 0) {
    throw new Error(`LZ4 decode failed at offset ${decoded}`);
  }
  return {
    data: out.subarray(0, decoded),
    compression: 'lz4',
  };
}

function compressChunk(uncompressed, compression) {
  if (compression === 'none') {
    return { compressedLen: 0, data: Buffer.from(uncompressed) };
  }

  if (compression === 'zstd') {
    const data = Buffer.from(fzstd.compress(new Uint8Array(uncompressed)));
    return { compressedLen: data.length, data };
  }

  const bound = encodeBound(uncompressed.length);
  const out = Buffer.alloc(bound);
  try {
    const encoded = encodeBlockHC(uncompressed, out, 0, out.length);
    if (encoded > 0) {
      return { compressedLen: encoded, data: out.subarray(0, encoded) };
    }
  } catch {
    // Fall through to store uncompressed.
  }
  return { compressedLen: 0, data: Buffer.from(uncompressed) };
}

function patchRbxlBinaryChunks(buf, markerBuf, stampBuf) {
  const parts = [buf.subarray(0, FILE_HEADER_SIZE)];
  let offset = FILE_HEADER_SIZE;
  let totalReplacements = 0;

  while (offset + CHUNK_HEADER_SIZE <= buf.length) {
    const header = buf.subarray(offset, offset + CHUNK_HEADER_SIZE);
    const chunkName = header.subarray(0, 4).toString('ascii').replace(/\0/g, '');
    const compressedLen = header.readUInt32LE(4);
    const uncompressedLen = header.readUInt32LE(8);
    const payloadLen = compressedLen !== 0 ? compressedLen : uncompressedLen;
    const payloadStart = offset + CHUNK_HEADER_SIZE;

    if (payloadStart + payloadLen > buf.length) {
      parts.push(buf.subarray(offset));
      break;
    }

    const payload = buf.subarray(payloadStart, payloadStart + payloadLen);
    let outHeader = header;
    let outPayload = payload;

    if (chunkName !== 'END') {
      try {
        const { data: decompressed, compression } = decompressChunk(compressedLen, uncompressedLen, payload);
        const working = Buffer.from(decompressed);
        const replaced = stampBuffer(working, markerBuf, stampBuf);

        if (replaced > 0) {
          const compressed = compressChunk(working, compression);
          outHeader = Buffer.alloc(CHUNK_HEADER_SIZE);
          header.subarray(0, 4).copy(outHeader, 0);
          outHeader.writeUInt32LE(compressed.compressedLen, 4);
          outHeader.writeUInt32LE(working.length, 8);
          outPayload = compressed.data;
          totalReplacements += replaced;
        }
      } catch {
        // Leave chunk unchanged if decompression fails.
      }
    }

    parts.push(outHeader, outPayload);
    offset = payloadStart + payloadLen;

    if (chunkName === 'END') {
      if (offset < buf.length) {
        parts.push(buf.subarray(offset));
      }
      break;
    }
  }

  if (offset >= buf.length && parts.length === 1) {
    return { buffer: buf, count: 0 };
  }

  return {
    buffer: Buffer.concat(parts),
    count: totalReplacements,
  };
}

function warnMarkerMissing(marker) {
  console.log(
    `[WARN] RBXL upload stamp marker "${marker}" not found in place file.\n` +
      '       The .luau source in your repo does not update game.rbxl automatically.\n' +
      '       Ensure ServerScriptService/GameVersion.server.luau exists in Studio, then re-export\n' +
      '       or re-upload game.rbxl (dashboard Assets tab). Marker must be exactly:\n' +
      `       local BUILD_STAMP = "${marker}"`
  );
}

export function patchRbxlUploadStamp(data, options = {}) {
  const marker = String(options.marker || DEFAULT_RBXL_UPLOAD_STAMP_MARKER);
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const markerBuf = Buffer.from(marker, 'utf8');
  const stamp = buildUploadStamp(marker.length);
  const stampBuf = Buffer.from(stamp, 'utf8');

  if (stampBuf.length !== markerBuf.length) {
    throw new Error('RBXL upload stamp length must match marker length');
  }

  if (isRbxlx(buf)) {
    const rawCount = countMarkers(buf, markerBuf);
    if (rawCount === 0) {
      warnMarkerMissing(marker);
      return buf;
    }
    const out = Buffer.from(buf);
    stampBuffer(out, markerBuf, stampBuf);
    console.log(`[INFO] RBXL upload stamp → ${stamp} (${rawCount} replacement${rawCount === 1 ? '' : 's'})`);
    return out;
  }

  if (!isRbxl(buf)) {
    warnMarkerMissing(marker);
    return buf;
  }

  const rawCount = countMarkers(buf, markerBuf);
  if (rawCount > 0) {
    const out = Buffer.from(buf);
    stampBuffer(out, markerBuf, stampBuf);
    console.log(`[INFO] RBXL upload stamp → ${stamp} (${rawCount} replacement${rawCount === 1 ? '' : 's'})`);
    return out;
  }

  const { buffer: patched, count } = patchRbxlBinaryChunks(buf, markerBuf, stampBuf);
  if (count === 0) {
    warnMarkerMissing(marker);
    return buf;
  }

  console.log(`[INFO] RBXL upload stamp → ${stamp} (${count} replacement${count === 1 ? '' : 's'}, compressed chunks)`);
  return patched;
}

export function shouldPatchRbxlUploadStamp(config) {
  const stamp = config?.experience?.uploadStamp;
  if (stamp === false) {
    return false;
  }
  if (stamp && typeof stamp === 'object' && stamp.enabled === false) {
    return false;
  }
  return true;
}
