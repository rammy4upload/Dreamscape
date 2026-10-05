import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

function isRailway() {
  return Boolean(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID);
}

export function resolvePathAgainstConfigFileDir(raw, configPath) {
  const value = String(raw || '').trim();
  if (!value) {
    return '';
  }
  if (path.isAbsolute(value)) {
    return path.resolve(value);
  }
  if (!configPath) {
    return path.resolve(value);
  }
  return path.resolve(path.dirname(path.resolve(configPath)), value);
}

export function buildPlaceIdsPayload(placeIds) {
  return {
    placeids: {
      MainPlaceId: placeIds.Main,
      BattlePlaceId: placeIds.Battle,
      TradePlaceId: placeIds.Trade,
    },
  };
}

export function resolvePlaceIdsOutputPath(config, configPath = '') {
  const gitConfig = config.placeIds?.git;
  let configuredOutputPath = config.placeIds?.outputPath || './placeids.json';

  if (isRailway() && !path.isAbsolute(configuredOutputPath)) {
    const dataDir = process.env.DATA_DIR || '/data';
    configuredOutputPath = path.join(dataDir, 'placeids.json');
  }

  const repoPathConfigured = gitConfig?.repositoryPath ? String(gitConfig.repositoryPath).trim() : '';
  const repositoryPathAbs = resolvePathAgainstConfigFileDir(repoPathConfigured, configPath);

  if (gitConfig?.enabled && repositoryPathAbs && !path.isAbsolute(configuredOutputPath)) {
    return path.join(repositoryPathAbs, configuredOutputPath);
  }

  return resolvePathAgainstConfigFileDir(configuredOutputPath, configPath);
}

export function readPlaceIdsFile(config, configPath = '') {
  const filePath = resolvePlaceIdsOutputPath(config, configPath);
  if (!fs.existsSync(filePath)) {
    return { path: filePath, exists: false, data: null };
  }

  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return { path: filePath, exists: true, data };
  } catch (error) {
    return { path: filePath, exists: true, data: null, error: error.message || String(error) };
  }
}

async function runGit(repositoryPath, args) {
  const { stdout, stderr } = await execFileAsync('git', args, {
    cwd: repositoryPath,
  });

  if (stdout.trim()) {
    console.log(stdout.trim());
  }
  if (stderr.trim()) {
    console.log(stderr.trim());
  }
}

async function pushPlaceIdsViaLocalGit(outputPathAbs, repositoryPathAbs, gitConfig) {
  const relativeOutputPath = path.relative(repositoryPathAbs, outputPathAbs);
  await runGit(repositoryPathAbs, ['add', relativeOutputPath]);

  try {
    await runGit(repositoryPathAbs, ['commit', '-m', gitConfig.commitMessage || 'Update place IDs']);
  } catch (err) {
    const outputText = `${err.stdout || ''}\n${err.stderr || ''}`;
    if (outputText.includes('nothing to commit')) {
      console.log('[INFO] No place ID changes to commit.');
      return;
    }
    throw err;
  }

  try {
    await runGit(repositoryPathAbs, ['push']);
    console.log('[SUCCESS] Published place IDs to Git.');
  } catch (err) {
    const outputText = `${err.stdout || ''}\n${err.stderr || ''}`;
    const pushRejected =
      outputText.includes('failed to push some refs') ||
      outputText.includes('fetch first') ||
      outputText.includes('non-fast-forward');

    if (!pushRejected) {
      throw err;
    }

    console.log('[WARN] placeIds.git push rejected (remote is ahead). Attempting auto-sync with pull --rebase...');
    await runGit(repositoryPathAbs, ['pull', '--rebase']);
    await runGit(repositoryPathAbs, ['push']);
    console.log('[SUCCESS] Auto-sync complete; published place IDs to Git after rebase.');
  }
}

async function pushPlaceIdsViaGitHub(json, gitConfig) {
  const token = process.env.PLACEIDS_GITHUB_TOKEN || process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error('PLACEIDS_GITHUB_TOKEN or GITHUB_TOKEN is required for GitHub place ID export.');
  }

  const owner = String(gitConfig.githubOwner || '').trim();
  const repo = String(gitConfig.githubRepo || '').trim();
  if (!owner || !repo) {
    throw new Error('placeIds.git.githubOwner and placeIds.git.githubRepo are required for GitHub export.');
  }

  const branch = String(gitConfig.githubBranch || 'main').trim();
  const filePath = String(gitConfig.githubFilePath || 'placeids.json').trim();
  const githubPath = filePath.split('/').filter(Boolean).map(encodeURIComponent).join('/');
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'PokemonBrickBronze-AutoReuploader',
  };

  const metaUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${githubPath}?ref=${encodeURIComponent(branch)}`;
  let sha;
  const existing = await fetch(metaUrl, { headers });
  if (existing.ok) {
    sha = (await existing.json()).sha;
  } else if (existing.status !== 404) {
    const body = await existing.text();
    throw new Error(`GitHub read failed (${existing.status}): ${body}`);
  }

  const putUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${githubPath}`;
  const putResponse = await fetch(putUrl, {
    method: 'PUT',
    headers: {
      ...headers,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      message: gitConfig.commitMessage || 'Update place IDs',
      content: Buffer.from(json, 'utf8').toString('base64'),
      branch,
      sha,
    }),
  });

  if (!putResponse.ok) {
    const body = await putResponse.text();
    throw new Error(`GitHub push failed (${putResponse.status}): ${body}`);
  }

  console.log(`[SUCCESS] Published place IDs to GitHub ${owner}/${repo}@${branch}:${filePath}`);
}

