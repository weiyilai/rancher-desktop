/**
 * This script is a wrapper to run TypeScript scripts via tsx.  This is mostly
 * to set defaults for our tools, such as disabling BrowsersList updates and
 * showing deprecations.
 */

const { spawnSync } = require('node:child_process');

function main(args) {
  const childArgs = [
    '--trace-warnings',
    '--trace-deprecation',
    'node_modules/tsx/dist/cli.mjs',
    '--conditions=import',
  ];

  const finalArgs = [...childArgs, ...args];

  console.log(process.argv0, ...finalArgs);
  const result = spawnSync(process.argv0, finalArgs, { stdio: 'inherit' });

  if (result.error) {
    throw result.error;
  }

  if (typeof result.status === 'number') {
    process.exit(result.status);
  }

  if (result.signal) {
    console.log(`Process exited with signal ${ result.signal }`);
    process.exit(-1);
  }
}

if (require.main === module) {
  // Silence BrowsersList warnings because they're pointless for us
  process.env.BROWSERSLIST_IGNORE_OLD_DATA = 'true'; // spellcheck-ignore-line
  main(process.argv.slice(2));
}
