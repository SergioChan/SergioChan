import fs from 'node:fs/promises';

const owner = process.env.PROFILE_OWNER || 'SergioChan';
const token = process.env.GITHUB_TOKEN;

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
const progressBarWidth = 20;
const contributionSearchUrl = `https://github.com/pulls?q=is%3Apr+author%3A${owner}`;
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
    throw new Error(`GitHub request failed ${res.status}: ${await res.text()}`);
  }

  return res.json();
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

    if (data.items.length < 100 || items.length >= data.total_count) {
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

function formatCompactNumber(value) {
  return new Intl.NumberFormat('en-US', {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(value);
}

function formatPercent(value) {
  return `${value.toFixed(1)}%`;
}

function formatTimestamp(date) {
  return date.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

function renderProgressBar(percent, width = progressBarWidth) {
  const clamped = Math.max(0, Math.min(100, percent));
  const filled = Math.round((clamped / 100) * width);
  return `${'#'.repeat(filled)}${'-'.repeat(width - filled)}`;
}

function badgeUrl(label, message, color, options = {}) {
  const params = new URLSearchParams({ style: options.style ?? 'for-the-badge' });
  if (options.logo) params.set('logo', options.logo);
  return `https://img.shields.io/badge/${encodeURIComponent(label)}-${encodeURIComponent(message)}-${color}?${params}`;
}

function cleanDescription(description, fallback) {
  const text = (description || fallback || '').replace(/\s+/g, ' ').trim();
  return text.endsWith('.') ? text.slice(0, -1) : text;
}

function shortenText(text, maxLength) {
  if (text.length <= maxLength) return text;
  const trimmed = text.slice(0, maxLength - 3).replace(/[.\s]+$/g, '');
  const boundary = trimmed.lastIndexOf(' ');
  const safe = boundary > maxLength * 0.6 ? trimmed.slice(0, boundary) : trimmed;
  return `${safe}...`;
}

function replaceBlock(readme, start, end, content) {
  const pattern = new RegExp(`${start}[\\s\\S]*?${end}`);
  return readme.replace(pattern, `${start}\n${content}\n${end}`);
}

async function main() {
  const [
    profile,
    totalPRs,
    mergedPRs,
    closedPRs,
    openPRs,
    prs30d,
    merged30d,
    allPRs,
    ownedRepos,
    featuredRepos,
    recentPRSearch,
  ] = await Promise.all([
    gh(`/users/${owner}`),
    searchCount(publicPRQuery),
    searchCount(`${publicPRQuery} is:merged`),
    searchCount(`${publicPRQuery} is:closed`),
    searchCount(`${publicPRQuery} is:open`),
    searchCount(`${publicPRQuery} created:>=${isoDaysAgo(30)}`),
    searchCount(`${publicPRQuery} is:merged merged:>=${isoDaysAgo(30)}`),
    searchAllIssues(publicPRQuery),
    listOwnedRepos(owner),
    Promise.all(featuredBuildRepos.map((repo) => gh(`/repos/${repo.fullName}`))),
    searchIssues(publicPRQuery, { sort: 'updated', order: 'desc', perPage: 30 }),
  ]);

  const acceptanceRate = (mergedPRs / Math.max(closedPRs, 1)) * 100;
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

  const recentContributionRepos = await Promise.all(
    [...recentRepoMap.entries()].map(async ([fullName, item]) => {
      const repo = await gh(`/repos/${fullName}`);
      return { item, repo };
    }),
  );

  const badgeBlock = [
    '<p>',
    `  <a href="https://github.com/${owner}?tab=followers"><img src="${badgeUrl('Followers', formatCompactNumber(profile.followers), '181717', { logo: 'github' })}" /></a>`,
    `  <a href="https://github.com/${owner}?tab=repositories"><img src="${badgeUrl('Public Repos', String(profile.public_repos), '181717', { logo: 'github' })}" /></a>`,
    `  <a href="https://github.com/${owner}?tab=repositories"><img src="${badgeUrl('Stars Earned', formatCompactNumber(totalStars), 'f5b301', { logo: 'github' })}" /></a>`,
    `  <a href="${contributionSearchUrl}"><img src="${badgeUrl('Repos via PRs', String(reposContributed), '2f81f7', { logo: 'github' })}" /></a>`,
    '</p>',
    '<p>',
    `  <a href="${contributionSearchUrl}"><img src="${badgeUrl('Merge Rate', formatPercent(acceptanceRate), '2ea043', { logo: 'git' })}" /></a>`,
    `  <a href="${contributionSearchUrl}"><img src="${badgeUrl('PRs Merged', String(mergedPRs), '238636', { logo: 'github' })}" /></a>`,
    `  <a href="${contributionSearchUrl}"><img src="${badgeUrl('Open PRs', String(openPRs), 'f85149', { logo: 'github' })}" /></a>`,
    `  <a href="https://github.com/${owner}"><img src="https://komarev.com/ghpvc/?username=${owner}&style=for-the-badge&color=0e75b6" /></a>`,
    '</p>',
  ].join('\n');

  const buildingBlock = featuredRepos
    .map((repo, index) => {
      const featured = featuredBuildRepos[index];
      const description = cleanDescription(repo.description, featured.fallbackDescription);
      const suffix = repo.language ? ` (${repo.language})` : '';
      return `- [\`${repo.full_name}\`](${repo.html_url}): ${description}${suffix}`;
    })
    .join('\n');

  const contributingBlock = recentContributionRepos
    .map(({ item, repo }) => {
      const state = item.pull_request?.merged_at ? 'merged' : item.state;
      const title = shortenText(item.title, 76);
      return `- [\`${repo.full_name}\`](${repo.html_url}): Recent PR: \`${title}\` (${state})`;
    })
    .join('\n');

  const now = formatTimestamp(new Date());
  const statsBlock = [
    '<table>',
    '  <tr>',
    '    <td width="420">',
    '      <strong>Closed PR merge rate</strong><br />',
    `      <code>${renderProgressBar(acceptanceRate)} ${formatPercent(acceptanceRate)}</code><br />`,
    `      <sub>${mergedPRs} merged out of ${closedPRs} closed pull requests.</sub>`,
    '    </td>',
    '    <td width="420">',
    '      <strong>Current pipeline</strong><br />',
    `      <sub>${openPRs} open PRs in flight. ${prs30d} opened and ${merged30d} merged in the last 30 days.</sub>`,
    '    </td>',
    '  </tr>',
    '</table>',
    '',
    '| Total PRs | Closed | Merged | Open | Repos via PRs | Updated |',
    '| --- | --- | --- | --- | --- | --- |',
    `| ${totalPRs} | ${closedPRs} | ${mergedPRs} | ${openPRs} | ${reposContributed} | ${now} |`,
  ].join('\n');

  const ossSignalBlock = [
    '<table>',
    '  <tr>',
    '    <td width="280">',
    '      <strong>Public footprint</strong><br />',
    `      <sub>${profile.public_repos} public repos, ${formatCompactNumber(totalStars)} stars earned, ${formatCompactNumber(profile.followers)} followers.</sub>`,
    '    </td>',
    '    <td width="280">',
    '      <strong>Contribution spread</strong><br />',
    `      <sub>${reposContributed} public repositories touched via pull requests, ${totalPRs} public PRs opened in total.</sub>`,
    '    </td>',
    '    <td width="280">',
    '      <strong>Recent pace</strong><br />',
    `      <sub>${prs30d} public PRs opened and ${merged30d} merged in the last 30 days.</sub>`,
    '    </td>',
    '  </tr>',
    '</table>',
  ].join('\n');

  const readmePath = new URL('../README.md', import.meta.url);
  let readme = await fs.readFile(readmePath, 'utf8');

  readme = replaceBlock(readme, '<!-- BADGES:START -->', '<!-- BADGES:END -->', badgeBlock);
  readme = replaceBlock(readme, '<!-- BUILDING:START -->', '<!-- BUILDING:END -->', buildingBlock);
  readme = replaceBlock(readme, '<!-- CONTRIBUTING:START -->', '<!-- CONTRIBUTING:END -->', contributingBlock);
  readme = replaceBlock(readme, '<!-- STATS:START -->', '<!-- STATS:END -->', statsBlock);
  readme = replaceBlock(readme, '<!-- OSS_SIGNAL:START -->', '<!-- OSS_SIGNAL:END -->', ossSignalBlock);

  await fs.writeFile(readmePath, readme);
  console.log('README profile sections updated');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
