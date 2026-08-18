import { describe, expect, it } from "vitest";
import {
  imageTokenEquivalent,
  parseImageDimensions,
} from "../src/utils/image-dimensions.js";

describe("image token equivalents", () => {
  it("reads PNG, GIF, and JPEG dimensions", () => {
    const png = Buffer.alloc(24);
    png.writeUInt32BE(0x89504e47, 0);
    png.writeUInt32BE(0x0d0a1a0a, 4);
    png.writeUInt32BE(640, 16);
    png.writeUInt32BE(480, 20);
    expect(parseImageDimensions(png)).toMatchObject({ width: 640, height: 480, format: "png" });

    const gif = Buffer.alloc(10);
    gif.write("GIF89a", 0, "ascii");
    gif.writeUInt16LE(320, 6);
    gif.writeUInt16LE(200, 8);
    expect(parseImageDimensions(gif)).toMatchObject({ width: 320, height: 200, format: "gif" });

    const jpeg = Buffer.from([
      0xff, 0xd8,
      0xff, 0xc0, 0x00, 0x0b, 0x08, 0x01, 0xe0, 0x02, 0x80, 0x01, 0x01,
      0xff, 0xd9,
    ]);
    expect(parseImageDimensions(jpeg)).toMatchObject({ width: 640, height: 480, format: "jpeg" });
  });

  it("uses the GPT-5.6 Sol original image grid equivalent", () => {
    expect(imageTokenEquivalent({ width: 640, height: 480, format: "png" })).toBe(15 * 20);
    expect(parseImageDimensions(Buffer.from("not-an-image"))).toBeNull();
  });
});
