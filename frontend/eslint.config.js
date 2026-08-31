/**
 * ESLint 扁平配置（eslint 10 + eslint-plugin-vue）。
 *
 * 跟后端那份同一个取向：只开**能抓出真错**的规则，不管排版。
 * 现有代码本来就一致（96% 的行 ≤80 字符、零 tab、零双引号字符串），
 * 让 linter 去重排只会制造一次几千行的无意义 diff，把 git blame 洗掉。
 *
 * 跑：`npm run lint`（`npm run lint:fix` 自动修能修的）
 */
import js from '@eslint/js';
import vue from 'eslint-plugin-vue';
import globals from 'globals';

export default [
  {
    ignores: ['node_modules/**', 'dist/**'],
  },

  // ---- 浏览器里跑的：src 下的 .js 和 .vue ----
  {
    files: ['src/**/*.{js,vue}'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        ...globals.browser,
        // src 下的模块**两个环境都跑**：浏览器里是 Vite 打包后的产物，
        // 而契约测试（`npm run test:api`）是用 node 直接 import 它们的。
        // `utils/env.js` 因此要 `typeof process !== 'undefined'` 探一下 ——
        // 那不是遗留代码，是它必须同时活在两处。
        process: 'readonly',
      },
    },
    rules: {
      ...js.configs.recommended.rules,
      'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none' }],
    },
  },

  // vue 插件的 **essential** 档（含 <template> 的解析器）。
  // 放在上面那块**后面**：它要覆盖 parser，顺序反了 .vue 的模板部分解析不了。
  //
  // ⚠️ 用 essential 不用 recommended：`flat/recommended` 里有一半是排版规则
  // （每行几个属性、单行标签要不要换行），开了当场 690 条 warning，
  // 而它们一条真错都抓不到。essential 抓的是真会坏的事：
  // v-for 没有 key、同一个元素上 v-if 和 v-for 打架、props 被直接改。
  ...vue.configs['flat/essential'].map((c) => ({ ...c, files: ['src/**/*.vue'] })),
  {
    files: ['src/**/*.vue'],
    rules: {
      // 组件名一律 `s-xxx`，是这个项目定的（CLAUDE.md），不是疏忽
      'vue/multi-word-component-names': 'off',
    },
  },

  // ---- Node 里跑的：构建配置和脚本 ----
  {
    files: ['vite.config.js', 'scripts/**/*.{js,mjs}'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: globals.node,
    },
    rules: {
      ...js.configs.recommended.rules,
      'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none' }],
    },
  },
];
