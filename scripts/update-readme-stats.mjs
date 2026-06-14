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
    const err = new Error(`GitHub request failed ${res.status}: ${await res.text()}`);
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

function cleanDescription(description, fallback) {
  const text = (description || fallback || '').replace(/\s+/g, ' ').trim();
  return text.endsWith('.') ? text.slice(0, -1) : text;
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
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

function metricBar(value, max, width = 206) {
  return Math.max(4, Math.round((value / Math.max(max, 1)) * width));
}

function repoShortName(fullName) {
  return fullName
    .replace(/^t54-labs\//, 't54/')
    .replace(/^SergioChan\//, '~/');
}

function svgMetricCard({ x, y, label, value, tone = '#96e703' }) {
  return `
    <g transform="translate(${x} ${y})">
      <rect width="176" height="92" rx="18" fill="#101820" stroke="#2b3b46"/>
      <rect x="14" y="16" width="34" height="4" rx="2" fill="${tone}"/>
      <text x="14" y="50" class="metric">${escapeXml(value)}</text>
      <text x="14" y="74" class="micro">${escapeXml(label)}</text>
    </g>`;
}

function svgRepoRows(items, x, y, options = {}) {
  const rows = items.slice(0, 4).map((item, index) => {
    const fullName = item.repo?.full_name || item.full_name || item;
    const extra = item.state ? ` / ${item.state}` : '';
    return `
      <g transform="translate(${x} ${y + index * 34})">
        <rect width="10" height="10" x="0" y="-8" rx="2" fill="${index === 0 ? '#96e703' : '#40515d'}"/>
        <text x="22" y="0" class="row">${escapeXml(shortenText(repoShortName(fullName), options.maxLength || 31))}${escapeXml(extra)}</text>
      </g>`;
  });

  return rows.join('');
}

function renderProfileHero({
  owner,
  profile,
  totalStars,
  totalPRs,
  mergedPRs,
  closedPRs,
  openPRs,
  prs30d,
  merged30d,
  reposContributed,
  featuredRepos,
  recentContributionRepos,
  updatedAt,
}) {
  const mergeRate = formatPercent((mergedPRs / Math.max(closedPRs, 1)) * 100);
  const featuredRows = svgRepoRows(featuredRepos, 66, 406);
  const recentRows = svgRepoRows(
    recentContributionRepos.map(({ item, repo }) => ({
      repo,
      state: item.pull_request?.merged_at ? 'merged' : item.state,
    })),
    18,
    8,
    { maxLength: 29 },
  );

  return `<!-- Generated by scripts/update-readme-stats.mjs -->
<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="560" viewBox="0 0 1200 560" role="img" aria-labelledby="title desc">
  <title id="title">SergioChan profile command center</title>
  <desc id="desc">A dark GitHub profile command center with live public repository, pull request, star, follower, and contribution signals.</desc>
  <defs>
    <linearGradient id="bg" x1="0" x2="1" y1="0" y2="1">
      <stop offset="0%" stop-color="#05070c"/>
      <stop offset="56%" stop-color="#08111a"/>
      <stop offset="100%" stop-color="#0f1720"/>
    </linearGradient>
    <linearGradient id="signal" x1="0" x2="1">
      <stop offset="0%" stop-color="#96e703" stop-opacity="0"/>
      <stop offset="48%" stop-color="#96e703" stop-opacity=".42"/>
      <stop offset="100%" stop-color="#96e703" stop-opacity="0"/>
    </linearGradient>
    <radialGradient id="orb" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="#96e703" stop-opacity=".48"/>
      <stop offset="54%" stop-color="#2f81f7" stop-opacity=".18"/>
      <stop offset="100%" stop-color="#05070c" stop-opacity="0"/>
    </radialGradient>
    <pattern id="grid" width="34" height="34" patternUnits="userSpaceOnUse">
      <path d="M34 0H0V34" fill="none" stroke="#273541" stroke-width="1" opacity=".36"/>
    </pattern>
    <filter id="softGlow" x="-30%" y="-30%" width="160%" height="160%">
      <feGaussianBlur stdDeviation="10" result="blur"/>
      <feMerge>
        <feMergeNode in="blur"/>
        <feMergeNode in="SourceGraphic"/>
      </feMerge>
    </filter>
    <style>
      .title { font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif; font-size: 72px; font-weight: 800; fill: #f4f7f5; letter-spacing: -2px; }
      .subtitle { font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif; font-size: 24px; font-weight: 700; fill: #d6e2de; }
      .copy { font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif; font-size: 18px; font-weight: 500; fill: #91a1a8; }
      .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 16px; font-weight: 700; fill: #96e703; letter-spacing: 1.5px; }
      .micro { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 13px; font-weight: 700; fill: #8fa3aa; letter-spacing: 1px; }
      .metric { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 31px; font-weight: 800; fill: #f4f7f5; }
      .row { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 15px; font-weight: 700; fill: #d8e6e0; }
      .small { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; font-weight: 700; fill: #6f858d; letter-spacing: 1px; }
      .hair { stroke: #263744; stroke-width: 1; }
      .accent { fill: #96e703; }
      @media (prefers-reduced-motion: no-preference) {
        .scan { animation: scan 8s linear infinite; }
        .pulse { animation: pulse 2.8s ease-in-out infinite; transform-origin: center; transform-box: fill-box; }
        @keyframes scan { from { transform: translateY(-560px); } to { transform: translateY(560px); } }
        @keyframes pulse { 0%, 100% { opacity: .58; transform: scale(1); } 50% { opacity: 1; transform: scale(1.04); } }
      }
    </style>
  </defs>

  <rect width="1200" height="560" rx="30" fill="url(#bg)"/>
  <rect width="1200" height="560" rx="30" fill="url(#grid)" opacity=".58"/>
  <rect class="scan" x="0" y="0" width="1200" height="140" fill="url(#signal)" opacity=".5"/>
  <circle cx="956" cy="207" r="220" fill="url(#orb)" filter="url(#softGlow)"/>
  <path d="M765 68C840 30 965 22 1058 58C1116 80 1155 125 1168 180" fill="none" stroke="#21333d" stroke-width="2"/>
  <path d="M759 315C837 354 970 366 1068 325C1122 302 1158 260 1170 207" fill="none" stroke="#21333d" stroke-width="2"/>

  <text x="64" y="78" class="mono">SERGIOCHAN / PROFILE COMMAND CENTER</text>
  <text x="64" y="148" class="title">Sergio Chan</text>
  <text x="68" y="190" class="subtitle">Full-stack hacker / founder / hardcore gamer</text>
  <text x="68" y="228" class="copy">Shipping AI-native products, payment rails, and developer systems.</text>

  ${svgMetricCard({ x: 66, y: 270, label: 'PUBLIC REPOS', value: String(profile.public_repos), tone: '#96e703' })}
  ${svgMetricCard({ x: 262, y: 270, label: 'STARS EARNED', value: formatCompactNumber(totalStars), tone: '#d6f76f' })}
  ${svgMetricCard({ x: 458, y: 270, label: 'FOLLOWERS', value: formatCompactNumber(profile.followers), tone: '#7ac943' })}

  <text x="66" y="390" class="micro accent">BUILD LAB</text>
  ${featuredRows}

  <g transform="translate(734 72)">
    <rect width="392" height="284" rx="26" fill="#0a1119" stroke="#2a3d48"/>
    <text x="28" y="42" class="micro accent">LIVE RADAR</text>
    <text x="28" y="84" class="metric">${escapeXml(mergeRate)}</text>
    <text x="28" y="110" class="micro">MERGE RATE</text>
    <rect x="28" y="142" width="206" height="10" rx="5" fill="#182632"/>
    <rect x="28" y="142" width="${metricBar(mergedPRs, totalPRs)}" height="10" rx="5" fill="#96e703"/>
    <rect x="28" y="174" width="206" height="10" rx="5" fill="#182632"/>
    <rect x="28" y="174" width="${metricBar(openPRs, totalPRs)}" height="10" rx="5" fill="#5fb2ff"/>
    <rect x="28" y="206" width="206" height="10" rx="5" fill="#182632"/>
    <rect x="28" y="206" width="${metricBar(reposContributed, Math.max(reposContributed, 200))}" height="10" rx="5" fill="#d6f76f"/>
    <text x="250" y="151" class="small">${mergedPRs} merged</text>
    <text x="250" y="183" class="small">${openPRs} open</text>
    <text x="250" y="215" class="small">${reposContributed} repos</text>
    <line x1="28" x2="364" y1="238" y2="238" class="hair"/>
    <text x="28" y="268" class="small">${prs30d} PRs opened / ${merged30d} merged in 30d</text>
  </g>

  <circle cx="1072" cy="92" r="5" class="pulse accent"/>
  <circle cx="1120" cy="206" r="4" fill="#5fb2ff"/>
  <circle cx="956" cy="370" r="4" fill="#d6f76f"/>

  <g transform="translate(724 386)">
    <text x="18" y="-16" class="micro accent">RECENT PUBLIC TRAIL</text>
    ${recentRows}
  </g>

  <line x1="64" x2="1138" y1="520" y2="520" class="hair"/>
  <text x="64" y="542" class="small">UPDATED ${escapeXml(updatedAt)}</text>
  <text x="1138" y="542" text-anchor="end" class="small">SOURCE: PUBLIC GITHUB ACTIVITY</text>
</svg>
`;
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

  const recentContributionRepos = await Promise.all(
    [...recentRepoMap.entries()].map(async ([fullName, item]) => {
      const repo = await gh(`/repos/${fullName}`);
      return { item, repo };
    }),
  );

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
  const heroSvg = renderProfileHero({
    owner,
    profile,
    totalStars,
    totalPRs,
    mergedPRs,
    closedPRs,
    openPRs,
    prs30d,
    merged30d,
    reposContributed,
    featuredRepos,
    recentContributionRepos,
    updatedAt: now,
  });

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
  const heroPath = new URL('../assets/profile-hero.svg', import.meta.url);
  let readme = await fs.readFile(readmePath, 'utf8');

  await fs.mkdir(new URL('../assets/', import.meta.url), { recursive: true });
  await fs.writeFile(heroPath, heroSvg);

  readme = replaceBlock(
    readme,
    '<!-- HERO:START -->',
    '<!-- HERO:END -->',
    '<p align="center">\n  <img src="./assets/profile-hero.svg" alt="SergioChan profile command center" width="100%" />\n</p>',
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
