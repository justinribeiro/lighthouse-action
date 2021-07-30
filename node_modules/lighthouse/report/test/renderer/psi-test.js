/**
 * @license Copyright 2017 The Lighthouse Authors. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */
'use strict';

const assert = require('assert').strict;
const fs = require('fs');

const jsdom = require('jsdom');

const testUtils = require('../../../lighthouse-core/test/test-utils.js');
const reportAssets = require('../../report-assets.js');
const prepareLabData = require('../../renderer/psi.js');
const Util = require('../../renderer/util.js');
const I18n = require('../../renderer/i18n.js');
const DOM = require('../../renderer/dom.js');
const CategoryRenderer = require('../../renderer/category-renderer.js');
const DetailsRenderer = require('../../renderer/details-renderer.js');
const CriticalRequestChainRenderer = require('../../renderer/crc-details-renderer.js');
const ElementScreenshotRenderer = require('../../renderer/element-screenshot-renderer.js');
const ReportUIFeatures = require('../../renderer/report-ui-features.js');
const {LH_ROOT} = require('../../../root.js');

const {itIfProtoExists, sampleResultsRoundtripStr} = testUtils.getProtoRoundTrip();
const sampleResultsStr =
  fs.readFileSync(LH_ROOT + '/lighthouse-core/test/results/sample_v2.json', 'utf-8');

/* eslint-env jest */

describe('DOM', () => {
  let document;
  beforeAll(() => {
    global.Util = Util;
    global.I18n = I18n;

    global.DOM = DOM;
    global.CategoryRenderer = CategoryRenderer;
    global.DetailsRenderer = DetailsRenderer;

    // Delayed so that CategoryRenderer is in global scope
    const PerformanceCategoryRenderer =
        require('../../renderer/performance-category-renderer.js');
    global.PerformanceCategoryRenderer = PerformanceCategoryRenderer;
    global.CriticalRequestChainRenderer = CriticalRequestChainRenderer;
    global.ElementScreenshotRenderer = ElementScreenshotRenderer;
    global.ReportUIFeatures = ReportUIFeatures;

    const {window} = new jsdom.JSDOM(reportAssets.REPORT_TEMPLATES);
    document = window.document;
  });

  afterAll(() => {
    global.I18n = undefined;
    global.Util = undefined;
    global.DOM = undefined;
    global.CategoryRenderer = undefined;
    global.DetailsRenderer = undefined;
    global.PerformanceCategoryRenderer = undefined;
    global.CriticalRequestChainRenderer = undefined;
    global.ElementScreenshotRenderer = undefined;
    global.ReportUIFeatures = undefined;
  });

  describe('psi prepareLabData helpers', () => {
    describe('prepareLabData', () => {
      itIfProtoExists('succeeds with LHResult object (roundtrip) input', () => {
        const roundTripLHResult = /** @type {LH.Result} */ JSON.parse(sampleResultsRoundtripStr);
        const result = prepareLabData(roundTripLHResult, document);

        // Check that the report exists and has some content.
        assert.ok(result.perfCategoryEl instanceof document.defaultView.Element);
        assert.ok(result.perfCategoryEl.outerHTML.length > 50000, 'perfCategory HTML is populated');
        assert.ok(!result.perfCategoryEl.outerHTML.includes('lh-permalink'),
            'PSI\'s perfCategory HTML doesn\'t include a lh-permalink element');
        // Assume using default locale.
        const title = result.perfCategoryEl.querySelector('.lh-audit-group--metrics')
          .querySelector('.lh-audit-group__title').textContent;
        assert.equal(title, Util.UIStrings.labDataTitle);
      });

      it('succeeds with stringified LHResult input', () => {
        const result = prepareLabData(sampleResultsStr, document);
        assert.ok(result.scoreGaugeEl instanceof document.defaultView.Element);
        assert.equal(result.scoreGaugeEl.querySelector('.lh-gauge__wrapper').href, '');
        assert.ok(result.scoreGaugeEl.outerHTML.includes('<svg'), 'score gauge comes with SVG');

        assert.ok(result.perfCategoryEl instanceof document.defaultView.Element);
        assert.ok(result.perfCategoryEl.outerHTML.length > 50000, 'perfCategory HTML is populated');
        assert.ok(!result.perfCategoryEl.outerHTML.includes('lh-permalink'),
            'PSI\'s perfCategory HTML doesn\'t include a lh-permalink element');

        assert.equal(typeof result.finalScreenshotDataUri, 'string');
        assert.ok(result.finalScreenshotDataUri.startsWith('data:image/jpeg;base64,'));
      });

      it('throws if there is no perf category', () => {
        const lhrWithoutPerf = JSON.parse(sampleResultsStr);
        delete lhrWithoutPerf.categories.performance;
        const lhrWithoutPerfStr = JSON.stringify(lhrWithoutPerf);

        assert.throws(() => {
          prepareLabData(lhrWithoutPerfStr, document);
        }, /no performance category/i);
      });

      it('throws if there is no category groups', () => {
        const lhrWithoutGroups = JSON.parse(sampleResultsStr);
        delete lhrWithoutGroups.categoryGroups;
        const lhrWithoutGroupsStr = JSON.stringify(lhrWithoutGroups);

        assert.throws(() => {
          prepareLabData(lhrWithoutGroupsStr, document);
        }, /no category groups/i);
      });

      it('includes custom title and description', () => {
        const {perfCategoryEl} = prepareLabData(sampleResultsStr, document);
        const metricsGroupEl = perfCategoryEl.querySelector('.lh-audit-group--metrics');

        // Assume using default locale.
        // Replacing markdown because ".textContent" will be post-markdown.
        const expectedDescription = Util.UIStrings.lsPerformanceCategoryDescription
          .replace('[Lighthouse](https://developers.google.com/web/tools/lighthouse/)', 'Lighthouse');

        // Assume using default locale.
        const title = metricsGroupEl.querySelector('.lh-audit-group__title').textContent;
        const description =
          metricsGroupEl.querySelector('.lh-audit-group__description').textContent;
        assert.equal(title, Util.UIStrings.labDataTitle);
        assert.equal(description, expectedDescription);
      });
    });
  });

  describe('_getFinalScreenshot', () => {
    it('gets a datauri as a string', () => {
      const datauri = prepareLabData(sampleResultsStr, document).finalScreenshotDataUri;
      assert.equal(typeof datauri, 'string');
      assert.ok(datauri.startsWith('data:image/jpeg;base64,'));
    });

    it('returns null if there is no final-screenshot audit', () => {
      const clonedResults = JSON.parse(sampleResultsStr);
      delete clonedResults.audits['final-screenshot'];
      const LHResultJsonString = JSON.stringify(clonedResults);
      const datauri = prepareLabData(LHResultJsonString, document).finalScreenshotDataUri;
      assert.equal(datauri, null);
    });
  });
});
