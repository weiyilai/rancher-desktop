// A cross-platform script to create PRs that bump versions of dependencies.

import { spawnSync } from 'child_process';
import path from 'path';

import { Octokit } from 'octokit';
import semver from 'semver';

import { Lima, Qemu, SocketVMNet, AlpineLimaISO } from 'scripts/dependencies/lima';
import { MobyOpenAPISpec } from 'scripts/dependencies/moby-openapi';
import * as tools from 'scripts/dependencies/tools';
import { Wix } from 'scripts/dependencies/wix';
import { WSLDistro, Moproxy } from 'scripts/dependencies/wsl';
import {
  DependencyVersions, readDependencyVersions, writeDependencyVersions, Dependency, AlpineLimaISOVersion, getOctokit,
  IsGitHubDependency,
  iterateIterator,
} from 'scripts/lib/dependencies';

const MAIN_BRANCH = 'main';
const GITHUB_OWNER = process.env.GITHUB_REPOSITORY?.split('/')[0] || 'rancher-sandbox';
const GITHUB_REPO = process.env.GITHUB_REPOSITORY?.split('/')[1] || 'rancher-desktop';
const DEP_VERSIONS_PATH = path.join('pkg', 'rancher-desktop', 'assets', 'dependencies.yaml');

type VersionComparison = {
  dependency: Dependency;
  currentVersion: string | AlpineLimaISOVersion;
  latestVersion: string | AlpineLimaISOVersion;
};

const dependencies: Dependency[] = [
  new tools.KuberlrAndKubectl(),
  new tools.Helm(),
  new tools.DockerCLI(),
  new tools.DockerBuildx(),
  new tools.DockerCompose(),
  new tools.DockerProvidedCredHelpers(),
  new tools.GoLangCILint(),
  new tools.CheckSpelling(),
  new tools.Trivy(),
  new tools.Steve(),
  new tools.RancherDashboard(),
  new tools.ECRCredHelper(),
  new Lima(),
  new Qemu(),
  new SocketVMNet(),
  new AlpineLimaISO(),
  new WSLDistro(),
  new Wix(),
  new MobyOpenAPISpec(),
  new Moproxy(),
  new tools.WasmShims(),
  new tools.CertManager(),
  new tools.SpinOperator(),
  new tools.SpinCLI(),
  new tools.SpinKubePlugin(),
];

/**
 * Run a git command line.  If the first argument is `true`, return the exit
 * code.  Otherwise, throw an error if the command did not exit with `0`.
 */
function git(...args: string[]): 0 | null;
function git(returnStatus: true, ...args: string[]): number | null;
function git(returnOrArg: string | true, ...args: string[]): number | null {
  const name = 'Rancher Desktop Dependency Manager';
  const email = 'donotuse@rancherdesktop.io';

  if (typeof returnOrArg === 'string') {
    args.unshift(returnOrArg);
  }

  const result = spawnSync('git', args, {
    stdio: 'inherit',
    env:   {
      ...process.env,
      GIT_AUTHOR_NAME:     name,
      GIT_AUTHOR_EMAIL:    email,
      GIT_COMMITTER_NAME:  name,
      GIT_COMMITTER_EMAIL: email,
    },
  });

  if (result.error) {
    throw result.error;
  }

  if (returnOrArg !== true && result.status) {
    throw `git returned error code ${ result.status }`;
  }

  return result.status;
}

function printable(version: string | AlpineLimaISOVersion): string {
  return typeof version === 'string' ? version : version.isoVersion;
}

function getBranchName(name: string, currentVersion: string | AlpineLimaISOVersion, latestVersion: string | AlpineLimaISOVersion): string {
  return `rddepman/${ name }/${ printable(currentVersion) }-to-${ printable(latestVersion) }`;
}

function getTitle(name: string, currentVersion: string | AlpineLimaISOVersion, latestVersion: string | AlpineLimaISOVersion): string {
  return `rddepman: bump ${ name } from ${ printable(currentVersion) } to ${ printable(latestVersion) }`;
}

