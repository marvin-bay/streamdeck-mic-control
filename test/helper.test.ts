import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ensureExecutable } from "../src/helper.js";

const log = { info: () => {}, warn: () => {}, error: () => {} };

describe("ensureExecutable", () => {
	it("restores the executable bit dropped by packaging", () => {
		const dir = mkdtempSync(path.join(tmpdir(), "mic-control-test-"));
		try {
			const file = path.join(dir, "helper");
			writeFileSync(file, "#!/bin/sh\n");
			chmodSync(file, 0o644);
			ensureExecutable(file, log);
			expect(statSync(file).mode & 0o111).toBe(0o111);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
