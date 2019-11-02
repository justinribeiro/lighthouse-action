'use strict';

const core = require('@actions/core');
const github = require('@actions/github');

// My Puppeteer + WPT variant setup
const {launchChromeAndRunLighthouse} = require('./chrome');
const {
  postResultsToPullRequest,
  writeResultsToFileSystem,
  writeResultsToConsole,
} = require('./utils');

async function main() {
  const url = core.getInput('url');
  const secret = core.getInput('secret');
  const wptProfile = core.getInput('wptConnectionSpeed') || 'threegfast';

  const opts = {
    lighthouseConfig: {
      extends: 'lighthouse:default',
      settings: {},
    },
    disableNetworkThrottling: true,
    disableStorageReset: true,
    emulatedFormFactor: 'mobile',
    throttlingMethod: 'provided',
    connection: wptProfile,
    output: ['json', 'html'],
  };

  const {report, lhr} = await launchChromeAndRunLighthouse(
    url,
    opts,
    opts.lighthouseConfig,
  );

  writeResultsToConsole(lhr, wptProfile);
  await writeResultsToFileSystem(report, lhr, core);
  await postResultsToPullRequest(lhr, wptProfile, github, secret);
}

main()
  .catch(err => {
    core.setFailed(err.message);
    process.exit(1);
  })
  .then(() => {
    console.log(`Completed in ${process.uptime()}s.`);
    process.exit();
  });