async function getBody(dependency: Dependency, currentVersion: string | AlpineLimaISOVersion, latestVersion: string | AlpineLimaISOVersion): Promise<string> {
  if (!IsGitHubDependency(dependency) || typeof currentVersion !== 'string' || typeof latestVersion !== 'string') {
    // If the dependency is not on GitHub, we don't have any additional information yet.
    return '';
  }
  const currentSemver = semver.parse(currentVersion, true);
  const latestSemver = semver.parse(latestVersion, true);

  if (!currentSemver || !latestSemver) {
    console.log(`Can't parse ${ dependency.name } current or latest version ${ currentVersion } / ${ latestVersion }`);

    return '';
  }

  type releaseType = Awaited<ReturnType<Octokit['rest']['repos']['listReleases']>>['data'][number];
  const releaseIterator = getOctokit().paginate.iterator(
    getOctokit().rest.repos.listReleases,
    { owner: dependency.githubOwner, repo: dependency.githubRepo });
  const releaseNotes: [semver.SemVer, releaseType][] = [];

  for await (const release of iterateIterator(releaseIterator, r => r.data)) {
    const version = semver.parse(release.tag_name, true);

    if (!version) {
      if (release.tag_name === dependency.versionToTagName(currentVersion)) {
        // Version cannot be parsed, but it's the current version.
        break;
      }
      console.log(`Ignoring non-semver ${ dependency.name } version ${ release.tag_name }`);
      continue;
    }
    if (semver.eq(version, currentSemver)) {
      // Found the current version, don't look at anything older.
      break;
    }
    if (semver.lt(version, currentSemver)) {
      // Found a patch release of the previous version, or similar.
      continue;
    }
    if (semver.gt(version, latestSemver)) {
      // Found a version after the latest version (alpha or similar).
      continue;
    }
    if (version.prerelease.length && !latestSemver.prerelease.length) {
      // This is a pre-release, but the release we're picking is not a pre-release.
      continue;
    }
    releaseNotes.push([version, release]);
  }

  releaseNotes.sort(([a], [b]) => semver.compare(a, b));

  return releaseNotes.map(([, release]) => {
    const body = release.body || `Release ${ release.name } does not have release notes.`;

    if (releaseNotes.length > 1) {
      // Make sure we don't have leading spaces or this turns into <pre>.
      return [
        '<details>',
        `<summary><h3>${ release.name } (${ release.tag_name })</h3></summary>`,
        '',
        body,
        '</details>',
      ].join('\n');
    }

    return `## ${ release.name } (${ release.tag_name })\n${ body }\n`;
  }).join('\n');
}

async function createDependencyBumpPR(dependency: Dependency, currentVersion: string | AlpineLimaISOVersion, latestVersion: string | AlpineLimaISOVersion): Promise<void> {
  const title = getTitle(dependency.name, currentVersion, latestVersion);
  const branchName = getBranchName(dependency.name, currentVersion, latestVersion);

  console.log(`Creating PR "${ title }".`);
  try {
    await getOctokit().rest.pulls.create({
      owner: GITHUB_OWNER,
      repo:  GITHUB_REPO,
      title,
      body:  await getBody(dependency, currentVersion, latestVersion),
      base:  MAIN_BRANCH,
      head:  branchName,
    });
  } catch (err: any) {
    console.log(JSON.stringify(err.response?.data, undefined, 2));
    throw err;
  }
}

type PRSearchFn = ReturnType<Octokit['rest']['search']['issuesAndPullRequests']>;

async function getPulls(name: string): Promise<Awaited<PRSearchFn>['data']['items']> {
  const queryString = `type:pr repo:${ GITHUB_OWNER }/${ GITHUB_REPO } head:rddepman/${ name } sort:updated`;
  const pullsIterator = getOctokit().paginate.iterator(
    getOctokit().rest.search.issuesAndPullRequests,
    { q: queryString });
  const results: Awaited<PRSearchFn>['data']['items'] = [];

  for await (const item of iterateIterator(pullsIterator, p => p.data)) {
    if (!item.pull_request) {
      continue;
    }
    const { data: pr } = await getOctokit().rest.pulls.get({
      owner: GITHUB_OWNER, repo: GITHUB_REPO, pull_number: item.number,
    });

    if (pr.head.repo && pr.head.repo.full_name !== `${ GITHUB_OWNER }/${ GITHUB_REPO }`) {
      // Ignore cross-repo PRs; they're not automatically generated.
      continue;
    }
    results.push(item);
  }

  return results;
}

