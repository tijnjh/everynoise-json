# artist-mappings

Everynoise artists (Spotify IDs) mapped to iTunes artist IDs, made by `src/scripts/artist-mappings.ts` (`pnpm map:artists`).

## Merge all progress into one mapping

```sh
jq -s add data/artist-mappings/progress/*.json
```

This gives one `{ [spotifyId]: itunesId | null }` object. `null` means iTunes had no artist with that exact name.

When the same artist is in more than one file, the newest file wins. That only matters after a `--retry-misses` run, where the newer file may have a match instead of `null`. The script itself always prefers a match over `null`.

## Files

- `progress/<unix timestamp>.json`: the saved lookups. Every run starts a new file, and starts another every 1000 lookups. Don't edit these: anything in them is never looked up again, and deleting one makes the script redo those lookups.
- `per-genre/<slug>.json`: `{ [spotifyId]: itunesId }` in genre page order, matches only. Built from `progress/`.
- `all.json`: every matched iTunes ID, unique and sorted, for the noisedex sitemap. Built from `progress/`.

Rebuild `per-genre/` and `all.json` without making any requests:

```sh
pnpm map:artists --build
```
