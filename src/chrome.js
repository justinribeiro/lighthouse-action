'use strict';

const chromeLauncher = require('chrome-launcher');
const puppeteer = require('puppeteer-core');
const lighthouse = require('lighthouse');

// via WebPageTest settings
// WPO-Foundation/webpagetest/blob/master/www/settings/connectivity.ini.sample
//
// These are divided by 8 because we need bits/s for Chrome
//
const NETWORK = {
  edge: {
    offline: false,
    latency: 840,
    downloadThroughput: 240000 / 8,
    uploadThroughput: 240000 / 8,
  },
  twog: {
    offline: false,
    latency: 800,
    downloadThroughput: 280000 / 8,
    uploadThroughput: 256000 / 8,
  },
  threegslow: {
    offline: false,
    latency: 400,
    downloadThroughput: 400000 / 8,
    uploadThroughput: 400000 / 8,
  },
  threeg: {
    offline: false,
    latency: 300,
    downloadThroughput: 1600000 / 8,
    uploadThroughput: 768000 / 8,
  },
  threegfast: {
    offline: false,
    latency: 170,
    downloadThroughput: 1600000 / 8,
    uploadThroughput: 768000 / 8,
  },
  fourg: {
    offline: false,
    latency: 170,
    downloadThroughput: 9000000 / 8,
    uploadThroughput: 9000000 / 8,
  },
  lte: {
    offline: false,
    latency: 70,
    downloadThroughput: 12000000 / 8,
    uploadThroughput: 12000000 / 8,
  },
};

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
          return client.send(
            'Network.emulateNetworkConditions',
            NETWORK[opts.connection],
          );
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