async function determineUpdatesAvailable(): Promise<VersionComparison[]> {
  // load current versions of dependencies
  const currentVersions = await readDependencyVersions(DEP_VERSIONS_PATH);

  // get a list of dependencies' version comparisons
  const versionComparisons: VersionComparison[] = await Promise.all(dependencies.map(async(dependency) => {
    const availableVersions = await dependency.getAvailableVersions();

    const sortedVersions = availableVersions.sort((version1, version2) => {
      return dependency.rcompareVersions(version1, version2);
    });
    const latestVersion = sortedVersions[0];

    return {
      dependency,
      currentVersion: currentVersions[dependency.name as keyof DependencyVersions],
      latestVersion,
    };
  }));

  // filter comparisons down to the ones that need an update
  const updatesAvailable = versionComparisons.filter(({ dependency, currentVersion, latestVersion }) => {
    const comparison = dependency.rcompareVersions(currentVersion, latestVersion);

    if (comparison < 0) {
      console.warn(`Latest version ${ JSON.stringify(latestVersion) } of ${ dependency.name } is earlier than current version ${ JSON.stringify(currentVersion) }`);
    } else if (comparison === 0) {
      console.log(`${ dependency.name } is up to date.`);
    } else {
      console.log(`Can update ${ dependency.name } from ${ JSON.stringify(currentVersion) } to ${ JSON.stringify(latestVersion) }`);
    }

    return comparison > 0;
  });

  return updatesAvailable;
}

async function checkDependencies(): Promise<void> {
  // exit if there are unstaged changes
  git('update-index', '--refresh');
  if (git(true, 'diff-index', '--quiet', 'HEAD', '--')) {
    console.log('You have unstaged changes. Commit or stash them to manage dependencies.');

    return;
  }

  if (process.env.CI) {
    // When in CI, make sure we compare against the main branch.
    git('switch', '--force-create', 'main', 'origin/main');
  }

  const updatesAvailable = await determineUpdatesAvailable();

  if (!process.env.CI) {
    // When not running in CI, don't try to make pull requests.
    if (updatesAvailable.length) {
      console.log(`Not running in CI, skipping creation of ${ updatesAvailable.length } pull requests.`);
    }

    return;
  }

  // reconcile dependencies that need an update with state of repo's PRs
  const needToCreatePR: VersionComparison[] = [];

  await Promise.all(updatesAvailable.map(async({ dependency, currentVersion, latestVersion }) => {
    // try to find PR for this combo of name, current version and latest version
    const prs = await getPulls(dependency.name);

    // we use title, rather than branch name, to filter pull requests
    // because branch name is not available from the search endpoint
    const title = getTitle(dependency.name, currentVersion, latestVersion);
    let prExists = false;

    await Promise.all(prs.map(async(pr) => {
      if (pr.title !== title && pr.state === 'open') {
        console.log(`Closing stale PR "${ pr.title }" (#${ pr.number }).`);
        await getOctokit().rest.pulls.update({
          owner: GITHUB_OWNER, repo: GITHUB_REPO, pull_number: pr.number, state: 'closed',
        });
      } else if (pr.title === title) {
        console.log(`Found existing PR "${ title }" (#${ pr.number }).`);
        prExists = true;
      }
    }));
    if (!prExists) {
      console.log(`Could not find PR "${ title }". Will create.`);
      needToCreatePR.push({
        dependency, currentVersion, latestVersion,
      });
    }
  }));

  // create a branch for each version update, make changes, and make a PR from the branch
  for (const { dependency, currentVersion, latestVersion } of needToCreatePR) {
    const branchName = getBranchName(dependency.name, currentVersion, latestVersion);
    const commitMessage = `Bump ${ dependency.name } from ${ printable(currentVersion) } to ${ printable(latestVersion) }`;

    git('checkout', '-b', branchName, MAIN_BRANCH);
    const depVersions = await readDependencyVersions(DEP_VERSIONS_PATH);

    depVersions[dependency.name as keyof DependencyVersions] = latestVersion as string & AlpineLimaISOVersion;
    await writeDependencyVersions(DEP_VERSIONS_PATH, depVersions);
    git('add', DEP_VERSIONS_PATH);
    git('commit', '--signoff', '--message', commitMessage);
    git('push', '--force', `https://${ process.env.GITHUB_TOKEN }@github.com/${ GITHUB_OWNER }/${ GITHUB_REPO }`);
    await createDependencyBumpPR(dependency, currentVersion, latestVersion);
  }
}

(async() => {
  await checkDependencies();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
