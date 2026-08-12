import fs from 'node:fs/promises';
import {
  computeMonthlyCodeStats,
  formatCodeVolume,
  readMonthlyCodeStatsSnapshot,
  writeMonthlyCodeStatsSnapshot,
} from './monthly-code-stats.mjs';
import { renderProfileHero, formatCompact } from './render-hero.mjs';

const owner = process.env.PROFILE_OWNER || 'SergioChan';
const token = process.env.PROFILE_STATS_TOKEN || process.env.GITHUB_TOKEN;
const profileTimeZone = process.env.PROFILE_TIME_ZONE || 'America/Los_Angeles';
const displayName = process.env.PROFILE_NAME || 'Sergio Chan';

const featuredBuildRepos = [
  {
    fullName: 't54-labs/clawcredit-blockrun-gateway',
    fallbackDescription: 'Gateway layer for ClawCredit and BlockRun payment flows.',
  },
  {
    fullName: 't54-labs/x402-xrpl',
    fallbackDescription: 'XRPL-native x402 explorer and payment surface.',
  },
  {
    fullName: 't54-labs/x402-secure',
    fallbackDescription: 'Security-focused x402 tooling for trusted payment flows.',
  },
  {
    fullName: 't54-labs/tpay-sdk-python',
    fallbackDescription: 'Python SDK for integrating T54 payment capabilities.',
  },
];

const recentContributionRepoLimit = 6;
const publicPRQuery = `author:${owner} type:pr is:public`;

function githubHeaders(extra = {}) {
  return {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'profile-readme-updater',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...extra,
  };
}

async function gh(url, init = {}) {
  const target = url.startsWith('http') ? url : `https://api.github.com${url}`;
  const res = await fetch(target, {
    ...init,
    headers: githubHeaders(init.headers),
  });

  if (!res.ok) {
    const err = new Error(`GitHub request failed ${res.status} for ${url}`);
    err.status = res.status;
    throw err;
  }

  return res.json();
}

async function ghOptional(url, fallback) {
  try {
    return await gh(url);
  } catch (err) {
    if (err.status === 404) return fallback;
    throw err;
  }
}

async function searchIssues(query, options = {}) {
  const params = new URLSearchParams({
    q: query,
    per_page: String(options.perPage ?? 100),
    page: String(options.page ?? 1),
  });

  if (options.sort) params.set('sort', options.sort);
  if (options.order) params.set('order', options.order);

  return gh(`/search/issues?${params}`);
}

async function searchCount(query) {
  const data = await searchIssues(query, { perPage: 1 });
  if (typeof data.total_count !== 'number') {
    throw new Error(`Unexpected search response for ${query}: ${JSON.stringify(data)}`);
  }
  return data.total_count;
}

async function searchAllIssues(query) {
  const items = [];
  let page = 1;

  while (true) {
    const data = await searchIssues(query, { perPage: 100, page });
    items.push(...data.items);

    // GitHub search exposes at most 1000 results (10 pages); page 11 returns 422.
    if (data.items.length < 100 || items.length >= data.total_count || page >= 10) {
      return items;
    }

    page += 1;
  }
}

async function listOwnedRepos(login) {
  const repos = [];
  let page = 1;

  while (true) {
    const data = await gh(`/users/${login}/repos?type=owner&sort=updated&per_page=100&page=${page}`);
    repos.push(...data);

    if (data.length < 100) {
      return repos;
    }

    page += 1;
  }
}

