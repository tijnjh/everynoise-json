import * as cheerio from "cheerio";

export function scrappy({}: { url: string }): Promise<cheerio.CheerioAPI>;
export function scrappy({}: { html: string }): cheerio.CheerioAPI;
export function scrappy(opts: { html?: string; url?: string }) {
  if (opts.url)
    return fetch(opts.url)
      .then((r) => r.text())
      .then((html) => scrappy({ html }));

  return cheerio.load(opts.html!, {});
}
