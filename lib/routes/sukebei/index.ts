import { type Cheerio, load } from 'cheerio';
import MarkdownIt from 'markdown-it';
import pMap from 'p-map';

import type { DataItem, Route } from '@/types';
import cache from '@/utils/cache';
import ofetch from '@/utils/ofetch';
import { parseDate } from '@/utils/parse-date';
import { getPlaywrightPage } from '@/utils/playwright';

const md = new MarkdownIt();

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Bounded concurrency for the per-item detail fetches. Kept low (the site is
// anti-crawler) but high enough to avoid a fully serial crawl, which used to
// push a 30-item cold request past the upstream timeout.
const DETAIL_CONCURRENCY = 3;
// Light pacing between detail requests; real throttling is handled by the
// 429-aware retry below rather than a fixed sleep.
const DETAIL_DELAY_MS = 500;
// Hard ceiling for a single ouo.io resolution (it is usually CF-walled and
// returns null anyway), so one stuck link can't burn a whole minute.
const OUO_MAX_MS = 25000;
// Cap how many ouo links are resolved per description — each one is a slow
// browser session, so resolving every link in a long description would stall.
const OUO_MAX_PER_ITEM = 3;

type ListItem = {
    title: string;
    link: string;
    pubDate: Date;
};

/**
 * Regex that matches any link requiring resolution (imagetwist.com pages,
 * ouo.io / ouo.press shorteners). Handles plain URLs, BBCode-wrapped, etc.
 */
const IMAGE_LINK_RE = /https?:\/\/(?:[a-z0-9-]+\.)*(?:imagetwist\.com|ouo\.io|ouo\.press)\/[^\s<>"'\]]+/gi;

/**
 * Regex for BBCode patterns wrapping image links — used for replacement.
 */
const BBCODE_URL_IMG_RE = /\[url=https?:\/\/(?:[a-z0-9-]+\.)*(?:imagetwist\.com|ouo\.io|ouo\.press)\/[^\]]*\]\s*\[img\]([^[]+)\[\/img\]\s*\[\/url\]/gi;
const BBCODE_IMG_RE = /\[img\](https?:\/\/(?:[a-z0-9-]+\.)*(?:imagetwist\.com|ouo\.io|ouo\.press)\/[^[]+)\[\/img\]/gi;

/**
 * Whether a URL is an ouo.io / ouo.press short link (needs browser resolution).
 */
const isOuo = (url: string): boolean => /ouo\.(?:io|press)/.test(url);

/**
 * Extract all unique resolvable image links from raw text.
 */
function extractImageLinks(text: string): string[] {
    const matches = text.match(IMAGE_LINK_RE);
    if (!matches) {
        return [];
    }
    return [...new Set(matches)];
}

/**
 * Fetch an imagetwist.com page and extract the actual direct image URL.
 * The page contains an <img class="pic img img-responsive"> whose `src`
 * is the true image URL (e.g. https://img###.imagetwist.com/i/...).
 *
 * Falls back to pattern-matching for /i/ URLs in the HTML body.
 */
async function resolveImagetwistUrl(url: string): Promise<string | null> {
    try {
        const html = await ofetch(url, { responseType: 'text' as const, timeout: 10000 });
        const $ = load(html);

        // Prefer: <img class="pic img img-responsive">
        const mainImg = $('img.pic.img-responsive, img.pic.img').first().attr('src');
        if (mainImg) {
            return mainImg.startsWith('//') ? `https:${mainImg}` : mainImg;
        }

        // Fallback: search for any URL matching the /i/ direct-image pattern
        const fallback = html.match(/https?:\/\/img\d+\.imagetwist\.com\/i\/[^\s<>"']+/i);
        if (fallback) {
            return fallback[0];
        }

        return null;
    } catch {
        return null;
    }
}

/**
 * Resolve a ouo.io / ouo.press short link to the final image URL.
 *
 * ouo.io is protected by Cloudflare Turnstile + Adscore and requires a real
 * browser to pass. The flow is multi-step:
 *   1. /<id> page shows an "I'm a human" button
 *   2. clicking it posts to /go/<id> which shows a "Get Link" button
 *   3. clicking that finally redirects to the destination (e.g. ibb.co)
 *
 * Needs a real browser binary (CHROMIUM_EXECUTABLE_PATH) — headless Chromium
 * is usually blocked by Cloudflare. Returns null on any failure so the caller
 * can fall back to keeping the original link.
 */
async function resolveOuoUrl(url: string): Promise<string | null> {
    let pageObj: Awaited<ReturnType<typeof getPlaywrightPage>> | undefined;
    try {
        pageObj = await getPlaywrightPage(url, {
            closeTimeout: 60000,
            gotoConfig: { waitUntil: 'domcontentloaded', timeout: 45000 },
        });
        const { page, destroy } = pageObj;

        let finalUrl: string | null = null;
        let cfStart: number | null = null;
        const deadline = Date.now() + OUO_MAX_MS;

        // oxlint-disable no-await-in-loop — intentional polling loop
        for (let i = 0; i < 40; i++) {
            if (Date.now() > deadline) {
                break;
            }
            await page.waitForTimeout(1500);
            let currentUrl: string;
            let bodyText: string;
            try {
                currentUrl = page.url();
                bodyText = await page.evaluate(() => document.body?.textContent ?? '');
            } catch {
                continue; // page is navigating, skip this tick
            }

            // Reached a non-ouo destination
            if (!/ouo\.(?:io|press)/.test(currentUrl)) {
                finalUrl = currentUrl;
                break;
            }

            // Cloudflare wall: give it up to ~20s to auto-pass, then bail
            if (/performing security verification|just a moment/i.test(bodyText)) {
                if (cfStart === null) {
                    cfStart = Date.now();
                } else if (Date.now() - cfStart > 20000) {
                    break;
                }
            } else {
                cfStart = null;
            }

            // Click the enabled #btn-main ("I'm a human" / "Get Link")
            try {
                await page.evaluate(() => {
                    const btn = document.querySelector('#btn-main') as HTMLButtonElement | null;
                    if (btn && !btn.className.includes('disabled')) {
                        btn.click();
                        return true;
                    }
                    return false;
                });
            } catch {
                // page navigating, will retry next tick
            }
        }
        // oxlint-enable no-await-in-loop

        if (!finalUrl) {
            await destroy();
            return null;
        }

        // Destination reached — wait for the page to finish loading before extracting
        try {
            await page.waitForLoadState('load', { timeout: 15000 });
        } catch {
            // some destinations never fire 'load'; content below still applies
        }
        await page.waitForTimeout(1000);
        let html = '';
        try {
            html = await page.content();
        } catch {
            // ignore
        }
        await destroy();

        // Direct image URL already — but exclude gallery/show pages like
        // pixhost.cc/show/<folder>/<file>.jpg which are HTML pages, not images
        if (/\.(?:jpe?g|png|gif|webp)(?:\?.*)?$/i.test(finalUrl) && !/\/show\//i.test(finalUrl)) {
            return finalUrl;
        }

        const $ = load(html);

        // 1. og:image meta tag (works for imgbb, imgur, most galleries)
        const ogImage = $('meta[property="og:image"]').attr('content');
        if (ogImage) {
            return ogImage.startsWith('//') ? `https:${ogImage}` : ogImage;
        }

        // 2. Known image CDN patterns (pixhost.to/.cc, imgbb, imgur)
        const knownHost = html.match(/https?:\/\/img\d+\.pixhost\.(?:cc|to)\/images\/[^\s<>"']+|https?:\/\/i\.(?:ibb\.co|imgur\.com)\/[^\s<>"']+/i);
        if (knownHost) {
            return knownHost[0];
        }

        // 3. Fallback: first real <img> src (exclude thumbnails / UI icons)
        const contentImg = $('img')
            .toArray()
            .map((el) => $(el).attr('src'))
            .filter((src) => src && /\.(?:jpe?g|png|gif|webp)(?:\?.*)?$/i.test(src) && !/logo|icon|avatar|thumbs?\/|emoji/i.test(src))
            .toSorted((a, b) => (b?.length ?? 0) - (a?.length ?? 0))[0];
        if (contentImg) {
            return contentImg.startsWith('//') ? `https:${contentImg}` : contentImg;
        }

        return null;
    } catch {
        try {
            await pageObj?.destroy();
        } catch {
            // ignore cleanup errors
        }
        return null;
    }
}

/**
 * Build a replacement map from original → resolved image URL for all resolvable
 * links found in `text`.
 *
 * imagetwist links use plain HTTP and are resolved in parallel. ouo.io links
 * need a browser session (connected via PLAYWRIGHT_WS_ENDPOINT / browserless
 * on the server) — those are resolved sequentially to avoid hitting
 * browserless's concurrent-session limits.
 */
async function resolveAllImageLinks(text: string): Promise<Map<string, string>> {
    const urls = extractImageLinks(text);
    if (urls.length === 0) {
        return new Map();
    }

    const map = new Map<string, string>();

    // imagetwist: plain HTTP, resolve in parallel
    const imagetwistUrls = urls.filter((u) => !isOuo(u));
    const results = await Promise.allSettled(imagetwistUrls.map(async (url) => ({ url, resolved: await resolveImagetwistUrl(url) })));
    for (const result of results) {
        if (result.status === 'fulfilled' && result.value.resolved) {
            map.set(result.value.url, result.value.resolved);
        }
    }

    // ouo.io: browser sessions are expensive — resolve sequentially, and cap
    // how many we attempt per description so a long list can't stall the item.
    // oxlint-disable no-await-in-loop — sequential browser sessions on purpose
    const ouoUrls = urls.filter((u) => isOuo(u)).slice(0, OUO_MAX_PER_ITEM);
    for (const url of ouoUrls) {
        const resolved = await resolveOuoUrl(url);
        if (resolved) {
            map.set(url, resolved);
        }
    }
    // oxlint-enable no-await-in-loop

    return map;
}

/**
 * Given raw markdown text and a map of original → resolved image URLs,
 * replace all references (BBCode, plain URLs) with
 * markdown image syntax `![](url)` so md.render produces actual <img> tags.
 */
function replaceImageLinksWithImg(text: string, resolved: Map<string, string>): string {
    if (resolved.size === 0) {
        return text;
    }

    const toMarkdownImg = (url: string): string | null => {
        const directUrl = resolved.get(url);
        return directUrl ? `![](${directUrl})` : null;
    };

    // 1. [url=...][img]...[/img][/url] → ![](resolved)
    let result = text.replace(BBCODE_URL_IMG_RE, (_match, capturedUrl) => toMarkdownImg(capturedUrl) ?? capturedUrl);

    // 2. [img]...[/img] → ![](resolved)
    result = result.replace(BBCODE_IMG_RE, (_match, capturedUrl) => toMarkdownImg(capturedUrl) ?? capturedUrl);

    // 3. Plain URLs → ![](resolved)
    result = result.replace(IMAGE_LINK_RE, (url) => toMarkdownImg(url) ?? url);

    return result;
}

/**
 * Fetch one torrent's detail page, extract magnet link, resolved description
 * and the file list, and cache the result keyed by the page link.
 */
const fetchDetail = (item: ListItem) =>
    cache.tryGet(item.link, async (): Promise<DataItem> => {
        // Light pacing; the 429-aware retry below is the real rate-limit guard.
        await delay(DETAIL_DELAY_MS);

        let detailResponse: string;
        try {
            detailResponse = await ofetch(item.link, { retry: 2, timeout: 10000 });
        } catch (error: unknown) {
            if (error && typeof error === 'object' && 'response' in error && (error as { response?: { status?: number } }).response?.status === 429) {
                await delay(3000);
                detailResponse = await ofetch(item.link, { retry: 1, timeout: 15000 });
            } else {
                throw error;
            }
        }

        const $ = load(detailResponse);

        // ── Magnet link ──
        const magnetLink = $('a[href^="magnet:"]').first().attr('href') || '';

        // ── Description ──
        let description = '';
        const descDiv = $('#torrent-description');
        if (descDiv.length > 0) {
            const rawContent = descDiv.text().trim();

            // Resolve imagetwist.com / ouo.io links to direct image URLs
            const resolved = await resolveAllImageLinks(rawContent);
            const withImgTags = replaceImageLinksWithImg(rawContent, resolved);

            description = md.render(withImgTags);
        }

        // ── File list ──
        const fileListDiv = $('.torrent-file-list');
        if (fileListDiv.length > 0) {
            description += '\n<h3>File List</h3>\n<ul>\n';

            const walkUl = (ul: Cheerio<any>) => {
                ul.children('li').each((_, li) => {
                    const $li = $(li);

                    // Folder: has a nested <ul>
                    const nestedUl = $li.children('ul');
                    if (nestedUl.length > 0) {
                        const folderName = $li.children('a.folder').text().trim();
                        if (folderName) {
                            description += `<li><strong>${folderName}/</strong>\n<ul>\n`;
                        }
                        walkUl(nestedUl);
                        if (folderName) {
                            description += '</ul>\n</li>\n';
                        }
                        return;
                    }

                    // File: extract name and size
                    const $clone = $li.clone();
                    $clone.find('i').remove();
                    $clone.find('span.file-size').remove();
                    const fileName = $clone.text().trim();
                    const fileSize = $li.find('span.file-size').text().trim();
                    description += `<li>${fileName}${fileSize ? ` <span class="file-size">${fileSize}</span>` : ''}</li>\n`;
                });
            };

            walkUl(fileListDiv.find('> ul'));
            description += '</ul>';
        }

        return {
            title: item.title,
            link: item.link,
            pubDate: item.pubDate,
            description,
            enclosure_url: magnetLink,
            enclosure_type: 'application/x-bittorrent',
        } as DataItem;
    });

export const route: Route = {
    path: '/:category?/:filter?',
    example: '/sukebei',
    name: 'Latest Torrents',
    maintainers: ['nobody'],
    parameters: {
        category: 'Category, e.g., 1_0 for Art, 1_3 for Games, 2_2 for Videos',
        filter: 'Filter: 0 (No filter), 1 (No remakes), 2 (Trusted only)',
    },
    features: {
        requireConfig: false,
        requirePuppeteer: true,
        antiCrawler: true,
        supportBT: true,
        supportPodcast: false,
        supportScihub: false,
        nsfw: true,
    },
    radar: [
        {
            source: ['sukebei.nyaa.si/'],
            target: '/sukebei',
        },
    ],
    handler,
};

async function handler(ctx) {
    const category = ctx.req.param('category');
    const filter = ctx.req.param('filter');
    const limit = ctx.req.query('limit') ? Number.parseInt(ctx.req.query('limit')) : 30;

    const rootUrl = 'https://sukebei.nyaa.si';
    const url = `${rootUrl}/?f=${filter || '0'}${category ? `&c=${category}` : ''}`;

    const response = await ofetch(url);
    const $ = load(response);

    // ── Parse listing ──────────────────────────────────────────
    const items: ListItem[] = $('tr.default')
        .slice(0, limit)
        .toArray()
        .map((element) => {
            const item = $(element);
            const link = item.find('td:nth-child(2) a').first().attr('href');

            if (!link) {
                return null;
            }

            return {
                title: item.find('td:nth-child(2)').text().trim(),
                link: link.startsWith('/') ? `${rootUrl}${link}` : link,
                pubDate: parseDate(item.find('td:nth-child(5)').text().trim()),
            };
        })
        .filter((item): item is ListItem => item !== null);

    // Bail early if nothing to fetch
    if (items.length === 0) {
        return {
            title: 'Sukebei - Latest Torrents',
            link: rootUrl,
            item: [],
        };
    }

    // ── Fetch detail for each item (bounded concurrency + 429-aware retry) ──
    const detailedItems: DataItem[] = await pMap(items, fetchDetail, { concurrency: DETAIL_CONCURRENCY });

    return {
        title: 'Sukebei - Latest Torrents',
        link: rootUrl,
        item: detailedItems,
    };
}
