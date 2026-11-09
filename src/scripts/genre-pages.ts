import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { everynoiseUrl, genreNameToSlug, readGenreElement, readMapElement, trimLinkPostfix } from "../utils.ts";
import { scrappy } from "../scrappy.ts";
import genresJson from "../../data/genres.json" with { type: "json" };

const defaultOutput = fileURLToPath(new URL("../../data/genres/", import.meta.url));
const schemaVersion = 3;
const log = (message: string) => console.log(`[${new Date().toISOString()}] ${message}`);

class HttpError extends Error {
  status: number;
  retryAfterMs: number;
  constructor(status: number, retryAfterMs: number) {
    super(`HTTP ${status}`);
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

export function parseGenrePage(html: string, genreName: string) {
  const $ = scrappy({ html });
  const titleEl = $(".title");
  const canvas = $('.canvas[role="main"]');
  if (!titleEl.length || !canvas.length) {
    throw new Error("Response is not a genre map (missing title or main canvas)");
  }
  const artists = canvas.find(".genre").map((_, el) => ({
    artistName: trimLinkPostfix($(el).text()),
    ...readMapElement($(el)),
    id: new URL($(el).find("a").attr("href") ?? "", everynoiseUrl).searchParams.get("id") ?? undefined,
  })).get().filter((artist): artist is typeof artist & { id: string } =>
    !!artist.id && /^[a-zA-Z0-9]{22}$/.test(artist.id));
  const links = titleEl.find("a[href]").map((_, el) => ({
    text: $(el).text(),
    href: new URL($(el).attr("href")!, everynoiseUrl).href,
  })).get();
  const relatedGenres = $("#tunnel .canvas .genre")
    .map((_, el) => readGenreElement($(el))).get()
    .filter((genre) => genre.genreName !== genreName);
  return { schemaVersion, genreName, artists, links, relatedGenres };
}

export async function pregenerateGenrePages({
  genres = genresJson,
  outputDir = defaultOutput,
  delayMs = 2000,
  limit = Infinity,
  force = false,
  // Injectable for offline verification; CLI requests always use the defaults.
  fetchPage = fetch,
  wait = sleep,
}: {
  genres?: { genreName: string }[];
  outputDir?: string;
  delayMs?: number;
  limit?: number;
  force?: boolean;
  fetchPage?: typeof fetch;
  wait?: (ms: number) => Promise<unknown>;
} = {}) {
  const unique = new Map(genres.map((genre) => [genreNameToSlug(genre.genreName), genre]));
  const queue = [...unique].filter(([slug]) => !!slug).slice(0, limit);
  await mkdir(outputDir, { recursive: true });
  const started = Date.now();
  let saved = 0, skipped = 0, failed = 0, consecutiveFailures = 0;
  let requested = false;
  let cooldownMs = 0;
  log(`Starting ${queue.length} genres; one request at a time, ${delayMs}ms minimum pause; output: ${outputDir}`);

  for (const [index, [slug, { genreName }]] of queue.entries()) {
    const label = `[${index + 1}/${queue.length}] ${genreName} (${slug})`;
    const destination = path.join(outputDir, `${slug}.json`);
    if (!force) {
      try {
        const existing = JSON.parse(await readFile(destination, "utf8"));
        if (existing.schemaVersion === schemaVersion && existing.genreName === genreName && Array.isArray(existing.artists)
          && Array.isArray(existing.links) && Array.isArray(existing.relatedGenres)) {
          skipped++;
          log(`${label}: skipped (already saved)`);
          continue;
        }
        log(`${label}: refreshing saved page (outdated or incomplete data)`);
      } catch (error) {
        if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }

    try {
      let html = "";
      for (let attempt = 1; attempt <= 3; attempt++) {
        const pause = Math.max(requested ? delayMs : 0, cooldownMs);
        if (pause) {
          log(`${label}: waiting ${(pause / 1000).toFixed(1)}s`);
          // Timer delays above 2^31-1 overflow in Node; preserve long Retry-After values.
          let remaining = pause;
          while (remaining > 0) {
            const chunk = Math.min(remaining, 2_147_483_647);
            await wait(chunk);
            remaining -= chunk;
          }
        }
        cooldownMs = 0;
        requested = true;
        log(`${label}: fetching (attempt ${attempt}/3)`);
        try {
          const response = await fetchPage(`${everynoiseUrl}/engenremap-${slug}.html`, {
            signal: AbortSignal.timeout(30_000),
          });
          if (!response.ok) {
            const retryAfter = response.headers.get("retry-after");
            const seconds = retryAfter === null ? NaN : Number(retryAfter);
            const retryAfterMs = Number.isFinite(seconds)
              ? Math.max(0, seconds * 1000)
              : Math.max(0, Date.parse(retryAfter ?? "") - Date.now()) || 0;
            await response.body?.cancel();
            throw new HttpError(response.status, retryAfterMs);
          }
          html = await response.text();
          break;
        } catch (error) {
          const retryable = !(error instanceof HttpError) || error.status === 429
            || error.status === 408 || error.status >= 500;
          if (retryable) {
            cooldownMs = Math.max(5000 * 2 ** (attempt - 1), error instanceof HttpError ? error.retryAfterMs : 0);
          }
          if (!retryable || attempt === 3) throw error;
          log(`${label}: ${error instanceof Error ? error.message : String(error)}; retrying after ${(cooldownMs / 1000).toFixed(1)}s`);
        }
      }
      const page = parseGenrePage(html, genreName);
      // Rename only complete files so interrupted writes cannot become cached successes.
      await writeFile(`${destination}.tmp`, JSON.stringify(page, null, 2));
      await rename(`${destination}.tmp`, destination);
      saved++;
      consecutiveFailures = 0;
      log(`${label}: saved ${page.artists.length} artists, ${page.relatedGenres.length} related genres`);
    } catch (error) {
      failed++;
      consecutiveFailures++;
      log(`${label}: FAILED: ${error instanceof Error ? error.message : String(error)}`);
      if (consecutiveFailures >= 5 || (error instanceof HttpError && [403, 429].includes(error.status))) {
        log("Stopping: server blocked requests, rate limit persisted, or five consecutive genres failed. Rerun later to resume.");
        break;
      }
    }
  }
  const remaining = queue.length - saved - skipped - failed;
  log(`Finished in ${((Date.now() - started) / 1000).toFixed(1)}s: ${saved} saved, ${skipped} skipped, ${failed} failed, ${remaining} unprocessed`);
  return { saved, skipped, failed, remaining };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.includes("--help")) {
      console.log("Usage: node src/scripts/genre-pages.ts [--limit=N] [--delay-ms=N] [--force]\nDefaults: 2000ms pause, all genres, skip saved pages with the current schema. Minimum CLI pause: 1000ms.");
    } else {
      for (const arg of args) {
        if (arg !== "--force" && !/^--(limit|delay-ms)=\d+$/.test(arg)) throw new Error(`Unknown or invalid argument: ${arg}`);
      }
      const numberArg = (name: string, fallback: number) => Number(args.find((arg) => arg.startsWith(`--${name}=`))?.split("=")[1] ?? fallback);
      const delayMs = numberArg("delay-ms", 2000);
      const limit = numberArg("limit", Infinity);
      if (!Number.isSafeInteger(delayMs) || delayMs < 1000 || (limit !== Infinity && (!Number.isSafeInteger(limit) || limit < 1))) {
        throw new Error("--delay-ms must be an integer >= 1000; --limit must be a positive integer");
      }
      const result = await pregenerateGenrePages({ delayMs, limit, force: args.includes("--force") });
      if (result.failed || result.remaining) process.exitCode = 1;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
