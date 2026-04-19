import process from "node:process";

await import("better-sqlite3");
console.log(`  pinned-runtime: ok (${process.version}, abi=${process.versions.modules})`);
