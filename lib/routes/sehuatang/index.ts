import { load } from 'cheerio';

import type { DataItem, Route } from '@/types';
import cache from '@/utils/cache';
import logger from '@/utils/logger';
import { parseDate } from '@/utils/parse-date';
import { getPlaywrightPage } from '@/utils/playwright';
import timezone from '@/utils/timezone';

const host = 'https://www.sehuatang.net/';

const forumIdMaps = {
    // 原创 BT 电影
    gcyc: '2', //     国产原创
    yzwmyc: '36', //  亚洲无码原创
    yzymyc: '37', //  亚洲有码原创
    gqzwzm: '103', // 高清中文字幕
    sjxz: '107', //   三级写真
    vr: '160', //     VR 视频
    srym: '104', //   素人有码
    omwm: '38', //    欧美无码
    '4k': '151', //   4K 原版
    hgzb: '152', //   韩国主播
    dmyc: '39', //    动漫原创
    // 色花图片
    yczp: '155', //   原创自拍
    ztzp: '125', //   转贴自拍
    hrjp: '50', //    华人街拍
    yzxa: '48', //    亚洲性爱
    omxa: '49', //    欧美性爱
    ktdm: '117', //   卡通动漫
    ttxz: '165', //   套图下载

    zhtl: '95', //    综合讨论
    // no longer updated/available
    mrhj: '106', //   每日合集
    ai: '113', //     AI 换脸电影
    ydsc: '111', //   原档收藏 WMV
    hrxazp: '98', //  华人性爱自拍
};

export const route: Route = {
    path: ['/bt/:subforumid?', '/picture/:subforumid', '/:subforumid?/:type?', '/:subforumid?', ''],
    categories: ['multimedia'],
    example: '/sehuatang/36/368',
    parameters: {
        subforumid: '版块 id 或板块名称（见下表）, 为空默认高清中文字幕',
        type: '类型 id, 可在分区类型过滤后的 URL 中找到',
    },
    name: 'Forum',
    maintainers: ['qiwihui', 'junfengP', 'nczitzk'],
    handler,
    features: {
        nsfw: true,
    },
    description: `**原创 BT 电影**

| 国产原创 | 亚洲无码原创 | 亚洲有码原创 | 高清中文字幕 | 三级写真 | VR 视频 | 素人有码 | 欧美无码 | 韩国主播 | 动漫原创 | 综合讨论 |
| -------- | ------------ | ------------ | ------------ | -------- | ------- | -------- | -------- | -------- | -------- | -------- |
| gcyc     | yzwmyc       | yzymyc       | gqzwzm       | sjxz     | vr      | srym     | omwm     | hgzb     | dmyc     | zhtl     |

**色花图片**

| 原创自拍 | 转贴自拍 | 华人街拍 | 亚洲性爱 | 欧美性爱 | 卡通动漫 | 套图下载 |
| -------- | -------- | -------- | -------- | -------- | -------- | -------- |
| yczp     | ztzp     | hrjp     | yzxa     | omxa     | ktdm     | ttxz     |`,
};

// 10 minutes is the safety-net close timer; `destroy()` closes the browser right after all pages are fetched
const browserCloseTimeout = 10 * 60 * 1000;

