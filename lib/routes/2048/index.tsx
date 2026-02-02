import { load } from 'cheerio';
import pMap from 'p-map';

import { config } from '@/config';
import type { DataItem, Route } from '@/types';
import cache from '@/utils/cache';
import ofetch from '@/utils/ofetch';
import { parseDate } from '@/utils/parse-date';
import { getPlaywrightPage } from '@/utils/playwright';
import { getRouteLimit } from '@/utils/route-limit';
import timezone from '@/utils/timezone';

const rootUrl = 'https://hjd2048.com/2048/';
const host = 'https://hjd2048.com';

// The site normally serves plain HTTP, but it periodically puts a JS challenge
// in front (`/_guard/auto.js`): that stub page only loads the challenge script
// and sets a guard cookie, and the real pages come back once the challenge has
// run in a browser. So plain HTTP is always tried first and a browser is only
// started when a challenge is actually detected; the cookies it earns are
// cached so the browser is not launched on every request.
const GUARD_COOKIE_CACHE_KEY = '2048:guard-cookie';
// Guard cookies live for hours; refresh well before they can go stale.
const GUARD_COOKIE_TTL_S = 6 * 60 * 60;

const hasGuardChallenge = (html: string) => html.includes('/_guard/auto.js');

/**
 * Resolve the anti-crawler cookies by loading the site in a real browser and
 * letting `/_guard/auto.js` run its challenge. Every cookie the browser holds
 * for the host is kept because the challenge cookie has been renamed before
 * (it was `guardok` when the challenge was first observed).
 */
async function resolveGuardCookies(): Promise<string> {
    const { context, destroy, page } = await getPlaywrightPage(rootUrl, {
        closeTimeout: 60000,
        gotoConfig: { waitUntil: 'domcontentloaded', timeout: 45000 },
    });

    try {
        // The challenge script clears itself once solved and reloads the page;
        // a page that never carried it satisfies this immediately.
        await page.waitForFunction(() => !document.documentElement.innerHTML.includes('/_guard/auto.js'), null, { timeout: 45000 });

        const cookies = await context.cookies(host);
        return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
    } finally {
        await destroy();
    }
}

/**
 * Resolve fresh guard cookies through the browser and refresh the cache. Used
 * on cache miss and when cached cookies get rejected, so a poisoned cache
 * entry can never outlive the request that detected it.
 */
const resolveAndCacheGuardCookies = async (): Promise<string> => {
    const cookie = await resolveGuardCookies();
    if (cookie) {
        cache.set(GUARD_COOKIE_CACHE_KEY, cookie, GUARD_COOKIE_TTL_S);
    }
    return cookie;
};

const getGuardCookies = async (): Promise<string> => {
    const cached = await cache.get(GUARD_COOKIE_CACHE_KEY);
    return cached || (await resolveAndCacheGuardCookies());
};

/**
 * Escape a value for HTML text/attribute use: magnet URIs use `&` as their
 * parameter separator, so it has to be entity-encoded to stay valid HTML.
 */
const escapeHtml = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

/**
 * Fetch an hjd2048 page over plain HTTP. The site is normally reachable that
 * way; only when it puts its JS challenge back in front do we start a browser
 * once to resolve the guard cookies and retry with them.
 */
async function fetchWithGuard(path: string): Promise<string> {
    const url = `${rootUrl}${path.replace(/^\//, '')}`;

    // Fast path: no challenge in front, so no browser is needed at all.
    const plain = await ofetch(url, {
        headers: {
            'user-agent': config.ua,
        },
        responseType: 'text' as const,
    });
    if (!hasGuardChallenge(plain)) {
        return plain;
    }

    // Slow path: the challenge is back — attach the guard cookies and retry.
    let cookie = await getGuardCookies();

    for (let attempt = 0; attempt < 2; attempt++) {
        // oxlint-disable no-await-in-loop — sequential challenge-retry on purpose
        const html = await ofetch(url, {
            headers: {
                cookie,
                'user-agent': config.ua,
            },
            responseType: 'text' as const,
        });
        if (!hasGuardChallenge(html)) {
            return html;
        }
        if (attempt === 1) {
            break;
        }
        // Cookies rejected — bypass the cache and force a fresh browser run.
        cookie = await resolveAndCacheGuardCookies();
        // oxlint-enable no-await-in-loop
    }

    throw new Error(`hjd2048: still blocked by the JS challenge: ${path}`);
}

