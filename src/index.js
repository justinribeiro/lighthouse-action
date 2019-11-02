'use strict';

const core = require('@actions/core');
const github = require('@actions/github');

// My Puppeteer + WPT variant setup
const {launchChromeAndRunLighthouse} = require('./chrome');
const {getLighthouseConfiguration} = require('./config');
const {
  postResultsToPullRequest,
  writeResultsToFileSystem,
  writeResultsToConsole,
} = require('./utils');
const {checkIfActionShouldFail} = require('./checks');

async function main() {
  const url = core.getInput('url');
  const secret = core.getInput('secret');
  const wptProfile = core.getInput('wptConnectionSpeed') || 'threegfast';

  if (!url) {
    throw new Error(
      'URL is not defined; cannot run Lighthouse audit. Please check your Github Action definition.',
    );
  }

  if (!secret) {
    core.warning('secret not defined; PR comment reporting disabled.');
  }

  const opts = getLighthouseConfiguration();

  const {report, lhr} = await launchChromeAndRunLighthouse(
    url,
    opts,
    opts.lighthouseConfig,
  );

  writeResultsToConsole(lhr, wptProfile);
  await writeResultsToFileSystem(report, lhr, core);
  await postResultsToPullRequest(lhr, wptProfile, github, secret);
  checkIfActionShouldFail(lhr, core);
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
