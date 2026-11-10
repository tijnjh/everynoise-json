import {
  cp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { cwd } from "node:process";

const dataDir = path.join(cwd(), "data");
const minifiedDataDir = path.join(cwd(), "data-min");

await rm(minifiedDataDir, { force: true, recursive: true });
await cp(dataDir, minifiedDataDir, { recursive: true });

async function minifyJsonFiles(directory: string): Promise<number> {
  const entries = await readdir(directory, { withFileTypes: true });
  let minifiedCount = 0;

  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      minifiedCount += await minifyJsonFiles(entryPath);
      continue;
    }

    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      continue;
    }

    const json = await readFile(entryPath, "utf8");
    await writeFile(entryPath, JSON.stringify(JSON.parse(json)) + "\n");
    minifiedCount += 1;
  }

  return minifiedCount;
}

const minifiedCount = await minifyJsonFiles(minifiedDataDir);
console.log(
  `Minified ${minifiedCount} JSON files into ${path.relative(cwd(), minifiedDataDir)}`,
);

