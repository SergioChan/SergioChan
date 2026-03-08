import fs from 'node:fs/promises';

const owner = process.env.PROFILE_OWNER || 'SergioChan';
const token = process.env.GITHUB_TOKEN;

if (!token) {
  throw new Error('GITHUB_TOKEN is required');
}

async function ghRequest(pathOrQuery, isGraphql = false) {
  const url = isGraphql
    ? 'https://api.github.com/graphql'
    : `https://api.github.com${pathOrQuery}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'User-Agent': 'profile-readme-updater',
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(isGraphql ? { query: pathOrQuery } : undefined),
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`GitHub API ${res.status}: ${txt}`);
  }
  return res.json();
}

async function searchCount(query) {
  const q = encodeURIComponent(query);
  const data = await (await fetch(`https://api.github.com/search/issues?q=${q}&per_page=1`, {
    headers: {
      Authorization: `Bearer ${token}`,
      'User-Agent': 'profile-readme-updater',
      Accept: 'application/vnd.github+json',
    },
  })).json();

  if (typeof data.total_count !== 'number') {
    throw new Error(`Unexpected search response for ${query}: ${JSON.stringify(data)}`);
  }
  return data.total_count;
}

async function main() {
  const totalPRs = await searchCount(`author:${owner} type:pr`);
  const mergedPRs = await searchCount(`author:${owner} type:pr is:merged`);
  const closedPRs = await searchCount(`author:${owner} type:pr is:closed`);
  const openPRs = await searchCount(`author:${owner} type:pr is:open`);

  const reviewedOutcomePRs = Math.max(closedPRs, 1);
  const acceptanceRate = ((mergedPRs / reviewedOutcomePRs) * 100).toFixed(1);

  const gql = `
    query {
      user(login: "${owner}") {
        repositoriesContributedTo(contributionTypes: [PULL_REQUEST], includeUserRepositories: true) {
          totalCount
        }
      }
    }
  `;

  const gqlData = await ghRequest(gql, true);
  const reposContributed =
    gqlData?.data?.user?.repositoriesContributedTo?.totalCount ?? 0;

  const now = new Date().toISOString().replace('T', ' ').replace('Z', ' UTC');

  const statsBlock = [
    `- 📦 Total PRs opened: **${totalPRs}**`,
    `- ✅ PRs merged: **${mergedPRs}**`,
    `- 🟢 PRs open now: **${openPRs}**`,
    `- 🎯 Acceptance rate (merged / closed): **${acceptanceRate}%**`,
    `- 🧭 Repositories contributed via PRs: **${reposContributed}**`,
    `- 🕒 Last updated: **${now}**`,
  ].join('\n');

  const readmePath = new URL('../README.md', import.meta.url);
  let readme = await fs.readFile(readmePath, 'utf8');

  const start = '<!-- STATS:START -->';
  const end = '<!-- STATS:END -->';
  const re = new RegExp(`${start}[\\s\\S]*?${end}`);
  readme = readme.replace(re, `${start}\n${statsBlock}\n${end}`);

  await fs.writeFile(readmePath, readme);
  console.log('README stats updated');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
