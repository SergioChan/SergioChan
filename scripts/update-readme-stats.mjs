import fs from 'node:fs/promises';

const owner = process.env.PROFILE_OWNER || 'SergioChan';
const token = process.env.GITHUB_TOKEN;

if (!token) throw new Error('GITHUB_TOKEN is required');

async function searchCount(query) {
  const q = encodeURIComponent(query);
  const res = await fetch(`https://api.github.com/search/issues?q=${q}&per_page=1`, {
    headers: {
      Authorization: `Bearer ${token}`,
      'User-Agent': 'profile-readme-updater',
      Accept: 'application/vnd.github+json',
    },
  });
  if (!res.ok) throw new Error(`Search failed ${res.status}: ${await res.text()}`);
  const data = await res.json();
  if (typeof data.total_count !== 'number') {
    throw new Error(`Unexpected search response for ${query}: ${JSON.stringify(data)}`);
  }
  return data.total_count;
}

async function gql(query) {
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'User-Agent': 'profile-readme-updater',
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query }),
  });
  if (!res.ok) throw new Error(`GraphQL failed ${res.status}: ${await res.text()}`);
  return res.json();
}

function isoDaysAgo(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

async function main() {
  const totalPRs = await searchCount(`author:${owner} type:pr`);
  const mergedPRs = await searchCount(`author:${owner} type:pr is:merged`);
  const closedPRs = await searchCount(`author:${owner} type:pr is:closed`);
  const openPRs = await searchCount(`author:${owner} type:pr is:open`);

  const prs30d = await searchCount(`author:${owner} type:pr created:>=${isoDaysAgo(30)}`);
  const merged30d = await searchCount(`author:${owner} type:pr is:merged merged:>=${isoDaysAgo(30)}`);

  const acceptanceRate = ((mergedPRs / Math.max(closedPRs, 1)) * 100).toFixed(1);

  const contribQuery = `
    query {
      user(login: "${owner}") {
        repositoriesContributedTo(contributionTypes: [PULL_REQUEST], includeUserRepositories: true) {
          totalCount
        }
      }
    }
  `;
  const contribData = await gql(contribQuery);
  const reposContributed = contribData?.data?.user?.repositoriesContributedTo?.totalCount ?? 0;

  const now = new Date().toISOString().replace('T', ' ').replace('Z', ' UTC');

  const statsBlock = [
    `- 📦 **Total PRs opened:** ${totalPRs}`,
    `- ✅ **PRs merged:** ${mergedPRs}`,
    `- 🟢 **Open PRs now:** ${openPRs}`,
    `- 🎯 **Acceptance rate (merged / closed):** ${acceptanceRate}%`,
    `- 🧭 **Repos contributed via PRs:** ${reposContributed}`,
    `- ⚡ **PRs opened (last 30d):** ${prs30d}`,
    `- 🔥 **PRs merged (last 30d):** ${merged30d}`,
    `- 🕒 **Last updated:** ${now}`,
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
