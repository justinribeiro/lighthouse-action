'use strict';

const chromeLauncher = require('chrome-launcher');
const puppeteer = require('puppeteer-core');
const lighthouse = require('lighthouse');

// via WebPageTest settings
// WPO-Foundation/webpagetest/blob/master/www/settings/connectivity.ini.sample
const NETWORK = {
  edge: {
    offline: false,
    latency: 840,
    downloadThroughput: 240000,
    uploadThroughput: 240000,
  },
  twog: {
    offline: false,
    latency: 800,
    downloadThroughput: 280000,
    uploadThroughput: 256000,
  },
  threegslow: {
    offline: false,
    latency: 400,
    downloadThroughput: 400000,
    uploadThroughput: 400000,
  },
  threeg: {
    offline: false,
    latency: 300,
    downloadThroughput: 1600000,
    uploadThroughput: 768000,
  },
  threegfast: {
    offline: false,
    latency: 170,
    downloadThroughput: 1600000,
    uploadThroughput: 768000,
  },
  fourg: {
    offline: false,
    latency: 150,
    downloadThroughput: 9000000,
    uploadThroughput: 9000000,
  },
  lte: {
    offline: false,
    latency: 70,
    downloadThroughput: 12000000,
    uploadThroughput: 12000000,
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

    if (page && page.target().url() === url) {
      await page
        .target()
        .createCDPSession()
        .then(client => {
          if (NETWORK[opts.connection]) {
            return client.send(
              'Network.emulateNetworkConditions',
              NETWORK[opts.connection],
            );
          } else {
            return client.send();
          }
        })
        .catch(err => console.error(err));

      console.log(
        `CDP: network conditions set to WPT ${opts.connection} profile`,
      );
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
