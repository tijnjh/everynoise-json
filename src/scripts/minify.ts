import { readFile, writeFile } from "node:fs/promises";
import genresJson from "../../data/genres.json" with { type: "json" };
import path from "node:path";
import { cwd } from "node:process";
import { genreNameToSlug } from "../utils";

console.log("minifying genres.json...");

await writeFile(
  path.join(cwd(), "data", "genres.min.json"),
  JSON.stringify(genresJson),
);

for (const genre of genresJson) {
  const genreSlug = genreNameToSlug(genre.genreName);
  console.log("minifying genre page for " + genreSlug);

  let genrePageJson: string;

  try {
    genrePageJson = await readFile(
      path.join(cwd(), "data", "genres", `${genreSlug}.json`),
      "utf8",
    );
  } catch (err: any) {
    if (err.code === "ENOENT") {
      console.log("cant find genre page for " + genreSlug + ", skipping");
      continue;
    }
  }

  await writeFile(
    path.join(cwd(), "data", "genres", `${genreSlug}.min.json`),
    JSON.stringify(genresJson),
  );
}
