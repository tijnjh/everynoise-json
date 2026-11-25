// Maps every everynoise artist (spotify id) to an itunes artist id.
//
//   node src/scripts/artist-mappings.ts                  look up whatever is missing, then build
//   node src/scripts/artist-mappings.ts --build          only rebuild the output, no requests
//   node src/scripts/artist-mappings.ts --max-per-genre 20
//   node src/scripts/artist-mappings.ts --retry-misses --country nl
//   node src/scripts/artist-mappings.ts --shard 2/3      split the work over several processes
//
// Progress, in artist-mappings/progress/:
//   <unix timestamp>.json   { [spotifyId]: itunesId | null }, null meaning itunes had no artist
//                           with that name. A run starts a new file, and a new one again every
//                           1000 lookups, so files stay small. Merged together they're the full
//                           mapping, and anything in them is never looked up again.
//
// Output, built from the progress:
//   artist-mappings/per-genre/<slug>.json   { [spotifyId]: itunesId } in genre page order, matches only
//   artist-mappings/all.json                every matched itunes id, unique and sorted
//
// Safe to stop (ctrl+c) and rerun at any time. Each lookup is saved as soon as it finishes, and
// files are only ever replaced whole, so a crash can't leave half a file. Errors (rate limits,
// timeouts) are never saved, so those get retried. Parallel runs each write their own files.

import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const root = fileURLToPath(new URL("../../", import.meta.url));
const genresDir = path.join(root, "data-min/genres");
const outputDir = path.join(root, "artist-mappings");
const progressDir = path.join(outputDir, "progress");
const perGenreDir = path.join(outputDir, "per-genre");
const lookupsPerFile = 1000;

const { values: args } = parseArgs({
  options: {
    build: { type: "boolean", default: false },
    "max-per-genre": { type: "string" },
    "retry-misses": { type: "boolean", default: false },
    country: { type: "string", default: "us" },
    shard: { type: "string", default: "1/1" },
    // itunes allows roughly 20 searches a minute per ip
    "delay-ms": { type: "string", default: "3100" },
    limit: { type: "string" },
  },
});

const maxPerGenre = args["max-per-genre"] ? positiveInt(args["max-per-genre"], "--max-per-genre") : Infinity;
const limit = args.limit ? positiveInt(args.limit, "--limit") : Infinity;
const delayMs = positiveInt(args["delay-ms"], "--delay-ms");
const country = args.country.toLowerCase();
if (!/^[a-z]{2}$/.test(country)) fail(`--country must be a two letter store code, got "${args.country}"`);
const [shardIndex, shardCount] = parseShard(args.shard);

const log = (message: string) => console.log(`[${new Date().toISOString()}] ${message}`);

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function positiveInt(value: string, name: string) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) fail(`${name} must be a positive whole number, got "${value}"`);
  return number;
}

function parseShard(value: string) {
  const match = value.match(/^(\d+)\/(\d+)$/);
  const [index, count] = match ? [Number(match[1]), Number(match[2])] : [0, 0];
  if (!match || count < 1 || index < 1 || index > count) fail(`--shard must look like 2/3, got "${value}"`);
  return [index - 1, count] as const;
}

// --- input ---

interface Genre {
  slug: string;
  artists: { id: string; name: string }[];
}

async function readGenres() {
  const files = (await readdir(genresDir)).filter((file) => file.endsWith(".json")).sort();
  if (!files.length) fail(`No genre pages found in ${genresDir}`);

  const genres: Genre[] = [];
  for (const file of files) {
    const page = JSON.parse(await readFile(path.join(genresDir, file), "utf8")) as {
      artists?: { id?: string; artistName?: string }[];
    };
    const seen = new Set<string>();
    const artists: Genre["artists"] = [];
    for (const artist of page.artists ?? []) {
      const name = artist.artistName?.trim();
      if (!artist.id || !/^[a-zA-Z0-9]{22}$/.test(artist.id) || !name || seen.has(artist.id)) continue;
      seen.add(artist.id);
      artists.push({ id: artist.id, name });
    }
    genres.push({ slug: file.slice(0, -".json".length), artists });
  }
  return genres;
}

