/**
 * ESLint 扁平配置（eslint 10）。
 *
 * 这里只开**能抓出真错**的规则，不管排版 —— 缩进、引号、行宽这些
 * 现有代码本来就一致（96% 的行 ≤80 字符、零 tab、零双引号字符串），
 * 交给 linter 去重排只会制造一次几千行的无意义 diff，把 git blame 洗掉。
 *
 * 跑：`npm run lint`（`npm run lint:fix` 自动修能修的）
 */
import js from '@eslint/js';
import globals from 'globals';

/**
 * 全角空格（U+3000）在这个项目里是**正文的一部分** ——
 * 中文注释里排版用、`normHeader` 的正则里要把它一起去掉、提示词模板里也有。
 * 默认只放过普通字符串，剩下三种位置都得显式放行，否则报的是一堆假错。
 */
const irregularWhitespace = ['error', {
  skipStrings: true, skipComments: true, skipTemplates: true, skipRegExps: true,
}];

export default [
  {
    ignores: ['node_modules/**', '.local-images/**', 'admin/index.html', 'lint.json'],
  },

  // ---- 服务端：Node + ESM ----
  {
    files: ['src/**/*.js', 'scripts/**/*.{js,mjs}'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: globals.node,
    },
    rules: {
      ...js.configs.recommended.rules,
      // 参数没用到是常事（Express 的 (req, res, next) 里 next 经常不用），
      // 只抓真正没用到的**变量**和 import
      'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none' }],
      'no-irregular-whitespace': irregularWhitespace,
    },
  },

  // ---- 管理后台前端：浏览器 + 传统 script ----
  // 四个文件由 index.html 依次 <script> 引入，**共享同一个全局作用域**，
  // 没有 import/export。所以 sourceType 是 script，而不是 module。
  //
  // ⚠️ 得分成两块写：一个符号在**定义它的那个文件**里声明成 global，
  // 报的是 `no-redeclare`（「已经是内置全局了」）；只在**用它的文件**里声明才对。
  // 不声明的话是 110 条 no-undef —— 全是假错，
  // 而一个开箱就报 110 条的 linter，第二天就没人看了。
  {
    files: ['admin/app.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'script',
      // app.js 用、别的文件定义的：三个视图 + 一个查名单的辅助函数。
      // openTeacher / openRosterOnly 是 app.js 自己挂在 window 上的，
      // 挂上去之后又当裸全局调用（`onclick=` 里的字符串要它在 window 上）。
      globals: {
        ...globals.browser,
        modelsView: 'readonly', tasksView: 'readonly', findRosterRow: 'readonly',
        openTeacher: 'readonly', openRosterOnly: 'readonly',
      },
    },
    rules: {
      ...js.configs.recommended.rules,
      'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none' }],
      'no-irregular-whitespace': irregularWhitespace,
    },
  },
  {
    files: ['admin/models.js', 'admin/roster.js', 'admin/tasks.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'script',
      // 这三个文件用、app.js 定义的那一套。新加一个要把名字加进来。
      globals: {
        ...globals.browser,
        S: 'writable', api: 'readonly', esc: 'readonly', toast: 'readonly',
        render: 'readonly', load: 'readonly', fmtDay: 'readonly', pg: 'readonly',
        paginate: 'readonly', pagerBar: 'readonly', perSelect: 'readonly',
        thFilter: 'readonly', clearBtn: 'readonly', readFileBase64: 'readonly',
        openTeacher: 'readonly', openRosterOnly: 'readonly',
      },
    },
    rules: {
      ...js.configs.recommended.rules,
      // 这三个是它们各自对外的入口（app.js 调），在本文件里看着「没人用」
      'no-unused-vars': ['warn', {
        args: 'none', caughtErrors: 'none',
        varsIgnorePattern: '^(modelsView|tasksView|findRosterRow)$',
      }],
      'no-irregular-whitespace': irregularWhitespace,
    },
  },
];
