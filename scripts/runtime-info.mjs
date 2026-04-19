import process from "node:process";

console.log(`  node: ${process.execPath}`);
console.log(`  version: ${process.version}`);
console.log(`  abi: ${process.versions.modules}`);