// --- progress ---

// spotify id -> itunes id, or null when itunes had no matching artist
type Mappings = Map<string, number | null>;

// a match always beats a miss, so a later --retry-misses can only add matches
function remember(mappings: Mappings, spotifyId: string, itunesId: number | null) {
  if (itunesId !== null || !mappings.has(spotifyId)) mappings.set(spotifyId, itunesId);
}

async function readProgress() {
  await mkdir(progressDir, { recursive: true });
  const mappings: Mappings = new Map();
  const files = (await readdir(progressDir)).filter((file) => /^\d+\.json$/.test(file));

  for (const file of files.sort((a, b) => parseInt(a) - parseInt(b))) {
    let entries: [string, unknown][];
    try {
      entries = Object.entries(JSON.parse(await readFile(path.join(progressDir, file), "utf8")));
    } catch {
      // can't happen since files are replaced whole, but don't fail a multi day run over it
      log(`Skipping progress/${file}, it isn't valid json`);
      continue;
    }
    for (const [spotifyId, itunesId] of entries) {
      if (itunesId === null || Number.isInteger(itunesId)) remember(mappings, spotifyId, itunesId as number | null);
    }
  }
  return mappings;
}

async function replaceFile(file: string, contents: string) {
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, contents);
  await rename(temporary, file);
}

// one entry per line, so git diffs stay readable
const toJson = (entries: [string, number | null][]) =>
  entries.length
    ? `{\n${entries.map(([key, value]) => `${JSON.stringify(key)}:${JSON.stringify(value)}`).join(",\n")}\n}\n`
    : "{}\n";

class ProgressFile {
  private entries: [string, number | null][] = [];
  private file = "";

  async add(spotifyId: string, itunesId: number | null) {
    if (!this.file || this.entries.length >= lookupsPerFile) await this.start();
    this.entries.push([spotifyId, itunesId]);
    await replaceFile(this.file, toJson(this.entries));
  }

