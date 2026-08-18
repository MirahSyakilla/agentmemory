import { open, readdir } from "node:fs/promises";
import { join } from "node:path";
import { IMAGES_DIR, isManagedImagePath } from "./image-store.js";

export interface ImageDimensions {
  width: number;
  height: number;
  format: "png" | "jpeg" | "gif" | "webp";
}

export interface ImageInventory {
  imageCount: number;
  imageBytes: number;
  imageTokens: number;
  unknownImageCount: number;
}

const IMAGE_HEADER_BYTES = 262_144;

function validDimensions(width: number, height: number): boolean {
  return Number.isInteger(width) && width > 0 && Number.isInteger(height) && height > 0;
}

function parsePng(buffer: Buffer): ImageDimensions | null {
  if (
    buffer.length < 24 ||
    buffer.readUInt32BE(0) !== 0x89504e47 ||
    buffer.readUInt32BE(4) !== 0x0d0a1a0a
  ) {
    return null;
  }
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  return validDimensions(width, height) ? { width, height, format: "png" } : null;
}

function parseGif(buffer: Buffer): ImageDimensions | null {
  if (
    buffer.length < 10 ||
    (buffer.toString("ascii", 0, 6) !== "GIF87a" &&
      buffer.toString("ascii", 0, 6) !== "GIF89a")
  ) {
    return null;
  }
  const width = buffer.readUInt16LE(6);
  const height = buffer.readUInt16LE(8);
  return validDimensions(width, height) ? { width, height, format: "gif" } : null;
}

function parseJpeg(buffer: Buffer): ImageDimensions | null {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 3 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset++;
      continue;
    }
    while (offset < buffer.length && buffer[offset] === 0xff) offset++;
    if (offset >= buffer.length) break;
    const marker = buffer[offset++];
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
      continue;
    }
    if (offset + 1 >= buffer.length) break;
    const segmentLength = buffer.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > buffer.length) break;
    const isStartOfFrame =
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf);
    if (isStartOfFrame && segmentLength >= 7) {
      const height = buffer.readUInt16BE(offset + 3);
      const width = buffer.readUInt16BE(offset + 5);
      return validDimensions(width, height)
        ? { width, height, format: "jpeg" }
        : null;
    }
    offset += segmentLength;
  }
  return null;
}

function parseWebp(buffer: Buffer): ImageDimensions | null {
  if (
    buffer.length < 16 ||
    buffer.toString("ascii", 0, 4) !== "RIFF" ||
    buffer.toString("ascii", 8, 12) !== "WEBP"
  ) {
    return null;
  }
  const chunk = buffer.toString("ascii", 12, 16);
  if (chunk === "VP8X" && buffer.length >= 30) {
    const width = 1 + buffer.readUIntLE(24, 3);
    const height = 1 + buffer.readUIntLE(27, 3);
    return validDimensions(width, height) ? { width, height, format: "webp" } : null;
  }
  if (chunk === "VP8 " && buffer.length >= 30) {
    const frame = 20;
    if (
      buffer[frame + 3] === 0x9d &&
      buffer[frame + 4] === 0x01 &&
      buffer[frame + 5] === 0x2a
    ) {
      const width = buffer.readUInt16LE(frame + 6) & 0x3fff;
      const height = buffer.readUInt16LE(frame + 8) & 0x3fff;
      return validDimensions(width, height) ? { width, height, format: "webp" } : null;
    }
  }
  if (chunk === "VP8L" && buffer.length >= 25 && buffer[20] === 0x2f) {
    const bits =
      buffer[21] |
      (buffer[22] << 8) |
      (buffer[23] << 16) |
      (buffer[24] << 24);
    const width = 1 + (bits & 0x3fff);
    const height = 1 + ((bits >>> 14) & 0x3fff);
    return validDimensions(width, height) ? { width, height, format: "webp" } : null;
  }
  return null;
}

export function parseImageDimensions(buffer: Buffer): ImageDimensions | null {
  return parsePng(buffer) ?? parseGif(buffer) ?? parseJpeg(buffer) ?? parseWebp(buffer);
}

export function imageTokenEquivalent(dimensions: ImageDimensions): number {
  return Math.ceil(dimensions.width / 32) * Math.ceil(dimensions.height / 32);
}

async function inspectImageFile(filePath: string): Promise<{
  bytes: number;
  dimensions: ImageDimensions | null;
}> {
  try {
    const file = await open(filePath, "r");
    try {
      const info = await file.stat();
      const size = Math.min(info.size, IMAGE_HEADER_BYTES);
      const header = Buffer.alloc(size);
      if (size > 0) await file.read(header, 0, size, 0);
      return { bytes: info.size, dimensions: parseImageDimensions(header) };
    } finally {
      await file.close();
    }
  } catch {
    return { bytes: 0, dimensions: null };
  }
}

export async function inspectImageFiles(filePaths: string[]): Promise<ImageInventory> {
  const uniquePaths = [...new Set(filePaths)].filter(isManagedImagePath);
  const inventory: ImageInventory = {
    imageCount: 0,
    imageBytes: 0,
    imageTokens: 0,
    unknownImageCount: 0,
  };
  const batchSize = 16;
  for (let offset = 0; offset < uniquePaths.length; offset += batchSize) {
    const inspected = await Promise.all(
      uniquePaths.slice(offset, offset + batchSize).map(inspectImageFile),
    );
    for (const image of inspected) {
      if (image.bytes <= 0) continue;
      inventory.imageCount++;
      inventory.imageBytes += image.bytes;
      if (image.dimensions) inventory.imageTokens += imageTokenEquivalent(image.dimensions);
      else inventory.unknownImageCount++;
    }
  }
  return inventory;
}

export async function inspectManagedImages(
  imageRefs?: string[],
): Promise<ImageInventory> {
  if (imageRefs) return inspectImageFiles(imageRefs);
  try {
    const entries = await readdir(IMAGES_DIR, { withFileTypes: true });
    const paths = entries
      .filter((entry) => entry.isFile())
      .map((entry) => join(IMAGES_DIR, entry.name));
    return inspectImageFiles(paths);
  } catch {
    return { imageCount: 0, imageBytes: 0, imageTokens: 0, unknownImageCount: 0 };
  }
}
