import { Route } from '@/types';
import cache from '@/utils/cache';
import { parseDate } from '@/utils/parse-date';
import ofetch from '@/utils/ofetch';

export const route: Route = {
    path: '/index',
    categories: ['multimedia'],
    example: '/kaiyan/index',
    parameters: {
        speed: { description: 'Video playback speed (optional, default: 1)', default: '1' },
    },
    features: {
        requireConfig: false,
        requirePuppeteer: false,
        antiCrawler: false,
        supportBT: false,
        supportPodcast: false,
        supportScihub: false,
    },
    name: 'Kaiyan Daily Selection',
    maintainers: ['xyqfer'],
    handler,
    description: '开眼每日精选',
};

async function handler(ctx) {
    let speed = ctx.req.query('speed') ? Number.parseFloat(ctx.req.query('speed')) : 1;
    // Validate speed parameter
    if (Number.isNaN(speed) || speed < 0.25 || speed > 4) {
        speed = 1;
    }

    const API_URL = 'https://baobab.kaiyanapp.com/api/v5/index/tab/allRec';
    const response = await ofetch(API_URL);
    const list = response.itemList[0].data.itemList;

    const items = await Promise.all(
        list
            .filter((item) => item.type === 'followCard')
            .map(async (item) => {
                const content = item.data.content;
                const videoUrl = content.data.playUrl;

                return await cache.tryGet(videoUrl, () => {
                    const title = content.data.title;
                    const date = item.data.header.time;
                    const imgUrl = `<img src="${content.data.cover.feed}" />`;
                    const itemUrl = `<video src="${videoUrl}" controls="controls" playbackRate="${speed}" defaultPlaybackRate="${speed}" onloadeddata="this.playbackRate=${speed}"></video>`;
                    const author = content.data.author?.name ?? '开眼每日精选';
                    const description = content.data.description + '<br/>' + imgUrl + '<br/>' + itemUrl;

                    return {
                        title,
                        link: videoUrl,
                        author,
                        description,
                        pubDate: parseDate(date).toUTCString(),
                    };
                });
            })
    );

    return {
        title: '开眼精选',
        link: 'https://www.kaiyanapp.com/',
        description: '开眼每日精选',
        item: items,
    };
}