export async function exportPlaceIds(placeIds, config, { configPath = '' } = {}) {
  const output = buildPlaceIdsPayload(placeIds);
  const json = `${JSON.stringify(output, null, 2)}\n`;
  const outputPathAbs = resolvePlaceIdsOutputPath(config, configPath);

  fs.mkdirSync(path.dirname(outputPathAbs), { recursive: true });
  fs.writeFileSync(outputPathAbs, json);
  console.log(`[SUCCESS] Wrote place IDs to ${outputPathAbs}`);

  const gitConfig = config.placeIds?.git;
  if (!gitConfig?.enabled) {
    return { path: outputPathAbs, pushed: false };
  }

  const githubConfigured = Boolean(gitConfig.githubOwner && gitConfig.githubRepo);
  const githubToken = process.env.PLACEIDS_GITHUB_TOKEN || process.env.GITHUB_TOKEN;

  if (githubConfigured && githubToken) {
    await pushPlaceIdsViaGitHub(json, gitConfig);
    return { path: outputPathAbs, pushed: true, method: 'github' };
  }

  const repoPathConfigured = gitConfig.repositoryPath ? String(gitConfig.repositoryPath).trim() : '';
  const repositoryPathAbs = resolvePathAgainstConfigFileDir(repoPathConfigured, configPath);

  if (repositoryPathAbs && fs.existsSync(path.join(repositoryPathAbs, '.git'))) {
    await pushPlaceIdsViaLocalGit(outputPathAbs, repositoryPathAbs, gitConfig);
    return { path: outputPathAbs, pushed: true, method: 'local-git' };
  }

  if (isRailway()) {
    const missing = [];
    if (!githubToken) {
      missing.push('PLACEIDS_GITHUB_TOKEN (or GITHUB_TOKEN) in Railway variables');
    }
    if (!gitConfig.githubOwner || !gitConfig.githubRepo) {
      missing.push('placeIds.git.githubOwner and placeIds.git.githubRepo in config (Configuration tab → Save)');
    }
    console.log(
      '[WARN] placeIds.git.enabled but GitHub export is not configured. IDs saved on disk only.\n' +
        (missing.length
          ? `         Missing: ${missing.join('; ')}.\n`
          : '') +
        '         Or fetch from Railway: GET /api/placeids with Authorization: Bearer <API_KEY>.'
    );
  } else {
    console.log(
      '[WARN] placeIds.git.enabled but no GitHub token/repo and no local git repository found. IDs saved on disk only.'
    );
  }

  return { path: outputPathAbs, pushed: false };
}

export async function pushExistingPlaceIds(config, { configPath = '' } = {}) {
  const { path: filePath, exists, data } = readPlaceIdsFile(config, configPath);
  if (!exists || !data) {
    throw new Error('No placeids.json found to push.');
  }

  const gitConfig = config.placeIds?.git;
  if (!gitConfig?.enabled) {
    throw new Error('placeIds.git.enabled is false in config.');
  }

  const json = `${JSON.stringify(data, null, 2)}\n`;
  const githubConfigured = Boolean(gitConfig.githubOwner && gitConfig.githubRepo);
  const githubToken = process.env.PLACEIDS_GITHUB_TOKEN || process.env.GITHUB_TOKEN;

  if (githubConfigured && githubToken) {
    await pushPlaceIdsViaGitHub(json, gitConfig);
    return { path: filePath, pushed: true, method: 'github' };
  }

  const repoPathConfigured = gitConfig.repositoryPath ? String(gitConfig.repositoryPath).trim() : '';
  const repositoryPathAbs = resolvePathAgainstConfigFileDir(repoPathConfigured, configPath);
  if (repositoryPathAbs && fs.existsSync(path.join(repositoryPathAbs, '.git'))) {
    await pushPlaceIdsViaLocalGit(filePath, repositoryPathAbs, gitConfig);
    return { path: filePath, pushed: true, method: 'local-git' };
  }

  throw new Error(
    'Configure PLACEIDS_GITHUB_TOKEN + placeIds.git.githubOwner/githubRepo for Railway, or mount a git repo at placeIds.git.repositoryPath.'
  );
}
