import path from "node:path";
import genres from "../../data/genres.min.json" with { type: "json" };
import { genreNameToSlug } from "../utils";
import { cwd } from "node:process";
import { readFile, writeFile } from "node:fs/promises";
import type genrePage from "../../data/genres/21stcenturyclassical.json";
import { existsSync } from "node:fs";
type GenrePage = typeof genrePage;

// const promises = genresJson.map(async (genre) => {
for (const genre of genres) {
  const genreSlug = genreNameToSlug(genre.genreName);
  const filePath = path.join(cwd(), "data", "genres", `${genreSlug}.json`);

  console.log("extracting artists from " + genreSlug);

  let genrePageJson: string;

  try {
    genrePageJson = await readFile(filePath, "utf8");
  } catch (err: any) {
    if (err.code === "ENOENT") {
      console.log(`cant find genre page for ${genreSlug}, skipping`);
      continue;
    }

    throw err;
  }

  const genrePage = JSON.parse(genrePageJson) as GenrePage;

  for (const artist of genrePage.artists) {
    const artistFilePath = path.join(
      cwd(),
      "data",
      "artists",
      `${artist.id}.json`,
    );

    const prevContent = await readFile(artistFilePath, "utf-8").catch(() => "");

    const prevObj = JSON.parse(prevContent || JSON.stringify(artist));

    prevObj.genres = [...(prevObj?.genres ?? []), genreSlug];

    await writeFile(artistFilePath, JSON.stringify(prevObj, null, 2));
  }
}
// });
