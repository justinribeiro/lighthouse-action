'use strict';

const core = require('@actions/core');
const github = require('@actions/github');

// My Puppeteer + WPT variant setup
const {launchChromeAndRunLighthouse} = require('./chrome');
const {writeResultsToFileSystem, writeResultsToConsole} = require('./utils');

async function main() {
  const url = core.getInput('url');

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

  const payload = JSON.stringify(github.context.payload, undefined, 2);
  console.log(`The event payload: ${payload}`);
  console.log(github.context.payload.pull_request.comments_url);
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
