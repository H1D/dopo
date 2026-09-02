import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../scripts/stamp-sw.ts", import.meta.url));

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function tempSrc(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "dopo-stamp-"));
  dirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const p = join(dir, rel);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, content);
  }
  return dir;
}

function run(src: string, out: string, env: Record<string, string> = {}) {
  const res = Bun.spawnSync(["bun", SCRIPT, src, out], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: { ...process.env, DOPO_FREE_KEY: "", ...env },
  });
  return { code: res.exitCode, stdout: res.stdout.toString(), stderr: res.stderr.toString() };
}
const FREEKEY = 'const STAMPED_KEY = "__DOPO_FREE_KEY__";\nexport const FREE_KEY = STAMPED_KEY.startsWith("__") ? "" : STAMPED_KEY;\n';
const A_KEY = "sk-or-v1-" + "ab".repeat(32);

const SW = 'const VERSION = "__DOPO_VERSION__";\nself.addEventListener("install", () => {});\n';

describe("scripts/stamp-sw.ts", () => {
  test("stamps a content hash into sw.js and copies everything", () => {
    const src = tempSrc({
      "sw.js": SW,
      "index.html": "<!doctype html><title>dopo</title>",
      "lib/lm.js": "export const x = 1;\n",
    });
    const out = join(src, "..", `dopo-stamp-out-${Date.now()}`);
    dirs.push(out);

    const r = run(src, out);
    expect(r.code).toBe(0);

    const stamped = readFileSync(join(out, "sw.js"), "utf8");
    expect(stamped).not.toContain("__DOPO_VERSION__");
    const version = stamped.match(/const VERSION = "([0-9a-f]{12})";/)?.[1];
    expect(version).toBeDefined();
    expect(existsSync(join(out, "lib/lm.js"))).toBe(true);
    expect(readFileSync(join(out, "index.html"), "utf8")).toContain("dopo");

    // Deterministic: same source tree -> same version stamp.
    const out2 = join(src, "..", `dopo-stamp-out2-${Date.now()}`);
    dirs.push(out2);
    expect(run(src, out2).code).toBe(0);
    expect(readFileSync(join(out2, "sw.js"), "utf8")).toBe(stamped);
  });

  test("content change changes the version", () => {
    const files = { "sw.js": SW, "app.js": "let a = 1;\n" };
    const srcA = tempSrc(files);
    const srcB = tempSrc({ ...files, "app.js": "let a = 2;\n" });
    const outA = mkdtempSync(join(tmpdir(), "dopo-stamp-outA-"));
    const outB = mkdtempSync(join(tmpdir(), "dopo-stamp-outB-"));
    dirs.push(outA, outB);
    expect(run(srcA, outA).code).toBe(0);
    expect(run(srcB, outB).code).toBe(0);
    const v = (p: string) => readFileSync(join(p, "sw.js"), "utf8").match(/"([0-9a-f]{12})"/)?.[1];
    expect(v(outA)).not.toBe(v(outB));
  });

  test("stamps DOPO_FREE_KEY into lib/freekey.js; empty env -> empty key; key changes the version", () => {
    const src = tempSrc({ "sw.js": SW, "lib/freekey.js": FREEKEY });
    const outNone = mkdtempSync(join(tmpdir(), "dopo-stamp-none-"));
    const outKey = mkdtempSync(join(tmpdir(), "dopo-stamp-key-"));
    dirs.push(outNone, outKey);

    expect(run(src, outNone).code).toBe(0);
    const none = readFileSync(join(outNone, "lib/freekey.js"), "utf8");
    expect(none).not.toContain("__DOPO_FREE_KEY__");
    expect(none).toContain('const STAMPED_KEY = "";');

    expect(run(src, outKey, { DOPO_FREE_KEY: A_KEY }).code).toBe(0);
    const keyed = readFileSync(join(outKey, "lib/freekey.js"), "utf8");
    expect(keyed).toContain(`const STAMPED_KEY = "${A_KEY}";`);
    // the key is public in the served JS by design, but it must never be in the source tree
    expect(readFileSync(join(src, "lib/freekey.js"), "utf8")).not.toContain(A_KEY);

    const v = (p: string) => readFileSync(join(p, "sw.js"), "utf8").match(/"([0-9a-f]{12})"/)?.[1];
    expect(v(outNone)).not.toBe(v(outKey)); // a rotated key re-busts the SW cache
  });

  test("FAILS hard when DOPO_FREE_KEY is not an OpenRouter key", () => {
    const src = tempSrc({ "sw.js": SW, "lib/freekey.js": FREEKEY });
    const out = mkdtempSync(join(tmpdir(), "dopo-stamp-out-"));
    dirs.push(out);
    const r = run(src, out, { DOPO_FREE_KEY: "not-a-key" });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("DOPO_FREE_KEY");
  });

  test("FAILS hard when sw.js lacks the placeholder", () => {
    const src = tempSrc({ "sw.js": 'const VERSION = "1.0.0";\n' });
    const out = mkdtempSync(join(tmpdir(), "dopo-stamp-out-"));
    dirs.push(out);
    const r = run(src, out);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("__DOPO_VERSION__");
  });

  test("FAILS hard when sw.js is missing entirely", () => {
    const src = tempSrc({ "index.html": "<p>no sw</p>" });
    const out = mkdtempSync(join(tmpdir(), "dopo-stamp-out-"));
    dirs.push(out);
    const r = run(src, out);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("sw.js");
  });
});
