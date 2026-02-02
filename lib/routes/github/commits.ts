import { load } from 'cheerio';
import { escapeAttribute, escapeText } from 'entities';
import pMap from 'p-map';
import Parser from 'rss-parser';

import type { DataItem, Route } from '@/types';
import cache from '@/utils/cache';
import ofetch from '@/utils/ofetch';
import { parseDate } from '@/utils/parse-date';
import { getRouteLimit } from '@/utils/route-limit';

const rootUrl = 'https://github.com';
const parser = new Parser();

// Subjects GitHub generates for merge commits. Their patch is identical to the patch of the commits they merge,
// so excluding them only removes duplicates.
const mergeCommitPattern = /^Merge (?:pull request #\d+|branch |remote-tracking branch |tag )/;

// Keep a single feed item readable: cap the rendered diff and link to the full patch for the rest.
const maxFileDiffLines = 200;
const maxItemDiffLines = 400;
const maxPatchLength = 512 * 1024;
const maxCategories = 10;

const diffStyle = {
    added: 'color:#1a7f37',
    removed: 'color:#cf222e',
    hunk: 'color:#57606a',
};
const preStyle = 'white-space:pre-wrap;word-break:break-word;font-size:12px;line-height:1.45;margin:0 0 12px';

type Commit = {
    sha: string;
    link: string;
    message: string;
    author?: string;
    pubDate?: Date;
    isMerge: boolean;
};

type ChangedFile = {
    path: string;
    additions: number;
    deletions: number;
    lines: string[];
};

type CommitDetail = {
    author?: string;
    files: ChangedFile[];
};

export const route: Route = {
    path: '/commits/:user/:repo/:branch{.+}?',
    categories: ['programming'],
    example: '/github/commits/gaboolic/rime-frost/master',
    parameters: {
        user: 'User name',
        repo: 'Repo name',
        branch: 'Branch name, defaults to the default branch of the repository',
    },
    description: `Commit list with the diff of every commit rendered inside the feed item.

The commit list is read from the official \`https://github.com/:user/:repo/commits/:branch.atom\` feed (no GitHub API token needed), and each commit's patch is fetched from \`https://github.com/:user/:repo/commit/:sha.patch\`.

Merge commits are **included** by default. A merge commit's patch is identical to the patch of the commits it merged, so dropping them only removes duplicates.

To drop them, use the built-in filter, which runs after the feed cache and is therefore always correct: \`?filterout_category=^merge$\` — every merge commit carries the \`merge\` category. \`?exclude_merge=true\` (\`1\`, \`yes\` or the bare parameter) does the same inside the route, but RSSHub keys its feed cache by path only, so avoid mixing it with the same path requested without it within \`CACHE_EXPIRE\` (default 300s).

Long diffs are truncated per file and per item, and the item links to the full patch on GitHub.`,
    features: {
        requireConfig: false,
        requirePuppeteer: false,
        antiCrawler: false,
        supportBT: false,
        supportPodcast: false,
        supportScihub: false,
    },
    radar: [
        {
            source: ['github.com/:user/:repo/commits/:branch'],
            target: '/commits/:user/:repo/:branch',
        },
    ],
    name: 'Repo Commits (Diff)',
    maintainers: ['gythialy'],
    handler,
};

async function handler(ctx) {
    const { user, repo } = ctx.req.param();
    const branch = ctx.req.param('branch');
    const limit = getRouteLimit(ctx, 20);
    const excludeMergeQuery = ctx.req.query('exclude_merge');
    const excludeMerge = excludeMergeQuery !== undefined && !['0', 'false', 'no', 'off'].includes(excludeMergeQuery.toLowerCase());

    const { commits, resolvedBranch } = await fetchCommits(user, repo, branch);
    const selected = (excludeMerge ? commits.filter((commit) => !commit.isMerge) : commits).slice(0, limit);
    const item = await pMap(selected, buildItem, { concurrency: 3 });

    return {
        title: `${user}/${repo} commits on ${resolvedBranch}`,
        link: `${rootUrl}/${user}/${repo}/commits/${encodeBranch(resolvedBranch)}`,
        item,
    };
}

const encodeBranch = (branch: string) =>
    branch
        .split('/')
        .map((segment) => encodeURIComponent(segment))
        .join('/');

async function fetchCommits(user: string, repo: string, branch?: string) {
    const listUrl = branch ? `${rootUrl}/${user}/${repo}/commits/${encodeBranch(branch)}.atom` : `${rootUrl}/${user}/${repo}/commits.atom`;
    const feed = await parser.parseString(await ofetch<string, 'text'>(listUrl, { responseType: 'text' }));
    const resolvedBranch = branch || feed.link?.match(/\/commits\/(.+)$/)?.[1] || feed.title?.match(/:([^:]+)$/)?.[1] || 'HEAD';

    const commits: Commit[] = feed.items.map((entry) => {
        const message = commitMessage(entry);

        return {
            sha: entry.link?.split('/').at(-1) ?? '',
            link: entry.link ?? '',
            message,
            author: entry.author || undefined,
            pubDate: entry.isoDate ? parseDate(entry.isoDate) : undefined,
            isMerge: mergeCommitPattern.test(message.split('\n', 1)[0]),
        };
    });

    return { commits, resolvedBranch };
}

function commitMessage(entry: Parser.Item) {
    const content = entry.content || entry.summary || '';
    const text = content.includes('<') ? load(content).text() : content;

    return (text || entry.title || '').trim();
}

async function buildItem(commit: Commit): Promise<DataItem> {
    const detail = await cache.tryGet<CommitDetail>(`github:commit:${commit.sha}`, () => fetchCommitDetail(commit.link));
    const [, ...bodyLines] = commit.message.split('\n');
    const body = bodyLines.join('\n').trim();
    const additions = detail.files.reduce((sum, file) => sum + file.additions, 0);
    const deletions = detail.files.reduce((sum, file) => sum + file.deletions, 0);
    const totalLines = detail.files.reduce((sum, file) => sum + file.lines.length, 0);
    const description: string[] = [];

    if (body) {
        description.push(`<pre style="${preStyle}">${escapeText(body)}</pre>`);
    }

    description.push(
        `<p><a href="${escapeAttribute(commit.link)}">${detail.files.length} file${detail.files.length === 1 ? '' : 's'} changed</a>, <span style="${diffStyle.added}">+${additions}</span> <span style="${diffStyle.removed}">-${deletions}</span></p>`
    );

    let renderedLines = 0;
    for (const file of detail.files) {
        if (renderedLines >= maxItemDiffLines) {
            break;
        }

        description.push(`<p><strong>${escapeText(file.path)}</strong> <span style="${diffStyle.added}">+${file.additions}</span> <span style="${diffStyle.removed}">-${file.deletions}</span></p>`);

        if (file.lines.length === 0) {
            description.push('<p><em>No textual diff (binary or empty file)</em></p>');
            continue;
        }

        const lineBudget = Math.min(maxFileDiffLines, maxItemDiffLines - renderedLines, file.lines.length);
        description.push(
            `<pre style="${preStyle}">${file.lines
                .slice(0, lineBudget)
                .map((line) => renderDiffLine(line))
                .join('\n')}</pre>`
        );
        renderedLines += lineBudget;
    }

    if (renderedLines < totalLines) {
        description.push(`<p><em>Diff truncated (${renderedLines}/${totalLines} lines), <a href="${escapeAttribute(`${commit.link}.diff`)}">view the full diff on GitHub</a></em></p>`);
    }

    return {
        title: commit.message.split('\n', 1)[0],
        link: commit.link,
        guid: commit.sha,
        author: commit.author || detail.author,
        pubDate: commit.pubDate,
        category: [...(commit.isMerge ? ['merge'] : []), ...detail.files.slice(0, maxCategories).map((file) => file.path)],
        description: description.join('\n'),
    };
}

async function fetchCommitDetail(link: string): Promise<CommitDetail> {
    try {
        const patch = await ofetch<string, 'text'>(`${link}.patch`, { responseType: 'text' });

        return parsePatch(patch.length > maxPatchLength ? patch.slice(0, maxPatchLength) : patch);
    } catch {
        return { files: [] };
    }
}

function parsePatch(patch: string): CommitDetail {
    const diffStart = patch.indexOf('diff --git ');
    const header = diffStart === -1 ? patch : patch.slice(0, diffStart);
    const body = diffStart === -1 ? '' : patch.slice(diffStart);
    const files = body
        .split(/(?=^diff --git )/m)
        .filter((block) => block.trim() !== '')
        .map((block) => parseChangedFile(block));

    return { author: /^From: (.+?)(?: <.*>)?$/m.exec(header)?.[1], files };
}

function parseChangedFile(block: string): ChangedFile {
    const lines = block.split('\n');
    const hunkStart = lines.findIndex((line) => line.startsWith('@@'));
    const headerLines = lines.slice(0, hunkStart === -1 ? lines.length : hunkStart);
    const diffLines = (hunkStart === -1 ? [] : lines.slice(hunkStart)).filter((line, index, array) => !(index === array.length - 1 && line === ''));

    return {
        path: changedFilePath(headerLines),
        additions: diffLines.filter((line) => line.startsWith('+')).length,
        deletions: diffLines.filter((line) => line.startsWith('-')).length,
        lines: diffLines,
    };
}

function changedFilePath(headerLines: string[]) {
    const added = headerLines.find((line) => line.startsWith('+++ ') && line !== '+++ /dev/null');
    if (added) {
        return added.replace(/^\+\+\+ (?:b\/)?/, '');
    }

    const removed = headerLines.find((line) => line.startsWith('--- ') && line !== '--- /dev/null');
    if (removed) {
        return removed.replace(/^--- (?:a\/)?/, '');
    }

    const renamed = headerLines.find((line) => line.startsWith('rename to '));
    if (renamed) {
        return renamed.replace(/^rename to /, '');
    }

    return (
        headerLines
            .find((line) => line.startsWith('diff --git '))
            ?.split(' b/')
            .at(-1) ?? 'unknown'
    );
}

function renderDiffLine(line: string) {
    // Tabs are stripped from item descriptions by the template middleware, so expand them before escaping
    const text = escapeText(line.replaceAll('\t', ' '.repeat(4)));

    if (line.startsWith('@@')) {
        return `<span style="${diffStyle.hunk}">${text}</span>`;
    }
    if (line.startsWith('+')) {
        return `<span style="${diffStyle.added}">${text}</span>`;
    }
    if (line.startsWith('-')) {
        return `<span style="${diffStyle.removed}">${text}</span>`;
    }

    return text;
}