export const route: Route = {
    path: '/:id?',
    categories: ['multimedia'],
    example: '/2048/2',
    parameters: { id: '板块 ID, 见下表，默认为最新合集，即 `3`，亦可在 URL 中找到, 例如, `thread.php?fid-3.html`中, 板块 ID 为`3`' },
    features: {
        requireConfig: [
            {
                name: 'CHROMIUM_EXECUTABLE_PATH',
                optional: true,
                description: 'Path to a Chromium executable, only needed if the site puts its JS challenge back in front of the pages; alternatively set PLAYWRIGHT_WS_ENDPOINT or PLAYWRIGHT_CDP_ENDPOINT',
            },
        ],
        requirePuppeteer: false,
        antiCrawler: true,
        supportBT: true,
        supportPodcast: false,
        supportScihub: false,
        nsfw: true,
    },
    name: '论坛',
    maintainers: ['nczitzk'],
    handler,
    description: `| 最新合集 | 亞洲無碼 | 日本騎兵 | 歐美新片 | 國內原創 | 中字原創 | 三級寫真 |
| -------- | -------- | -------- | -------- | -------- | -------- | -------- |
| 3        | 4        | 5        | 13       | 15       | 16       | 18       |

| 有碼.HD | 亞洲 SM.HD | 日韓 VR/3D | 歐美 VR/3D | S-cute / Mywife / G-area |
| ------- | ---------- | ---------- | ---------- | ------------------------ |
| 116     | 114        | 96         | 97         | 119                      |

| 網友自拍 | 亞洲激情 | 歐美激情 | 露出偷窺 | 高跟絲襪 | 卡通漫畫 | 原創达人 |
| -------- | -------- | -------- | -------- | -------- | -------- | -------- |
| 23       | 24       | 25       | 26       | 27       | 28       | 135      |

| 唯美清純 | 网络正妹 | 亞洲正妹 | 素人正妹 | COSPLAY | 女优情报 | Gif 动图 |
| -------- | -------- | -------- | -------- | ------- | -------- | -------- |
| 21       | 274      | 276      | 277      | 278     | 29       |          |

| 獨家拍攝 | 稀有首發 | 网络见闻 | 主播實錄 | 珍稀套圖 | 名站同步 | 实用漫画 |
| -------- | -------- | -------- | -------- | -------- | -------- | -------- |
| 213      | 94       | 283      | 111      | 88       | 131      | 180      |

| 网盘二区 | 网盘三区 | 分享福利 | 国产精选 | 高清福利 | 高清首发 | 多挂原创 |
| -------- | -------- | -------- | -------- | -------- | -------- | -------- |
| 72       | 272      | 195      | 280      | 79       | 216      | 76       |

| 磁链迅雷 | 正片大片 | H-GAME | 有声小说 | 在线视频 | 在线快播影院 |
| -------- | -------- | ------ | -------- | -------- | ------------ |
| 43       | 67       | 66     | 55       | 78       | 279          |

| 综合小说 | 人妻意淫 | 乱伦迷情 | 长篇连载 | 文学作者 | TXT 小说打包 |
| -------- | -------- | -------- | -------- | -------- | ------------ |
| 48       | 103      | 50       | 54       | 100      | 109          |

| 聚友客栈 | 坛友自售 |
| -------- | -------- |
| 57       | 136      |`,
};

type ListItem = {
    title: string;
    link: string;
    guid: string;
};

/**
 * Parse one thread detail page into description/magnet/pubDate.
 */
