import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import { readBody } from "../src/viewer/server.js";

class FakeReq extends EventEmitter {
  destroyed = false;
  destroy(): void {
    this.destroyed = true;
  }
}

describe("viewer readBody", () => {
  it("decodes split UTF-8 chunks correctly (#930)", async () => {
    const req = new FakeReq();
    const body = readBody(req as never);
    const first = Buffer.from('{"msg":"caf');
    const second = Buffer.from('é"}');
    req.emit("data", first);
    req.emit("data", second);
    req.emit("end");
    await expect(body).resolves.toBe('{"msg":"café"}');
  });
});
