/**
 * LinkedIn post search and post details.
 *
 * LinkedIn's own post search requires a login, so posts are discovered through a web
 * search for site:linkedin.com/posts: the Brave Search API when BRAVE_SEARCH_API_KEY is
 * set, otherwise DuckDuckGo. Individual public posts are then readable without a login.
 */

import * as cheerio from 'cheerio';
import { fetchHtml } from './http.js';
import { DEFAULT_LIMIT, LINKEDIN_BASE } from './constants.js';
import type { LinkedInPost, PostDetails, PostSearchParams, PostSearchResult } from './types.js';

interface SearchHit {
  href: string;
  title: string;
  snippet: string;
}

interface SearchEngine {
  url: string;
  parse: ($: cheerio.CheerioAPI) => SearchHit[];
}

/** Tried in order; the next one is used when a search engine serves a bot check. */
const SEARCH_ENGINES: SearchEngine[] = [
  {
    url: 'https://html.duckduckgo.com/html/',
    parse: $ => $('.result').not('.result--ad').toArray().map(el => ({
      href: $(el).find('a.result__a').attr('href') ?? '',
      title: clean($(el).find('a.result__a').text()),
      snippet: clean($(el).find('.result__snippet').text()),
    })),
  },
  {
    url: 'https://lite.duckduckgo.com/lite/',
    parse: $ => $('a.result-link').toArray().map(el => ({
      href: $(el).attr('href') ?? '',
      title: clean($(el).text()),
      snippet: clean($(el).closest('tr').nextAll('tr').first().find('.result-snippet').text()),
    })),
  },
];

const isBotCheck = (html: string) => /anomaly|captcha|challenge-form|unusual traffic/i.test(html);

/** Search-engine result links are often redirects of the form //duckduckgo.com/l/?uddg=<target>. */
function resolveResultLink(href: string): string {
  try {
    const url = new URL(href, 'https://duckduckgo.com');
    return url.searchParams.get('uddg') ?? url.toString();
  } catch {
    return href;
  }
}

async function searchDuckDuckGo(query: string, datePosted?: string): Promise<SearchHit[]> {
  const form: Record<string, string> = { q: query };
  const dateCode = datePosted ? DUCKDUCKGO_DATE_CODES[datePosted] : undefined;
  if (dateCode) form.df = dateCode;

  for (const engine of SEARCH_ENGINES) {
    const html = await fetchHtml(engine.url, { form });
    const hits = engine.parse(cheerio.load(html));
    if (hits.length > 0 || !isBotCheck(html)) return hits;
  }
  throw new Error('DuckDuckGo is blocking automated searches right now.');
}

// ============ Brave Search API (optional, set BRAVE_SEARCH_API_KEY) ============

const BRAVE_SEARCH_URL = 'https://api.search.brave.com/res/v1/web/search';
const BRAVE_PAGE_SIZE = 20;

const BRAVE_FRESHNESS: Record<string, string> = {
  'past-24-hours': 'pd', 'past-week': 'pw', 'past-month': 'pm',
};

interface BraveResponse {
  web?: { results?: { url: string; title?: string; description?: string }[] };
  query?: { more_results_available?: boolean };
}

/** Brave descriptions contain highlight markup such as <strong>; return plain text. */
const stripTags = (html = '') => clean(cheerio.load(html, null, false).root().text());

async function searchBrave(apiKey: string, query: string, limit: number, datePosted?: string): Promise<SearchHit[]> {
  const hits: SearchHit[] = [];
  const maxPages = Math.min(Math.ceil(limit / BRAVE_PAGE_SIZE), 5);

  for (let offset = 0; offset < maxPages; offset++) {
    const sp = new URLSearchParams({ q: query, count: String(BRAVE_PAGE_SIZE), offset: String(offset) });
    const freshness = datePosted ? BRAVE_FRESHNESS[datePosted] : undefined;
    if (freshness) sp.set('freshness', freshness);

    const body = await fetchHtml(`${BRAVE_SEARCH_URL}?${sp}`, {
      headers: { Accept: 'application/json', 'X-Subscription-Token': apiKey },
    });
    const data = JSON.parse(body) as BraveResponse;

    for (const r of data.web?.results ?? []) {
      hits.push({ href: r.url, title: stripTags(r.title), snippet: stripTags(r.description) });
    }
    if (!data.query?.more_results_available) break;
  }
  return hits;
}

/**
 * Search the web with Brave when an API key is configured, falling back to
 * DuckDuckGo (free, but it sometimes blocks automated requests).
 */
async function searchWeb(
  query: string,
  limit: number,
  datePosted?: string,
): Promise<{ hits: SearchHit[]; source: PostSearchResult['source'] }> {
  const apiKey = process.env.BRAVE_SEARCH_API_KEY?.trim();
  let braveError: string | undefined;

  if (apiKey) {
    try {
      return { hits: await searchBrave(apiKey, query, limit, datePosted), source: 'brave' };
    } catch (error) {
      braveError = error instanceof Error ? error.message : String(error);
    }
  }

  try {
    return { hits: await searchDuckDuckGo(query, datePosted), source: 'duckduckgo' };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const hint = apiKey
      ? `Brave Search also failed: ${braveError}`
      : 'Set BRAVE_SEARCH_API_KEY for reliable post search (see README).';
    throw new Error(`Post search failed. ${reason} ${hint}`);
  }
}

const DUCKDUCKGO_DATE_CODES: Record<string, string> = {
  'past-24-hours': 'd', 'past-week': 'w', 'past-month': 'm',
};

