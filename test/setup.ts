/**
 * Vitest global setup — isolate all test databases in a temp directory.
 *
 * Any test that calls getDb(projectId) without mocking will create its
 * database under this temp directory instead of ~/.clawforce/. The temp
 * directory is cleaned up after all tests complete.
 *
 * Tests that mock db.js fully will skip this (the mock replaces the module).
 * That's fine — mocked tests don't create real directories anyway.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll } from "vitest";

let tmpDir: string;
let originalDir: string;

beforeAll(async () => {
  try {
    const db = await import("../src/db.js");
    if (typeof db.setProjectsDir === "function" && typeof db.getProjectsDir === "function") {
      originalDir = db.getProjectsDir();
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawforce-test-"));
      db.setProjectsDir(tmpDir);
    }
  } catch {
    // Module fully mocked or unavailable — skip redirection.
    // Tests that mock db.js don't create real directories.
  }
});

afterAll(async () => {
  try {
    const db = await import("../src/db.js");
    if (typeof db.resetDbForTest === "function") {
      db.resetDbForTest();
    }
    if (typeof db.setProjectsDir === "function" && originalDir) {
      db.setProjectsDir(originalDir);
    }
  } catch {
    // ignore
  }
  if (tmpDir) {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  }
});
