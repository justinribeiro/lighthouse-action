module.exports = {
  audits: {
    'service-worker': {
      score: 1,
    },
    'first-contentful-paint': {
      score: 1,
      numericValue: 1000,
    },
    'first-meaningful-paint': {
      score: 1,
      numericValue: 1000,
    },
  },
  categories: {
    performance: {
      score: 0.95,
    },
    accessibility: {
      score: 0.95,
    },
    'best-practices': {
      score: 0.95,
    },
    seo: {
      score: 0.95,
    },
    pwa: {
      score: 0.95,
    },
  },
};
