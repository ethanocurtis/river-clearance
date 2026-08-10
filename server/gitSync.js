// Auto-commits + pushes admin data edits (docs/data/bridges.json,
// docs/data/gauges.json) back to GitHub, so the admin panel is never a
// silent source of drift between the live site and the repo.
//
// Requires the whole git repo (not just docs/) to be mounted into the
// container at REPO_DIR, and a GitHub token with write access to it -- see
// "Auto-committing admin edits to GitHub" in README.md for how to set both
// up. Entirely optional: if REPO_DIR/GIT_PUSH_TOKEN aren't set, every call
// here is a no-op and the admin API falls back to file-only saves exactly
// as before.

const { execFile } = require('child_process');

const REPO_DIR = process.env.REPO_DIR || '';
const GIT_PUSH_TOKEN = process.env.GIT_PUSH_TOKEN || '';
const GIT_COMMIT_NAME = process.env.GIT_COMMIT_NAME || 'River Clearance Admin';
const GIT_COMMIT_EMAIL = process.env.GIT_COMMIT_EMAIL || 'admin@localhost';

const enabled = Boolean(REPO_DIR && GIT_PUSH_TOKEN);

function run(args) {
  return new Promise((resolve, reject) => {
    // execFile (not exec) -- args are a plain array, never shell-interpolated,
    // so there's no injection risk even though this runs against the real
    // repo with push access.
    execFile('git', args, { cwd: REPO_DIR, timeout: 30_000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || err.message).trim()));
      resolve(stdout);
    });
  });
}

async function pushUrlFor(originUrl) {
  const m = originUrl.trim().match(/github\.com[:/](.+?)(\.git)?$/);
  if (!m) throw new Error(`Could not parse a GitHub owner/repo out of origin URL: ${originUrl}`);
  return `https://x-access-token:${GIT_PUSH_TOKEN}@github.com/${m[1]}.git`;
}

// Commits + pushes ONE specific relative file path (e.g. "docs/data/bridges.json")
// -- deliberately never `git add -A`, so an unrelated dirty file elsewhere in
// the working tree (e.g. a hand-edited docker-compose.yml) never gets swept
// into this commit or pushed.
async function commitAndPush(relativeFilePath, message) {
  if (!enabled) return { skipped: true, reason: 'not_configured' };

  await run(['add', '--', relativeFilePath]);
  const status = await run(['status', '--porcelain', '--', relativeFilePath]);
  if (!status.trim()) return { skipped: true, reason: 'no_changes' };

  await run([
    '-c', `user.name=${GIT_COMMIT_NAME}`,
    '-c', `user.email=${GIT_COMMIT_EMAIL}`,
    'commit', '-m', message, '--', relativeFilePath,
  ]);

  const origin = await run(['remote', 'get-url', 'origin']);
  const pushUrl = await pushUrlFor(origin);
  const branch = (await run(['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  await run(['push', pushUrl, `HEAD:${branch}`]);

  return { committed: true, pushed: true, branch };
}

module.exports = { commitAndPush, enabled };
