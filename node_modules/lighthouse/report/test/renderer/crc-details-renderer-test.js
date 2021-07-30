/**
 * @license Copyright 2017 The Lighthouse Authors. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */
'use strict';

/* eslint-env jest */

const assert = require('assert').strict;
const jsdom = require('jsdom');
const reportAssets = require('../../report-assets.js');
const Util = require('../../renderer/util.js');
const I18n = require('../../renderer/i18n.js');
const DOM = require('../../renderer/dom.js');
const DetailsRenderer = require('../../renderer/details-renderer.js');
const CriticalRequestChainRenderer = require('../../renderer/crc-details-renderer.js');

const superLongURL =
    'https://example.com/thisIsASuperLongURLThatWillTriggerFilenameTruncationWhichWeWantToTest.js';
const DETAILS = {
  type: 'criticalrequestchain',
  chains: {
    0: {
      request: {
        endTime: 1,
        responseReceivedTime: 5,
        startTime: 0,
        url: 'https://example.com/',
        transferSize: 1000,
      },
      children: {
        1: {
          request: {
            endTime: 16,
            responseReceivedTime: 14,
            startTime: 11,
            url: 'https://example.com/b.js',
            transferSize: 2000,
          },
          children: {},
        },
        2: {
          request: {
            endTime: 17.123456789,
            responseReceivedTime: 15,
            startTime: 12,
            url: superLongURL,
            transferSize: 3000,
          },
          children: {},
        },
        3: {
          request: {
            endTime: 18,
            responseReceivedTime: 16,
            startTime: 13,
            url: 'about:blank',
            transferSize: 4000,
          },
          children: {},
        },
      },
    },
  },
  longestChain: {
    duration: 7000,
    length: 2,
    transferSize: 1,
  },
};

describe('DetailsRenderer', () => {
  let dom;
  let detailsRenderer;

  beforeAll(() => {
    global.Util = Util;
    global.Util.i18n = new I18n('en', {...Util.UIStrings});
    const {document} = new jsdom.JSDOM(reportAssets.REPORT_TEMPLATES).window;
    dom = new DOM(document);
    detailsRenderer = new DetailsRenderer(dom);
  });

  afterAll(() => {
    global.Util.i18n = undefined;
    global.Util = undefined;
  });

  it('renders tree structure', () => {
    const el = CriticalRequestChainRenderer.render(dom, dom.document(), DETAILS, detailsRenderer);
    const chains = el.querySelectorAll('.crc-node');

    // Main request
    assert.equal(chains.length, 4, 'generates correct number of chain nodes');
    assert.ok(!chains[0].querySelector('.lh-text__url-host'), 'should be no origin for root url');
    assert.equal(chains[0].querySelector('.lh-text__url a').textContent, 'https://example.com');
    assert.equal(chains[0].querySelector('.lh-text__url a').href, 'https://example.com/');
    assert.equal(chains[0].querySelector('.lh-text__url a').rel, 'noopener');
    assert.equal(chains[0].querySelector('.lh-text__url a').target, '_blank');

    // Children
    assert.ok(chains[1].querySelector('.crc-node__tree-marker .vert-right'));
    assert.equal(chains[1].querySelectorAll('.crc-node__tree-marker .right').length, 2);
    assert.equal(chains[1].querySelector('.lh-text__url a').textContent, '/b.js');
    assert.equal(chains[1].querySelector('.lh-text__url a').href, 'https://example.com/b.js');
    assert.equal(chains[1].querySelector('.lh-text__url a').rel, 'noopener');
    assert.equal(chains[1].querySelector('.lh-text__url a').target, '_blank');
    assert.equal(chains[1].querySelector('.lh-text__url-host').textContent, '(example.com)');
    const durationNodes = chains[1].querySelectorAll('.crc-node__chain-duration');
    assert.equal(durationNodes[0].textContent, ' - 5,000\xa0ms, ');
    // Note: actual transferSize is 2000 bytes but formatter formats to KiBs.
    assert.equal(durationNodes[1].textContent, '1.95\xa0KiB');
  });
});
