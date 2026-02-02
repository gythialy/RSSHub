import type { Route } from '@/types';
import cache from '@/utils/cache';
import logger from '@/utils/logger';
import ofetch from '@/utils/ofetch';
import { parseDate } from '@/utils/parse-date';

export const route: Route = {
    path: '/',
    radar: [
        {
            source: ['cbnweek.com/'],
            target: '',
        },
    ],
    name: 'Unknown',
    maintainers: ['nczitzk'],
    handler,
    url: 'cbnweek.com/',
};

async function handler() {
    const rootUrl = 'https://www2021.cbnweek.com';
    const apiRootUrl = 'https://api2021.cbnweek.com';
    const currentUrl = `${apiRootUrl}/v4/first_page_infos?per=1`;

    const response = await ofetch(currentUrl, {
        headers: {
            Referer: rootUrl,
        },
    });

    let items = response.data.map((item) => {
        const post = item.data[0];
        return {
            guid: post.id,
            title: post.title,
            link: `${rootUrl}/article_detail/${post.id}`,
            pubDate: parseDate(post.display_time),
            author: post.authors?.map((a) => a.name).join(', '),
            category: post.topics?.map((t) => t.name),
        };
    });

    items = await Promise.all(
        items.map((item) =>
            cache.tryGet(item.link, async () => {
                try {
                    const detailResponse = await ofetch(`${apiRootUrl}/v4/articles/${item.guid}`, {
                        headers: {
                            Referer: rootUrl,
                        },
                    });
                    item.description = detailResponse.data.content;
                } catch (error) {
                    logger.warn(`Failed to fetch article ${item.guid}: ${error.message}`);
                    // Fallback to a simpler description if API call fails
                    item.description = `无法获取文章内容: ${item.title}`;
                }

                return item;
            })
        )
    );

    return {
        title: '第一财经杂志',
        link: rootUrl,
        item: items,
    };
}