function isoDaysAgo(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

function formatTimestamp(date) {
  return date.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

function cleanDescription(description, fallback) {
  const text = (description || fallback || '').replace(/\s+/g, ' ').trim();
  return text.endsWith('.') ? text.slice(0, -1) : text;
}

function fallbackRepo(repo) {
  return {
    full_name: repo.fullName,
    html_url: `https://github.com/${repo.fullName}`,
    description: repo.fallbackDescription,
    language: null,
  };
}

function shortenText(text, maxLength) {
  if (text.length <= maxLength) return text;
  const trimmed = text.slice(0, maxLength - 3).replace(/[.\s]+$/g, '');
  const boundary = trimmed.lastIndexOf(' ');
  const safe = boundary > maxLength * 0.6 ? trimmed.slice(0, boundary) : trimmed;
  return `${safe}...`;
}

// README.md is Markdown, so backticks / brackets in third-party PR titles and
// repo descriptions must be neutralised before interpolation (they are not
// owner-controlled). escapeXml in render-hero.mjs guards the SVG path instead.
function escapeMarkdown(text) {
  return String(text).replace(/[\\`*_{}\[\]()<>#+\-!|]/g, '\\$&');
}

function replaceBlock(readme, start, end, content) {
  const pattern = new RegExp(`${start}[\\s\\S]*?${end}`);
  return readme.replace(pattern, `${start}\n${content}\n${end}`);
}

async function main() {
  const monthlyCodeStats = await loadMonthlyCodeStats();
  const [
    profile,
    totalPRs,
    prs30d,
    merged30d,
    allPRs,
    ownedRepos,
    featuredRepos,
    recentPRSearch,
  ] = await Promise.all([
    gh(`/users/${owner}`),
    searchCount(publicPRQuery),
    searchCount(`${publicPRQuery} created:>=${isoDaysAgo(30)}`),
    searchCount(`${publicPRQuery} is:merged merged:>=${isoDaysAgo(30)}`),
    searchAllIssues(publicPRQuery),
    listOwnedRepos(owner),
    Promise.all(featuredBuildRepos.map((repo) => ghOptional(`/repos/${repo.fullName}`, fallbackRepo(repo)))),
    searchIssues(publicPRQuery, { sort: 'updated', order: 'desc', perPage: 30 }),
  ]);

  const totalStars = ownedRepos
    .filter((repo) => !repo.fork)
    .reduce((sum, repo) => sum + (repo.stargazers_count ?? 0), 0);
  const reposContributed = new Set(
    allPRs.map((item) => item.repository_url.split('/').slice(-2).join('/')),
  ).size;

  const recentRepoMap = new Map();
  for (const item of recentPRSearch.items) {
    const fullName = item.repository_url.split('/').slice(-2).join('/');
    if (!recentRepoMap.has(fullName)) {
      recentRepoMap.set(fullName, item);
    }
    if (recentRepoMap.size >= recentContributionRepoLimit) break;
  }

  // ghOptional so a repo deleted/renamed between the search and this fetch
  // degrades to a plain link instead of crashing the whole update.
  const recentContributionRepos = await Promise.all(
    [...recentRepoMap.entries()].map(async ([fullName, item]) => {
      const repo = await ghOptional(`/repos/${fullName}`, {
        full_name: fullName,
        html_url: `https://github.com/${fullName}`,
      });
      return { item, repo };
    }),
  );

  const buildingBlock = featuredRepos
    .map((repo, index) => {
      const featured = featuredBuildRepos[index];
      const description = cleanDescription(repo.description, featured.fallbackDescription);
      const suffix = repo.language ? ` (${repo.language})` : '';
      return `- [\`${repo.full_name}\`](${repo.html_url}): ${escapeMarkdown(description)}${suffix}`;
    })
    .join('\n');

  const contributingBlock = recentContributionRepos
    .map(({ item, repo }) => {
      const state = item.pull_request?.merged_at ? 'merged' : item.state;
      const title = escapeMarkdown(shortenText(item.title, 76));
      return `- [\`${repo.full_name}\`](${repo.html_url}): Recent PR: \`${title}\` (${state})`;
    })
    .join('\n');

  const allFiles = monthlyCodeStats?.allCommits?.allFiles ?? monthlyCodeStats?.allFiles ?? {};
  const codeAdditions = allFiles.additions ?? 0;
  const monthLabel = monthlyCodeStats?.monthLabel ?? 'This month';
  const now = formatTimestamp(new Date());

  const heroSvg = renderProfileHero({
    name: displayName,
    monthLabel,
    additions: codeAdditions,
    deletions: allFiles.deletions ?? 0,
    commitCount: monthlyCodeStats?.commitCount ?? monthlyCodeStats?.nonMergeCommitCount ?? 0,
    repoCount: monthlyCodeStats?.repoCount ?? 0,
    privateRepoCount: monthlyCodeStats?.privateRepoCount ?? 0,
    metricLabel: 'LINES ADDED · ALL FILES',
    metricNote: 'INCL. ASSETS · DOCS · GENERATED · MERGES',
    publicRepos: profile.public_repos,
    stars: totalStars,
    followers: profile.followers,
    totalPRs,
    merged30d,
    updatedAt: now,
  });

  const heroAlt =
    `${displayName} — build telemetry. ${monthLabel}: ${formatCodeVolume(codeAdditions)} lines added across all files; ` +
    `${profile.public_repos} public repos, ${formatCompact(totalStars)} stars, ${formatCompact(profile.followers)} followers, ${totalPRs} public PRs.`;

  const ossSignalBlock = [
    '<table>',
    '  <tr>',
    '    <td width="210">',
    '      <strong>Current-month output</strong><br />',
    `      <sub>${monthLabel}: ${formatCodeVolume(codeAdditions)} lines added across all files — incl. assets, docs, generated code &amp; merges.</sub>`,
    '    </td>',
    '    <td width="210">',
    '      <strong>Public footprint</strong><br />',
    `      <sub>${profile.public_repos} public repos, ${formatCompact(totalStars)} stars earned, ${formatCompact(profile.followers)} followers.</sub>`,
    '    </td>',
    '    <td width="210">',
    '      <strong>Contribution spread</strong><br />',
    `      <sub>${reposContributed} public repositories touched via pull requests, ${totalPRs} public PRs opened in total.</sub>`,
    '    </td>',
    '    <td width="210">',
    '      <strong>Recent pace</strong><br />',
    `      <sub>${prs30d} public PRs opened and ${merged30d} merged in the last 30 days.</sub>`,
    '    </td>',
    '  </tr>',
    '</table>',
  ].join('\n');

  const readmePath = new URL('../README.md', import.meta.url);
  const heroPath = new URL('../assets/profile-hero.svg', import.meta.url);
  let readme = await fs.readFile(readmePath, 'utf8');

  await fs.mkdir(new URL('../assets/', import.meta.url), { recursive: true });
  await fs.writeFile(heroPath, heroSvg);

  readme = replaceBlock(
    readme,
    '<!-- HERO:START -->',
    '<!-- HERO:END -->',
    `<p align="center">\n  <img src="./assets/profile-hero.svg" alt="${heroAlt}" width="100%" />\n</p>`,
  );
  readme = replaceBlock(readme, '<!-- BUILDING:START -->', '<!-- BUILDING:END -->', buildingBlock);
  readme = replaceBlock(readme, '<!-- CONTRIBUTING:START -->', '<!-- CONTRIBUTING:END -->', contributingBlock);
  readme = replaceBlock(readme, '<!-- OSS_SIGNAL:START -->', '<!-- OSS_SIGNAL:END -->', ossSignalBlock);

  await fs.writeFile(readmePath, readme);
  console.log('README profile sections updated');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

async function loadMonthlyCodeStats() {
  const cached = await readMonthlyCodeStatsSnapshot();
  const statsToken = process.env.PROFILE_STATS_TOKEN || process.env.GITHUB_TOKEN;

  if (!statsToken) {
    if (cached) return cached;
    throw new Error('PROFILE_STATS_TOKEN or GITHUB_TOKEN is required for monthly code stats.');
  }

  try {
    const computed = await computeMonthlyCodeStats({
      owner,
      token: statsToken,
      timeZone: profileTimeZone,
      workerCount: Number(process.env.MONTHLY_CODE_WORKERS || 2),
    });

    if (
      cached &&
      cached.monthLabel === computed.monthLabel &&
      cached.privateRepoCount > 0 &&
      computed.privateRepoCount === 0
    ) {
      console.warn('Monthly code stats token did not expose private repositories; keeping cached private-aware stats.');
      return cached;
    }

    const snapshot = await writeMonthlyCodeStatsSnapshot(computed);
    return snapshot;
  } catch (err) {
    if (cached) {
      console.warn(`Monthly code stats refresh failed; keeping cached stats: ${err.message}`);
      return cached;
    }
    throw err;
  }
}
