'use strict';

const chromeLauncher = require('chrome-launcher');
const puppeteer = require('puppeteer-core');
const lighthouse = require('lighthouse');

/**
 * Adjustments needed for DevTools network throttling to simulate
 * more realistic network conditions, per Lighthouse:
 * https://github.com/GoogleChrome/lighthouse/blob/6e5fc878f8cc69e00620b20092bfad1da6c1e4e2/lighthouse-core/config/constants.js#L8-L15
 *
 * @see https://crbug.com/721112
 * @see https://docs.google.com/document/d/10lfVdS1iDWCRKQXPfbxEn4Or99D64mvNlugP1AQuFlE/edit
 *
 * Cheers @patrickhulce for the heads up! :-)
 */
const DEVTOOLS_RTT_ADJUSTMENT_FACTOR = 3.75;
const DEVTOOLS_THROUGHPUT_ADJUSTMENT_FACTOR = 0.9;

// Per https://chromium.googlesource.com/chromium/src/+/8a4e4200086bc67a61c83d60edfb450844377e5a/third_party/WebKit/Source/devtools/front_end/network_conditions/NetworkConditionsSelector.js#222
const CHROME_SLOW_RTT_ADJUSTMENT_FACTOR = 5;
const CHROME_SLOW_THROUGHPUT_ADJUSTMENT_FACTOR = 0.8;

/**
 * via WebPageTest settings
 * https://github.com/WPO-Foundation/webpagetest/blob/master/www/settings/connectivity.ini.sample
 */
const NETWORK = {
  edge: {
    offline: false,
    latency: 840,
    downloadThroughput: 240000,
    uploadThroughput: 240000,
    rttAdjustFactor: CHROME_SLOW_RTT_ADJUSTMENT_FACTOR,
    throughputAdjustment: CHROME_SLOW_THROUGHPUT_ADJUSTMENT_FACTOR,
  },
  twog: {
    offline: false,
    latency: 800,
    downloadThroughput: 280000,
    uploadThroughput: 256000,
    rttAdjustFactor: CHROME_SLOW_RTT_ADJUSTMENT_FACTOR,
    throughputAdjustment: CHROME_SLOW_THROUGHPUT_ADJUSTMENT_FACTOR,
  },
  threegslow: {
    offline: false,
    latency: 400,
    downloadThroughput: 400000,
    uploadThroughput: 400000,
    rttAdjustFactor: CHROME_SLOW_RTT_ADJUSTMENT_FACTOR,
    throughputAdjustment: CHROME_SLOW_THROUGHPUT_ADJUSTMENT_FACTOR,
  },
  threeg: {
    offline: false,
    latency: 300,
    downloadThroughput: 1600000,
    uploadThroughput: 768000,
    rttAdjustFactor: DEVTOOLS_RTT_ADJUSTMENT_FACTOR,
    throughputAdjustment: DEVTOOLS_THROUGHPUT_ADJUSTMENT_FACTOR,
  },
  threegfast: {
    offline: false,
    latency: 170,
    downloadThroughput: 1600000,
    uploadThroughput: 768000,
    rttAdjustFactor: DEVTOOLS_RTT_ADJUSTMENT_FACTOR,
    throughputAdjustment: DEVTOOLS_THROUGHPUT_ADJUSTMENT_FACTOR,
  },
  fourg: {
    offline: false,
    latency: 170,
    downloadThroughput: 9000000,
    uploadThroughput: 9000000,
    rttAdjustFactor: DEVTOOLS_RTT_ADJUSTMENT_FACTOR,
    throughputAdjustment: DEVTOOLS_THROUGHPUT_ADJUSTMENT_FACTOR,
  },
  lte: {
    offline: false,
    latency: 70,
    downloadThroughput: 12000000,
    uploadThroughput: 12000000,
    rttAdjustFactor: DEVTOOLS_RTT_ADJUSTMENT_FACTOR,
    throughputAdjustment: DEVTOOLS_THROUGHPUT_ADJUSTMENT_FACTOR,
  },
};

function withDevToolsThroughputAdjustment(bits, factor) {
  return Math.floor((bits / 8) * factor);
}

function withDevToolsRttAdjustment(ms, factor) {
  return ms * factor;
}

/**
 * launch Chrome via Puppeteer, use puppeteer to throttle connection, run
 * lighthouse. Not ideal; would prefer adv throttle via comcast os level util
 * @param {string} url
 * @param {object} opts
 * @param {object} config
 * @return {promise}
 */
async function launchChromeAndRunLighthouse(url, opts, config) {
  // eslint-disable-next-line no-unused-vars
  const chrome = await chromeLauncher.launch({
    port: 9222,
    logLevel: 'silent',
    chromeFlags: ['--headless', '--disable-gpu'],
  });

  const browser = await puppeteer.connect({
    browserURL: 'http://localhost:9222',
  });

  browser.on('targetchanged', async target => {
    const page = await target.page();

    if (NETWORK[opts.connection]) {
      await page
        .target()
        .createCDPSession()
        .then(client => {
          console.log(
            `CDP: network conditions set to WPT ${opts.connection} profile.`,
          );
          return client.send('Network.emulateNetworkConditions', {
            offline: NETWORK[opts.connection].offline,
            latency: withDevToolsRttAdjustment(
              NETWORK[opts.connection].latency,
              NETWORK[opts.connection].rttAdjustFactor,
            ),
            downloadThroughput: withDevToolsThroughputAdjustment(
              NETWORK[opts.connection].downloadThroughput,
              NETWORK[opts.connection].throughputAdjustment,
            ),
            uploadThroughput: withDevToolsThroughputAdjustment(
              NETWORK[opts.connection].uploadThroughput,
              NETWORK[opts.connection].throughputAdjustment,
            ),
          });
        })
        .catch(err => console.error(err));
    } else {
      console.log(`CDP: network conditions set to custom Lighthouse profile.`);
    }
  });

  opts.port = new URL(browser.wsEndpoint()).port;
  return lighthouse(url, opts, config)
    .then(results => {
      return browser.close().then(() => results);
    })
    .catch(err => {
      return browser.close().then(() => {
        throw err;
      }, console.error);
    });
}

module.exports = {
  launchChromeAndRunLighthouse: launchChromeAndRunLighthouse,
};
