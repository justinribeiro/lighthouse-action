'use strict';

import {postResultsToPullRequest} from './utils';

const core = require('@actions/core');
const github = require('@actions/github');

// My Puppeteer + WPT variant setup
const {launchChromeAndRunLighthouse} = require('./chrome');
const {writeResultsToFileSystem, writeResultsToConsole} = require('./utils');

async function main() {
  const url = core.getInput('url');
  const secret = core.getInput('secret');

  const opts = {
    lighthouseConfig: {
      extends: 'lighthouse:default',
      settings: {},
    },
    disableNetworkThrottling: true,
    disableStorageReset: true,
    emulatedFormFactor: 'mobile',
    throttlingMethod: 'provided',
    connection: core.getInput('wptConnectionSpeed'),
  };

  const {report, lhr} = await launchChromeAndRunLighthouse(
    url,
    opts,
    opts.lighthouseConfig,
  );
  writeResultsToConsole(lhr);
  writeResultsToFileSystem(report, lhr, core);
  postResultsToPullRequest(lhr, github, secret);
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
