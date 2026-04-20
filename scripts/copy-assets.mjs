import { cp, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const src = resolve(root, "src/dashboard/public");
const dst = resolve(root, "dist/src/dashboard/public");

await mkdir(dst, { recursive: true });
await cp(src, dst, { recursive: true });
console.log(`copied dashboard assets: ${src} -> ${dst}`);
