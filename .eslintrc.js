module.exports = {
  extends: ['eslint:recommended', 'google', 'prettier'],
  parserOptions: {
    ecmaVersion: 2018,
    sourceType: 'module',
  },
  env: {
    browser: true,
  },
  plugins: ['html', 'lit'],
  rules: {
    'max-len': [
      'error',
      {
        ignoreTemplateLiterals: true,
        ignoreStrings: true,
        ignoreRegExpLiterals: true,
      },
    ],
    'no-var': 'error',
    'require-jsdoc': 'off',
    'arrow-parens': 'off',
    'no-console': 'off',
    'new-cap': 'off',
    'brace-style': [2, '1tbs'],
    'no-loop-func': 'error',
    'no-await-in-loop': 'error',
    'no-useless-call': 'error',
    'padded-blocks': [
      'error',
      {
        blocks: 'never',
        classes: 'never',
        switches: 'never',
      },
    ],
    'space-in-parens': 'error',
  },
  globals: {
    customElements: false,
    ga: false,
    __import: false,
    importModule: false,
    module: false,
    Prism: false,
    Promise: false,
  },
};