const LINKEDIN_DATE_CODES: Record<string, string> = {
  'past-24-hours': 'past-24h', 'past-week': 'past-week', 'past-month': 'past-month',
};

const HIRING_PATTERN =
  /\b(hiring|we'?re hiring|now hiring|join (our|my) team|open (role|position)s?|looking for|apply|recruiting|job opening|vacanc(y|ies)|buscamos|estamos buscando)\b/i;

const clean = (text: string) => text.replace(/\s+/g, ' ').trim();
const isHiringText = (text: string) => HIRING_PATTERN.test(text);

// ============ URL helpers ============

function buildSearchQuery(params: PostSearchParams): string {
  const parts = ['site:linkedin.com/posts', params.keywords];
  if (params.company) parts.push(`"${params.company}"`);
  if (params.hiringOnly) parts.push('hiring');
  return parts.join(' ');
}

/** LinkedIn's own post search URL. Opening it requires being signed in to LinkedIn. */
export function buildPostSearchUrl(params: Omit<PostSearchParams, 'limit'>): string {
  const sp = new URLSearchParams();
  sp.set('keywords', [params.keywords, params.company, params.hiringOnly ? 'hiring' : ''].filter(Boolean).join(' '));
  if (params.datePosted && params.datePosted !== 'any-time') {
    sp.set('datePosted', `"${LINKEDIN_DATE_CODES[params.datePosted]}"`);
  }
  sp.set('sortBy', '"date_posted"');
  return `${LINKEDIN_BASE}/search/results/content/?${sp}`;
}

/** Normalize a post URL to www.linkedin.com (drops country subdomains and query strings). */
function normalizePostUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (!url.hostname.endsWith('linkedin.com')) return null;
    if (!/^\/(posts|feed\/update)\//.test(url.pathname)) return null;
    return `${LINKEDIN_BASE}${url.pathname}`;
  } catch {
    return null;
  }
}

function extractActivityId(url: string): string {
  return url.match(/activity[-:](\d+)/)?.[1] ?? url;
}

/** Post URLs look like /posts/{author-vanity}_{slug}-activity-{id}. */
function extractAuthorVanity(url: string): string | undefined {
  return url.match(/\/posts\/([^_/]+)_/)?.[1];
}

/** Search-result titles usually look like "Post title | Author Name - LinkedIn". */
function authorFromTitle(title: string): string | undefined {
  return title.match(/\|\s*([^|]+?)\s*-\s*LinkedIn$/)?.[1] ?? title.match(/^(.+?) on LinkedIn:/)?.[1];
}

// ============ Public API ============

export async function searchPosts(params: PostSearchParams): Promise<PostSearchResult> {
  const query = buildSearchQuery(params);
  const limit = params.limit ?? DEFAULT_LIMIT;
  const { hits, source } = await searchWeb(query, limit, params.datePosted);
  const posts: LinkedInPost[] = [];
  const seen = new Set<string>();

  for (const { href, title, snippet } of hits) {
    const url = normalizePostUrl(resolveResultLink(href));
    if (!url || seen.has(url)) continue;
    seen.add(url);

    const vanity = extractAuthorVanity(url);

    posts.push({
      id: extractActivityId(url),
      url,
      author: authorFromTitle(title) ?? vanity ?? 'Unknown',
      authorProfileUrl: vanity ? `${LINKEDIN_BASE}/in/${vanity}` : undefined,
      title,
      snippet,
      isHiring: isHiringText(`${title} ${snippet}`),
    });
  }

  const filtered = params.hiringOnly ? posts.filter(p => p.isHiring) : posts;

  return {
    posts: filtered.slice(0, limit),
    query,
    source,
    linkedInSearchUrl: buildPostSearchUrl(params),
  };
}

interface SocialMediaPostingLd {
  '@type'?: string;
  articleBody?: string;
  datePublished?: string;
  author?: { name?: string; url?: string };
}

function readPostingLd($: cheerio.CheerioAPI): SocialMediaPostingLd | undefined {
  for (const el of $('script[type="application/ld+json"]').toArray()) {
    try {
      const data = JSON.parse($(el).text()) as SocialMediaPostingLd;
      if (data['@type'] === 'SocialMediaPosting') return data;
    } catch { /* ignore malformed JSON-LD */ }
  }
  return undefined;
}

const toCount = (text: string) => {
  const digits = text.replace(/[^\d]/g, '');
  return digits ? Number(digits) : undefined;
};

/** Get the full content of a public LinkedIn post. */
export async function getPostDetails(postUrl: string): Promise<PostDetails | null> {
  const url = normalizePostUrl(postUrl);
  if (!url) throw new Error('Expected a LinkedIn post URL (linkedin.com/posts/... or linkedin.com/feed/update/...)');

  const $ = cheerio.load(await fetchHtml(url));
  const ld = readPostingLd($);
  const $actor = $('[data-tracking-control-name="public_post_feed-actor-name"]').first();

  const content = ld?.articleBody?.trim() ||
    $('[data-test-id="main-feed-activity-card__commentary"]').first().text().trim();
  if (!content) return null;

  const author = ld?.author?.name || clean($actor.text()) || extractAuthorVanity(url) || 'Unknown';

  return {
    id: extractActivityId(url),
    url,
    author,
    authorProfileUrl: ld?.author?.url || $actor.attr('href')?.split('?')[0],
    content,
    publishedAt: ld?.datePublished,
    reactions: toCount($('[data-test-id="social-actions__reaction-count"]').first().text()),
    comments: toCount($('[data-test-id="social-actions__comments"]').first().text()),
    isHiring: isHiringText(content),
  };
}
