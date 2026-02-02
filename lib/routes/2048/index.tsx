import { load } from 'cheerio';
import pMap from 'p-map';

import { config } from '@/config';
import type { DataItem, Route } from '@/types';
import cache from '@/utils/cache';
import ofetch from '@/utils/ofetch';
import { parseDate } from '@/utils/parse-date';
import { getPlaywrightPage } from '@/utils/playwright';
import timezone from '@/utils/timezone';

const rootUrl = 'https://hjd2048.com/2048/';
const host = 'https://hjd2048.com';

// The site sits behind a JS challenge (`/_guard/auto.js`): the first plain HTTP
// response is a ~40-byte stub page that only loads the challenge script and
// sets a `guard` cookie. Running the challenge in a real browser yields a
// `guardok` cookie; afterwards every page is served normally over plain HTTP.
// So we bootstrap cookies with Playwright once, then fetch list + details
// without a browser. Cookies are cached process-wide (and via `cache`) to
// avoid launching a browser on every request.
const GUARD_COOKIE_CACHE_KEY = '2048:guard-cookie';
// The guardok cookie lives for hours; refresh well before it can go stale.
const GUARD_COOKIE_TTL_S = 6 * 60 * 60;

const hasGuardChallenge = (html: string) => html.includes('/_guard/auto.js');

/**
 * Resolve the `guardok` anti-crawler cookie by loading the site in a real
 * browser and letting `/_guard/auto.js` run its challenge + reload.
 */
async function resolveGuardCookie(): Promise<string> {
    const { context, destroy, page } = await getPlaywrightPage(rootUrl, {
        closeTimeout: 60000,
        gotoConfig: { waitUntil: 'domcontentloaded', timeout: 45000 },
    });

    try {
        // Wait until the challenge script has done its job: either the page no
        // longer references /_guard/auto.js or thread links appeared.
        await page.waitForFunction(() => !document.body.getHTML().includes('/_guard/auto.js') && /read\.php\?tid=\d+/.test(document.body.getHTML()), null, { timeout: 45000 });

        const cookies = await context.cookies(host);
        const guardCookie = cookies.find((cookie) => cookie.name === 'guardok');
        if (!guardCookie) {
            throw new Error('Failed to obtain guardok cookie after resolving the JS challenge');
        }
        return `${guardCookie.name}=${guardCookie.value}`;
    } finally {
        await destroy();
    }
}

const getGuardCookie = async (): Promise<string> => {
    const cached = await cache.get(GUARD_COOKIE_CACHE_KEY);
    if (cached && !hasGuardChallenge(cached) && /^guardok=.+/.test(cached)) {
        return cached;
    }
    return refreshGuardCookie();
};

/**
 * Force-resolve a fresh guard cookie through the browser and overwrite the
 * cached value. Used both on cache miss and when a cached cookie gets
 * rejected by the site, so a poisoned cache entry can never outlive the
 * request that detected it.
 */
const refreshGuardCookie = async (): Promise<string> => {
    const cookie = await resolveGuardCookie();
    // Overwrite (there is no cache.del); short TTL so stale cookies age out.
    cache.set(GUARD_COOKIE_CACHE_KEY, cookie, GUARD_COOKIE_TTL_S);
    return cookie;
};

/**
 * Fetch an hjd2048 page over plain HTTP, attaching the guardok cookie.
 * The guard cookie is validated against the User-Agent that earned it in the
 * browser (config.ua — the same UA `getPlaywrightPage` uses), so it must be
 * sent here as well. If the response is another challenge stub (cookie
 * expired/rotated), force-resolve a fresh cookie through the browser and
 * retry once.
 */
async function fetchWithGuard(path: string): Promise<string> {
    let cookie = await getGuardCookie();

    for (let attempt = 0; attempt < 2; attempt++) {
        // oxlint-disable no-await-in-loop — sequential challenge-retry on purpose
        const html = await ofetch(`${rootUrl}${path.replace(/^\//, '')}`, {
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
            throw new Error(`hjd2048: still blocked by the JS challenge after refreshing cookies: ${path}`);
        }
        // Cookie rejected — bypass any cached value and force-resolve a fresh one.
        cookie = await refreshGuardCookie();
        // oxlint-enable no-await-in-loop
    }

    throw new Error(`hjd2048: failed to bypass the JS challenge: ${path}`);
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
                description: 'Path to a Chromium executable, used by Playwright to resolve the JS challenge; alternatively set PLAYWRIGHT_WS_ENDPOINT or PLAYWRIGHT_CDP_ENDPOINT',
            },
        ],
        requirePuppeteer: true,
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
                result.enclosure_type = 'x-scheme-handler/magnet';
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
            result.enclosure_type = 'x-scheme-handler/magnet';
        }
    }

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
        .slice(0, ctx.req.query('limit') ? Number.parseInt(ctx.req.query('limit')) : 30);

    // Bounded concurrency: gentle on the source site, fast enough to avoid timeouts.
    const items = await pMap(list, parseDetail, { concurrency: 3 });

    return {
        title: `${$('#main #breadCrumb a').last().text()} - 2048核基地`,
        link: currentUrl,
        item: items,
    };
}
