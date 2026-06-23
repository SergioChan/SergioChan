import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const sourceExtensions = new Set([
  '.c',
  '.cc',
  '.clj',
  '.cljs',
  '.cpp',
  '.cs',
  '.css',
  '.dart',
  '.ex',
  '.exs',
  '.go',
  '.graphql',
  '.h',
  '.hpp',
  '.html',
  '.java',
  '.jl',
  '.js',
  '.jsx',
  '.kt',
  '.kts',
  '.lua',
  '.m',
  '.mm',
  '.php',
  '.pl',
  '.prisma',
  '.py',
  '.r',
  '.rb',
  '.rs',
  '.scala',
  '.scss',
  '.sh',
  '.sol',
  '.sql',
  '.svelte',
  '.swift',
  '.tf',
  '.ts',
  '.tsx',
  '.vue',
  '.zig',
]);

const configExtensions = new Set([
  '.cjs',
  '.conf',
  '.env',
  '.ini',
  '.json',
  '.mjs',
  '.toml',
  '.xml',
  '.yaml',
  '.yml',
]);

const docsExtensions = new Set(['.adoc', '.md', '.mdx', '.rst', '.txt']);
const assetExtensions = new Set([
  '.avif',
  '.bmp',
  '.csv',
  '.eot',
  '.gif',
  '.ico',
  '.jpeg',
  '.jpg',
  '.jsonl',
  '.mov',
  '.mp3',
  '.mp4',
  '.otf',
  '.parquet',
  '.pdf',
  '.png',
  '.svg',
  '.ttf',
  '.wav',
  '.webm',
  '.webp',
  '.woff',
  '.woff2',
  '.zip',
]);

const generatedPathParts = [
  '/.next/',
  '/build/',
  '/coverage/',
  '/dist/',
  '/node_modules/',
  '/out/',
  '/target/',
  '/vendor/',
];

const lockFileNames = new Set([
  'bun.lock',
  'bun.lockb',
  'Cargo.lock',
  'Gemfile.lock',
  'go.sum',
  'package-lock.json',
  'pnpm-lock.yaml',
  'poetry.lock',
  'Pipfile.lock',
  'yarn.lock',
]);

const defaultSnapshotPath = new URL('../assets/monthly-code-stats.json', import.meta.url);

function githubHeaders(token, extra = {}) {
  return {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'profile-monthly-code-stats',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...extra,
  };
}

async function gh(token, url, init = {}) {
  const target = url.startsWith('http') ? url : `https://api.github.com${url}`;
  let res;
  let body = '';

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    res = await fetch(target, {
      ...init,
      headers: githubHeaders(token, init.headers),
    });

    if (res.ok) return res.json();

    body = await res.text();
    if (![401, 403, 429, 500, 502, 503, 504].includes(res.status) || attempt === 3) break;
    await new Promise((resolve) => setTimeout(resolve, attempt * 1500));
  }

  const err = new Error(`GitHub request failed ${res.status}: ${body}`);
  err.status = res.status;
  err.body = body;
  throw err;
}

async function listPaginated(token, routeForPage) {
  const rows = [];
  let page = 1;

  while (true) {
    let payload;
    try {
      payload = await gh(token, routeForPage(page));
    } catch (err) {
      if (err.status === 409 && err.body?.includes('Git Repository is empty')) return rows;
      throw err;
    }
    if (!Array.isArray(payload) || payload.length === 0) return rows;

    rows.push(...payload);
    if (payload.length < 100) return rows;
    page += 1;
  }
}

function getTimeZoneParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date);

  const values = Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, Number(part.value)]));
  if (values.hour === 24) values.hour = 0;
  return values;
}

function getTimeZoneOffsetMs(date, timeZone) {
  const parts = getTimeZoneParts(date, timeZone);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return asUtc - date.getTime();
}

function zonedTimeToUtc({ year, month, day, hour = 0, minute = 0, second = 0 }, timeZone) {
  const initial = Date.UTC(year, month - 1, day, hour, minute, second);
  const firstOffset = getTimeZoneOffsetMs(new Date(initial), timeZone);
  const refined = initial - firstOffset;
  const secondOffset = getTimeZoneOffsetMs(new Date(refined), timeZone);
  return new Date(initial - secondOffset);
}

