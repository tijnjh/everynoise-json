import { readFile, rename, writeFile } from "node:fs/promises";
import genres from "../../data/genres.json" with { type: "json" };
import { genreNameToSlug } from "../utils.ts";

// Enrich saved pages using only the existing homepage dataset. No requests.
let updated = 0;
let missing = 0;
for (const genre of genres) {
  const destination = new URL(
    `../../data/genres/${genreNameToSlug(genre.genreName)}.json`,
    import.meta.url,
  );
  let original: string;
  try {
    original = await readFile(destination, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    missing++;
    continue;
  }
  const page = JSON.parse(original);
  if (page.genreName !== genre.genreName) {
    throw new Error(`Genre name mismatch in ${destination.pathname}`);
  }
  // Keep page-specific data and overlay all homepage fields at the top level.
  const merged = JSON.stringify({ ...page, ...genre }, null, 2);
  if (merged === original) continue;
  const temporary = new URL(`${destination.href}.tmp`);
  await writeFile(temporary, merged);
  await rename(temporary, destination);
  updated++;
}
console.log(`Updated ${updated} genre pages; ${missing} missing pages skipped.`);
