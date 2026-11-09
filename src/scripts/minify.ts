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

const promises = genresJson.map(async (genre) => {
  const genreSlug = genreNameToSlug(genre.genreName);
  const filePath = path.join(cwd(), "data", "genres", `${genreSlug}.json`);

  console.log("minifying genre page for " + genreSlug);

  let genrePageJson: string;

  try {
    genrePageJson = await readFile(filePath, "utf8");
  } catch (err: any) {
    if (err.code === "ENOENT") {
      console.log(`cant find genre page for ${genreSlug}, skipping`);
      return;
    }

    throw err;
  }

  await writeFile(
    path.join(cwd(), "data", "genres", `${genreSlug}.min.json`),
    JSON.stringify(JSON.parse(genrePageJson)),
  );
});

const result = await Promise.allSettled(promises);

console.log(result);