  private async start() {
    // a fresh timestamp, waiting a moment if another run already took this second
    for (let timestamp = Math.floor(Date.now() / 1000); ; timestamp++) {
      const file = path.join(progressDir, `${timestamp}.json`);
      try {
        await writeFile(file, "{}\n", { flag: "wx" });
        this.file = file;
        this.entries = [];
        log(`Saving progress to ${path.relative(root, file)}`);
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
  }
}

// --- output ---

async function build(genres: Genre[], mappings: Mappings) {
  await mkdir(perGenreDir, { recursive: true });
  const ids = new Set<number>();

  for (const genre of genres) {
    const entries: [string, number][] = [];
    for (const artist of genre.artists) {
      const itunesId = mappings.get(artist.id);
      if (itunesId == null) continue;
      entries.push([artist.id, itunesId]);
      ids.add(itunesId);
    }
    const file = path.join(perGenreDir, `${genre.slug}.json`);
    const contents = toJson(entries);
    if ((await readFile(file, "utf8").catch(() => undefined)) !== contents) await replaceFile(file, contents);
  }

  await replaceFile(path.join(outputDir, "all.json"), `${JSON.stringify([...ids].sort((a, b) => a - b))}\n`);
  log(`Built ${genres.length} genre files and all.json with ${ids.size} itunes ids`);
}

// --- itunes ---

class RetryableError extends Error {}

function normalizeName(name: string) {
  return name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/&|\+/g, " and ")
    .replace(/^the\s+/, "")
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

// only an exact name match counts, a wrong mapping is worse than none
async function findItunesArtist(name: string) {
  const url = new URL("https://itunes.apple.com/search");
  url.search = new URLSearchParams({
    term: name,
    entity: "musicArtist",
    attribute: "artistTerm",
    limit: "25",
    country,
  }).toString();

  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  } catch (error) {
    throw new RetryableError(`request failed: ${(error as Error).message}`);
  }
  if (!response.ok) throw new RetryableError(`HTTP ${response.status}`);

  let body: { results?: { wrapperType?: string; artistName?: string; artistId?: number }[] };
  try {
    body = await response.json();
  } catch {
    throw new RetryableError("response was not json");
  }
  if (!Array.isArray(body.results)) throw new RetryableError("response had no results list");

  const wanted = normalizeName(name);
  if (!wanted) return null;
  const match = body.results.find(
    (result) =>
      result.wrapperType === "artist" &&
      Number.isInteger(result.artistId) &&
      normalizeName(result.artistName ?? "") === wanted,
  );
  return match?.artistId ?? null;
}

// --- main ---

function shardOf(spotifyId: string) {
  let hash = 0;
  for (const char of spotifyId) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash % shardCount;
}

function formatDuration(ms: number) {
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.round((ms % 3_600_000) / 60_000);
  return hours ? `${hours}h ${minutes}m` : `${minutes}m`;
}

const genres = await readGenres();
const mappings = await readProgress();

if (args.build) {
  await build(genres, mappings);
  process.exit(0);
}

// the first artist of every genre, then the second of every genre, and so on,
// so the best known artists are mapped first and an early stop still covers every genre
const queue: { id: string; name: string }[] = [];
const queued = new Set<string>();
const depth = Math.min(maxPerGenre, Math.max(...genres.map((genre) => genre.artists.length)));
for (let position = 0; position < depth; position++) {
  for (const genre of genres) {
    const artist = genre.artists[position];
    if (!artist || queued.has(artist.id)) continue;
    queued.add(artist.id);
    const retry = args["retry-misses"] && mappings.get(artist.id) === null;
    if ((!mappings.has(artist.id) || retry) && shardOf(artist.id) === shardIndex) queue.push(artist);
  }
}
const todo = queue.slice(0, limit);

log(
  `${queued.size} artists in scope, ${mappings.size} already looked up, ${todo.length} to do` +
    (shardCount > 1 ? ` in shard ${shardIndex + 1}/${shardCount}` : "") +
    ` (about ${formatDuration(todo.length * delayMs)} at one per ${delayMs}ms)`,
);

let stopping = false;
process.on("SIGINT", () => {
  if (stopping) process.exit(130);
  stopping = true;
  log("Stopping after the current lookup (ctrl+c again to quit right away)");
});
process.on("SIGTERM", () => (stopping = true));

async function sleepUnlessStopping(ms: number) {
  const until = Date.now() + ms;
  while (!stopping && Date.now() < until) await sleep(Math.min(500, until - Date.now()));
}

const progress = new ProgressFile();
const startedAt = Date.now();
let done = 0;
let matched = 0;
let backoffMs = 0;

for (const artist of todo) {
  if (stopping) break;

  while (!stopping) {
    const requestedAt = Date.now();
    try {
      const itunesId = await findItunesArtist(artist.name);
      await progress.add(artist.id, itunesId);
      remember(mappings, artist.id, itunesId);
      done++;
      if (itunesId !== null) matched++;
      backoffMs = 0;
      break;
    } catch (error) {
      if (!(error instanceof RetryableError)) throw error;
      // rate limits come as 403s, so back off hard and keep trying
      backoffMs = Math.min(backoffMs ? backoffMs * 2 : 60_000, 15 * 60_000);
      log(`"${artist.name}": ${error.message}, waiting ${formatDuration(backoffMs)} before retrying`);
      await sleepUnlessStopping(backoffMs);
    } finally {
      await sleepUnlessStopping(delayMs - (Date.now() - requestedAt));
    }
  }

  if (done && done % 100 === 0) {
    const perLookup = (Date.now() - startedAt) / done;
    log(
      `${done}/${todo.length} done, ${Math.round((matched / done) * 100)}% matched, ` +
        `about ${formatDuration((todo.length - done) * perLookup)} left`,
    );
  }
}

log(`Looked up ${done} artists this run, ${matched} matched`);
// reread so lookups from parallel runs end up in the output too
await build(genres, await readProgress());
