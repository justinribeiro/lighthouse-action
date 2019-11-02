'use strict';

const fs = require('fs');
const {join} = require('path');

function defaultLighthouseConfiguration(wptProfile) {
  return {
    lighthouseConfig: {
      extends: 'lighthouse:default',
      settings: {},
    },
    disableNetworkThrottling: true,
    disableStorageReset: true,
    emulatedFormFactor: 'mobile',
    throttlingMethod: 'devtools',
    throttling: {
      requestLatencyMs: 0,
      downloadThroughputKbps: 0,
      uploadThroughputKbps: 0,
    },
    logLevel: 'info',
    connection: wptProfile || 'threegfast',
    output: 'html',
  };
}

function getLighthouseConfiguration(core) {
  const wptProfile = core.getInput('wptConnectionSpeed');
  let configuration;
  const lhConfigurationFile = core.getInput('lighthouseConfiguration');
  try {
    if (
      lhConfigurationFile &&
      fs.existsSync(join(process.cwd(), lhConfigurationFile))
    ) {
      configuration = require(join(process.cwd(), lhConfigurationFile));
    }

    // If they pass both a custom config and a WPT profile, then we assume they
    // want to use WPT profile...though I'm not sure as to this need
    if (wptProfile) {
      configuration.connection = wptProfile;
    }
  } catch (error) {
    configuration = defaultLighthouseConfiguration(wptProfile);
  }

  const budget = getCustomLighthouseBudget(core);
  if (budget) {
    configuration.budgets = budget;
  }

  return configuration;
}

function getCustomLighthouseBudget(core) {
  const lhBudgetFile = core.getInput('lighthouseBudget');
  try {
    if (lhBudgetFile && fs.existsSync(join(process.cwd(), lhBudgetFile))) {
      return require(join(process.cwd(), lhBudgetFile));
    }
  } catch (error) {
    return null;
  }
}

module.exports = {
  getLighthouseConfiguration: getLighthouseConfiguration,
};