export function getCurrentMonthWindow(now = new Date(), timeZone = 'America/Los_Angeles') {
  const parts = getTimeZoneParts(now, timeZone);
  const nextMonthYear = parts.month === 12 ? parts.year + 1 : parts.year;
  const nextMonth = parts.month === 12 ? 1 : parts.month + 1;
  const start = zonedTimeToUtc({ year: parts.year, month: parts.month, day: 1 }, timeZone);
  const end = zonedTimeToUtc({ year: nextMonthYear, month: nextMonth, day: 1 }, timeZone);
  const label = new Intl.DateTimeFormat('en-US', {
    timeZone,
    month: 'long',
    year: 'numeric',
  }).format(now);

  return {
    label,
    startIso: start.toISOString(),
    endIso: end.toISOString(),
  };
}

function extensionFor(filename) {
  const base = path.basename(filename);
  if (base === 'Dockerfile' || base.endsWith('.Dockerfile')) return 'Dockerfile';
  if (base === 'Makefile') return 'Makefile';
  return path.extname(filename);
}

function isGeneratedPath(filename) {
  const normalized = `/${filename}`;
  return generatedPathParts.some((part) => normalized.includes(part));
}

function isLockFile(filename) {
  const base = path.basename(filename);
  return lockFileNames.has(base) || base.endsWith('.lock');
}

function categoryForFile(filename) {
  const base = path.basename(filename);
  const ext = extensionFor(filename);

  if (isGeneratedPath(filename) || isLockFile(filename)) return 'lock/generated';
  if (assetExtensions.has(ext)) return 'asset/data';
  if (sourceExtensions.has(ext) || ext === 'Dockerfile' || ext === 'Makefile') return 'source';
  if (
    configExtensions.has(ext) ||
    base.startsWith('.env') ||
    base === '.gitignore' ||
    base === '.dockerignore' ||
    base === 'requirements.txt'
  ) {
    return 'config';
  }
  if (docsExtensions.has(ext)) return 'docs';
  return 'other';
}

function createTotals() {
  return { additions: 0, deletions: 0, files: 0 };
}

function addFileToTotals(totals, file) {
  totals.additions += file.additions ?? 0;
  totals.deletions += file.deletions ?? 0;
  totals.files += 1;
}

function net(totals) {
  return totals.additions - totals.deletions;
}

function totalsWithNet(totals) {
  return {
    ...totals,
    net: net(totals),
  };
}

function createTotalsGroup() {
  return {
    source: createTotals(),
    engineering: createTotals(),
    allFiles: createTotals(),
  };
}

function addFileToTotalsGroup(group, category, file) {
  addFileToTotals(group.allFiles, file);
  if (category === 'source') addFileToTotals(group.source, file);
  if (category === 'source' || category === 'config') addFileToTotals(group.engineering, file);
}

function totalsGroupWithNet(group) {
  return {
    source: totalsWithNet(group.source),
    engineering: totalsWithNet(group.engineering),
    allFiles: totalsWithNet(group.allFiles),
  };
}

function publicSnapshot(stats) {
  const allCommits = totalsGroupWithNet(stats.allCommits);
  const nonMerge = totalsGroupWithNet(stats.nonMerge);

  return {
    generatedAt: stats.generatedAt,
    owner: stats.owner,
    timeZone: stats.timeZone,
    monthLabel: stats.monthLabel,
    monthStart: stats.monthStart,
    monthEnd: stats.monthEnd,
    repoCount: stats.repoCount,
    privateRepoCount: stats.privateRepoCount,
    commitCount: stats.commitCount,
    nonMergeCommitCount: stats.nonMergeCommitCount,
    mergeCommitCount: stats.mergeCommitCount,
    source: allCommits.source,
    engineering: allCommits.engineering,
    allFiles: allCommits.allFiles,
    allCommits,
    nonMerge,
    displayMetric: {
      scope: 'all commits, all files',
      additions: allCommits.allFiles.additions,
      deletions: allCommits.allFiles.deletions,
      net: allCommits.allFiles.net,
    },
    scope: 'default-branch commits where author or committer matches profile owner',
    privateRepoNamesExcluded: true,
  };
}

