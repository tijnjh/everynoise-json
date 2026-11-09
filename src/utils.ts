export interface MapElementData {
  /** Pixel coordinates relative to the containing canvas. */
  positioning: {
    top: number | null;
    left: number | null;
  };
  style: {
    color: string | null;
    /** Original CSS value with units (usually a percentage). */
    fontSize: string | null;
  };
  preview: {
    url: string | null;
    title: string | null;
    trackId: string | null;
  };
  elementId: string | null;
  href: string | null;
}

export interface Genre extends MapElementData {
  genreName: string;
}

export const everynoiseUrl = "https://everynoise.com";

export function genreNameToSlug(genre: string | undefined | null) {
  if (!genre) return;
  return genre.toLowerCase().replace(/[^a-z0-9]/gi, "");
}

export function findSoundOfPlaylistId(
  links: Array<{ text: string; href: string }>,
) {
  const fullUrl = links.find((l) => l.text === "playlist")?.href;
  if (!fullUrl) return;
  return fullUrl.replace("https://open.spotify.com/playlist/", "");
}

export function trimLinkPostfix(str: string) {
  return str.trim().endsWith("»") ? str.trim().replace("»", "") : str;
}

export function splitPreviewTitle(previewTitle: string | undefined | null) {
  if (previewTitle == null) return;

  if (previewTitle.startsWith("e.g.")) {
    previewTitle = previewTitle.replace("e.g.", "");
  }

  const match = previewTitle.trim().match(/^(.+?)\s+"([\s\S]*)"$/);
  if (!match) return;

  const [, artist, title] = match;
  return { artist: artist?.trimEnd(), title };
}

import type * as cheerio from "cheerio";

export function readMapElement(element: cheerio.Cheerio<any>): MapElementData {
  const pixels = (property: string) => {
    const value = element.css(property)?.trim();
    if (!value || !/^-?(?:\d+(?:\.\d+)?|\.\d+)(?:px)?$/.test(value)) return null;
    const number = Number.parseFloat(value);
    return Number.isFinite(number) ? number : null;
  };
  const href = element.find("a[href]").first().attr("href");
  return {
    positioning: {
      top: pixels("top"),
      left: pixels("left"),
    },
    style: {
      color: element.css("color") ?? null,
      fontSize: element.css("font-size") ?? null,
    },
    preview: {
      url: element.attr("preview_url") ?? null,
      title: element.attr("title") ?? null,
      trackId: element.attr("onclick")?.match(/\bplayx\(\s*["']([a-zA-Z0-9]{22})["']/)?.[1] ?? null,
    },
    elementId: element.attr("id") ?? null,
    href: href ? new URL(href, everynoiseUrl).href : null,
  };
}

export function readGenreElement(element: cheerio.Cheerio<any>) {
  return {
    genreName: trimLinkPostfix(element.text()),
    ...readMapElement(element),
  };
}
