import { writeFile } from "node:fs/promises";
import path from "node:path";
import { cwd } from "node:process";
import { scrappy } from "../scrappy.ts";
import { everynoiseUrl, readGenreElement } from "../utils.ts";

const $ = await scrappy({ url: everynoiseUrl });

const genres = $(".genre")
  .map((_, e) => readGenreElement($(e)))
  .get();

await Promise.all([
  writeFile(
    path.join(cwd(), "data", "genres.json"),
    JSON.stringify(genres, null, 2),
  ),
]);