async function handler(ctx) {
    const subformName = ctx.req.param('subforumid') ?? 'gqzwzm';
    const subformId = Object.hasOwn(forumIdMaps, subformName) ? forumIdMaps[subformName] : subformName;
    const type = ctx.req.param('type');
    const typefilter = type ? `&filter=typeid&typeid=${type}` : '';
    const link = `${host}forum.php?mod=forumdisplay&orderby=dateline&fid=${subformId}${typefilter}`;

    // The site is behind a Cloudflare challenge and requires a `_safe` cookie (generated on the homepage)
    // to render the thread list, so plain HTTP requests are rejected with 403. Fetch pages with playwright instead.
    const { context, destroy, page } = await getPlaywrightPage(host, {
        closeTimeout: browserCloseTimeout,
        onBeforeLoad: async (page) => {
            await page.route('**/*', (route) => {
                const request = route.request();
                request.resourceType() === 'document' ? route.continue() : route.abort();
            });
        },
    });

    try {
        // Wait for the Cloudflare challenge to resolve, then extract `safeid` from the homepage
        try {
            await page.waitForFunction(() => document.body.getHTML().includes('safeid'), null, { timeout: 30000 });
        } catch {
            logger.warn(`Timed out waiting for the Cloudflare challenge to resolve on ${host}`);
        }

        const homepageHtml = await page.content();
        const safeId = load(homepageHtml)('script:contains("safeid")')
            .text()
            .match(/safeid\s*=\s*'(.+)';/)?.[1];
        if (safeId) {
            await context.addCookies([{ name: '_safe', value: safeId, domain: 'www.sehuatang.net', path: '/' }]);
        } else {
            logger.warn(`Failed to extract safeid from ${host}, the thread list may be empty`);
        }

        await page.goto(link, { waitUntil: 'domcontentloaded' });
        try {
            await page.waitForSelector('#threadlisttableid', { timeout: 30000 });
        } catch {
            logger.warn(`Timed out waiting for the thread list on ${link}`);
        }
        const forumHtml = await page.content();
        const $ = load(forumHtml);

        const list = $('#threadlisttableid tbody[id^=normalthread]')
            .slice(0, ctx.req.query('limit') ? Number.parseInt(ctx.req.query('limit')) : 25)
            .toArray()
            .map((item): DataItem => {
                const $item = $(item);
                const hasCategory = $item.find('th em a').length;
                return {
                    title: `${hasCategory ? `[${$item.find('th em a').text()}]` : ''} ${$item.find('a.xst').text()}`,
                    link: host + $item.find('a.xst').attr('href'),
                    pubDate: parseDate($item.find('td.by').find('em span span').attr('title') ?? ''),
                    author: $item.find('td.by cite a').first().text(),
                };
            })
            .filter((item): item is DataItem & { link: string } => item.link !== undefined);

        const out = await Promise.all(
            list.map((info) =>
                cache.tryGet(info.link, async () => {
                    const detailPage = await context.newPage();
                    try {
                        await detailPage.goto(info.link, { waitUntil: 'domcontentloaded' });

                        const detailHtml = await detailPage.content();
                        const $ = load(detailHtml);
                        const postMessage = $('div[id^="postmessage"], td[id^="postmessage"]').slice(0, 1);
                        const images = $(postMessage).find('img');
                        for (const image of images) {
                            const file = $(image).attr('file');
                            if (!file || file === 'undefined') {
                                $(image).replaceWith('');
                            } else {
                                $(image).replaceWith($(`<img src="${file}">`));
                            }
                        }
                        // also parse image url from `.pattl`
                        const pattl = $('.pattl');
                        const pattlImages = $(pattl).find('img');
                        for (const pattlImage of pattlImages) {
                            const file = $(pattlImage).attr('file');
                            if (!file || file === 'undefined') {
                                $(pattlImage).replaceWith('');
                            } else {
                                $(pattlImage).replaceWith($(`<img src="${file}" />`));
                            }
                        }
                        postMessage.append($(pattl));
                        $('em[onclick]').remove();

                        info.description = (postMessage.html() || '抓取原帖失败').replaceAll('ignore_js_op', 'div');
                        info.pubDate = timezone(parseDate($('.authi em span').attr('title') ?? ''), 8);

                        const magnet = postMessage.find('div.blockcode li').first().text();
                        const isMag = magnet.startsWith('magnet');
                        const torrent = postMessage.find('p.attnm a').attr('href');

                        if (isMag) {
                            info.enclosure_url = magnet;
                            info.enclosure_type = 'application/x-bittorrent';
                        } else if (torrent) {
                            info.enclosure_url = new URL(torrent, host).href;
                            info.enclosure_type = 'application/octet-stream';
                        }

                        return info;
                    } finally {
                        await detailPage.close();
                    }
                })
            )
        );

        return {
            title: `色花堂 - ${$('#pt > div:nth-child(1) > a:last-child').text()}`,
            link,
            item: out,
        };
    } finally {
        await destroy();
    }
}
