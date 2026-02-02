import { load } from 'cheerio';
import MarkdownIt from 'markdown-it';

import type { DataItem, Route } from '@/types';
import cache from '@/utils/cache';
import ofetch from '@/utils/ofetch';
import { parseDate } from '@/utils/parse-date';

const md = new MarkdownIt();

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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
        requirePuppeteer: false,
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
    let url = `${rootUrl}/?f=${filter || '0'}`;
    if (category) {
        url = `${url}&c=${category}`;
    }

    const response = await ofetch(url);

    const $ = load(response);

    const items = $('tr.default')
        .slice(0, limit)
        .toArray()
        .map((element) => {
            const item = $(element);
            const link = item.find('td:nth-child(2) a').first().attr('href');

            if (!link) {
                return null;
            }

            const fullLink = link.startsWith('/') ? `${rootUrl}${link}` : link;
            const title = item.find('td:nth-child(2)').text().trim();
            const dateText = item.find('td:nth-child(5)').text().trim();

            return {
                title,
                link: fullLink,
                pubDate: parseDate(dateText),
            };
        })
        .filter((item): item is NonNullable<typeof item> => item !== undefined);

    const processItem = async (item: (typeof items)[0]): Promise<DataItem> => {
        try {
            return await cache.tryGet(item.link, async () => {
                await delay(500);

                let detailResponse;
                try {
                    detailResponse = await ofetch(item.link, {
                        retry: 2,
                        timeout: 10000,
                    });
                } catch (error) {
                    if (error && typeof error === 'object' && 'response' in error && (error as any).response?.status === 429) {
                        await delay(2000);
                        detailResponse = await ofetch(item.link, {
                            retry: 1,
                            timeout: 15000,
                        });
                    } else {
                        throw error;
                    }
                }

                const $ = load(detailResponse);

                const magnetLink = $('a[href^="magnet:"]').first().attr('href') || '';

                const descriptionDiv = $('#torrent-description');
                let description = '';

                if (descriptionDiv.length > 0) {
                    const rawContent = descriptionDiv.text().trim();
                    description = md.render(rawContent);
                }

                let fileListText = '';
                const fileListDiv = $('.torrent-file-list');
                if (fileListDiv.length > 0) {
                    fileListText += '<h3>File List</h3><pre>';
                    fileListDiv.find('li').each(function () {
                        const fileName = $(this)
                            .contents()
                            .filter(function () {
                                return this.nodeType === 3;
                            })
                            .text()
                            .trim();
                        const fileSize = $(this).find('.file-size').text().trim();
                        fileListText += `${fileName} ${fileSize}\n`;
                    });
                    fileListText += '</pre>';
                }

                const combinedDescription = description + fileListText;

                return {
                    title: item.title,
                    link: item.link,
                    pubDate: item.pubDate,
                    description: combinedDescription,
                    enclosure_url: magnetLink,
                    enclosure_type: 'application/x-bittorrent',
                } as DataItem;
            });
        } catch {
            return {
                title: item.title,
                link: item.link,
                pubDate: item.pubDate,
                description: 'Details could not be retrieved due to rate limiting.',
            };
        }
    };

    const processItemsSequentially = async (itemList: typeof items, index = 0, acc: DataItem[] = []): Promise<DataItem[]> => {
        if (index >= itemList.length) {
            return acc;
        }
        const item = await processItem(itemList[index]);
        return processItemsSequentially(itemList, index + 1, [...acc, item]);
    };

    const detailedItems = await processItemsSequentially(items);

    return {
        title: 'Sukebei - Latest Torrents',
        link: rootUrl,
        item: detailedItems,
    };
}