async function fetchCommitDetailsWithWorkers(token, commits, workerCount = 4) {
  const details = [];
  let index = 0;

  async function worker() {
    while (index < commits.length) {
      const current = commits[index];
      index += 1;
      const detail = await gh(token, `/repos/${current.repo}/commits/${current.sha}`);
      details.push({ ...current, detail });
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return details;
}

export async function computeMonthlyCodeStats({
  owner = 'SergioChan',
  token,
  now = new Date(),
  timeZone = 'America/Los_Angeles',
  workerCount = 2,
} = {}) {
  if (!token) {
    throw new Error('A GitHub token is required to compute private monthly code stats.');
  }

  const month = getCurrentMonthWindow(now, timeZone);
  const repos = await listPaginated(
    token,
    (page) =>
      `/user/repos?visibility=all&affiliation=owner,collaborator,organization_member&sort=pushed&direction=desc&per_page=100&page=${page}`,
  );
  const activeRepos = repos.filter((repo) => repo.pushed_at && repo.pushed_at >= month.startIso);
  const commits = new Map();

  for (const repo of activeRepos) {
    for (const filter of ['author', 'committer']) {
      const matches = await listPaginated(
        token,
        (page) =>
          `/repos/${repo.full_name}/commits?${filter}=${encodeURIComponent(owner)}&since=${encodeURIComponent(month.startIso)}&until=${encodeURIComponent(month.endIso)}&per_page=100&page=${page}`,
      );

      for (const commit of matches) {
        const key = `${repo.full_name}@${commit.sha}`;
        if (!commits.has(key)) {
          commits.set(key, {
            repo: repo.full_name,
            repoPrivate: Boolean(repo.private),
            sha: commit.sha,
          });
        }
      }
    }
  }

  const details = await fetchCommitDetailsWithWorkers(token, [...commits.values()], workerCount);
  const repoNames = new Set();
  const privateRepoNames = new Set();
  const allCommits = createTotalsGroup();
  const nonMerge = createTotalsGroup();
  let mergeCommitCount = 0;
  let nonMergeCommitCount = 0;

  for (const commit of details) {
    repoNames.add(commit.repo);
    if (commit.repoPrivate) privateRepoNames.add(commit.repo);

    const isMerge = (commit.detail.parents?.length ?? 0) > 1;
    const files = commit.detail.files ?? [];
    const categorizedFiles = files.map((file) => ({
      category: categoryForFile(file.filename),
      additions: file.additions ?? 0,
      deletions: file.deletions ?? 0,
    }));

    for (const file of categorizedFiles) {
      addFileToTotalsGroup(allCommits, file.category, file);
    }

    if (isMerge) {
      mergeCommitCount += 1;
    } else {
      nonMergeCommitCount += 1;
      for (const file of categorizedFiles) {
        addFileToTotalsGroup(nonMerge, file.category, file);
      }
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    owner,
    timeZone,
    monthLabel: month.label,
    monthStart: month.startIso,
    monthEnd: month.endIso,
    repoCount: repoNames.size,
    privateRepoCount: privateRepoNames.size,
    commitCount: commits.size,
    nonMergeCommitCount,
    mergeCommitCount,
    allCommits,
    nonMerge,
  };
}

export async function readMonthlyCodeStatsSnapshot(snapshotPath = defaultSnapshotPath) {
  try {
    return JSON.parse(await fs.readFile(snapshotPath, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

export async function writeMonthlyCodeStatsSnapshot(stats, snapshotPath = defaultSnapshotPath) {
  await fs.mkdir(new URL('../assets/', import.meta.url), { recursive: true });
  const snapshot = publicSnapshot(stats);
  await fs.writeFile(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`);
  return snapshot;
}

export function formatCodeVolume(value) {
  if (!Number.isFinite(value)) return '0';
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2).replace(/\.?0+$/, '')}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1).replace(/\.0$/, '')}K`;
  return String(value);
}

async function main() {
  const token = process.env.PROFILE_STATS_TOKEN || process.env.GITHUB_TOKEN;
  const owner = process.env.PROFILE_OWNER || 'SergioChan';
  const timeZone = process.env.PROFILE_TIME_ZONE || 'America/Los_Angeles';
  const stats = await computeMonthlyCodeStats({
    owner,
    token,
    timeZone,
    workerCount: Number(process.env.MONTHLY_CODE_WORKERS || 2),
  });
  const snapshot = await writeMonthlyCodeStatsSnapshot(stats);
  console.log(JSON.stringify(snapshot, null, 2));
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