const parseDetail = async (item: ListItem): Promise<DataItem> => {
    const html = await fetchWithGuard(item.link.replace(rootUrl, ''));
    const content = load(html);

    content('.ads, .tips').remove();

    content('ignore_js_op').each((_, el) => {
        const img = content(el).find('img');
        const originalSrc = img.attr('data-original');
        const fallbackSrc = img.attr('src');
        // 判断是否有 data-original 属性，若有则使用其值，否则使用 src 属性值
        const imgSrc = originalSrc || fallbackSrc;
        if (imgSrc) {
            content(el).replaceWith(`<img src="${imgSrc}">`);
        }
    });

    const author = content('.fl.black').first().text();

    const result: DataItem = {
        ...item,
        author,
    };
    const pubDateStr = content('span.fl.gray').first().attr('title');
    if (pubDateStr) {
        result.pubDate = timezone(parseDate(pubDateStr), 8);
    }

    const readTpc = content('#read_tpc').first();
    const copyLink = content('#copytext')?.first()?.text();
    const readTpcHtml = readTpc.html() ?? '';
    const magnetText = readTpc.find('.magnet-text').first().text().trim();

    // Extract enclosure: rmdown.com (fetch page for magnet) | magnet from 哈希校验 | copyLink
    const rmdownLink = readTpc.find('a[href*="rmdown.com/link.php"]').first().attr('href');
    const enclosureHref = rmdownLink?.startsWith('http') ? rmdownLink : rmdownLink ? `https://www.rmdown.com/${rmdownLink}` : undefined;

    if (enclosureHref) {
        try {
            const rmdownPage = await cache.tryGet(`2048:rmdown:${enclosureHref}`, () => ofetch(enclosureHref));
            const btihMatch = rmdownPage.match(/Code:\s*([a-fA-F0-9]{40})/);
            const magnetUrl = btihMatch ? `magnet:?xt=urn:btih:${btihMatch[1]}` : undefined;
            if (magnetUrl) {
                result.enclosure_url = magnetUrl;
                result.enclosure_type = 'application/x-bittorrent';
                // The site does not expose the torrent size; RSS 2.0 requires
                // the length attribute, so fall back to 0 for an unknown size.
                result.enclosure_length = 0;
            }
        } catch {
            // rmdown is flaky — fall through to the other extraction methods
        }
    }
    if (!result.enclosure_url) {
        const hashMatch = readTpcHtml.match(/哈希校验[^;]*;\s*([a-f0-9]{40})\s*[;；]/i);
        const magnetFromHash = hashMatch ? `magnet:?xt=urn:btih:${hashMatch[1]}` : undefined;
        const magnetFromText = magnetText.match(/magnet:\?xt=urn:btih:[^\s"'<>]+/)?.[0];
        const magnetLink = magnetFromText ?? readTpcHtml.match(/magnet:\?xt=urn:btih:[^\s"'<>]+/)?.[0] ?? magnetFromHash ?? copyLink;
        if (magnetLink?.startsWith('magnet')) {
            result.enclosure_url = magnetLink;
            result.enclosure_type = 'application/x-bittorrent';
            result.enclosure_length = 0;
        }
    }

    // The site inlines its magnet-box stylesheet (and a copy script) once per
    // magnet, so the raw description would carry dozens of duplicated <style>
    // blocks. A <textarea> is also invisible in readers, so render each magnet
    // as a copyable link instead.
    readTpc.find('style, script').remove();
    readTpc.find('textarea.magnet-text').each((_, el) => {
        const magnet = content(el).text().trim();
        if (magnet) {
            const escaped = escapeHtml(magnet);
            content(el).replaceWith(`<p>Magnet: <a href="${escaped}">${escaped}</a></p>`);
        } else {
            content(el).remove();
        }
    });

    content('.showhide img').each((_, el) => {
        readTpc.append(`<br><img style="max-width: 100%;" src="${content(el).attr('src')}">`);
    });

    result.description = readTpc.html() ?? undefined;

    return result;
};

async function handler(ctx) {
    const id = ctx.req.param('id') ?? '3';

    const currentUrl = `${rootUrl}thread.php?fid-${id}.html`;

    const response = await fetchWithGuard(`thread.php?fid-${id}.html`);
    const $ = load(response);

    $('#shortcut').remove();

    // Thread rows are `tr.tr3` rows whose subject link points at
    // `read.php?tid=<digits>`; requiring that pattern keeps out ad/promo rows
    // (which previously leaked garbage URLs like `https://fby.jinmings.com/<a class="link"...>`).
    const tidPattern = /^read\.php\?tid=\d+/;
    const seen = new Set<string>();
    const list: ListItem[] = $('tr.tr3')
        .toArray()
        // Pinned announcements carry the `置顶帖标志` image; they are not part
        // of the board's latest threads, so keep them out of the feed.
        .filter((row) => $(row).find('img[src*="headtopic"]').length === 0)
        .flatMap((row) => $(row).find('a.subject').toArray())
        .map((subjectEl) => {
            const href = $(subjectEl).attr('href') ?? '';
            if (!tidPattern.test(href)) {
                return null;
            }
            const link = `${host}/2048/${href}`;
            if (seen.has(link)) {
                return null;
            }
            seen.add(link);
            return {
                title: $(subjectEl).text().trim(),
                link,
                guid: link,
            };
        })
        .filter((item): item is ListItem => item !== null)
        .slice(0, getRouteLimit(ctx, 30));

    // Bounded concurrency: gentle on the source site, fast enough to avoid timeouts.
    const items = await pMap(list, parseDetail, { concurrency: 3 });

    return {
        title: `${$('#main #breadCrumb a').last().text()} - 2048核基地`,
        link: currentUrl,
        item: items,
    };
}
