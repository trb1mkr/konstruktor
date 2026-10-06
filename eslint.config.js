// Плоский конфиг ESLint 10. Правила разделены на группы по зонам:
//   js.configs.recommended       — базовая корректность JS
//   tseslint.configs.recommended — типовые ошибки TypeScript
//   vue.configs['flat/recommended'] — правила для .vue из eslint-plugin-vue
// Форматирование не дублируется: за него отвечает prettier (см. .prettierrc.yml),
// поэтому stylistic-правила выключены, чтобы lint и format не спорили.
import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'
import vue from 'eslint-plugin-vue'

export default tseslint.config(
  {
    // .kilo/worktrees — чужие git-worktree внутри репозитория: там лежит
    // отдельная копия исходников, линтить её не нужно.
    ignores: ['out/**', 'dist/**', 'node_modules/**', '*.tsbuildinfo', '.kilo/**'],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,
  // Конфиги vue подключаем штатным массивом, а не слиянием rules вручную:
  // помимо правил они несут processor и parserOptions, без которых
  // парсер .vue даёт ложные срабатывания (vue/comment-directive на </script>).
  ...vue.configs['flat/recommended'],

  {
    // В script-блоке .vue объявлен lang="ts", поэтому вложенный парсер должен
    // быть TypeScript, иначе содержимое блока не разбирается.
    files: ['src/renderer/**/*.vue'],
    languageOptions: {
      parserOptions: { parser: tseslint.parser },
    },
  },

  {
    files: ['src/main/**/*.ts', 'src/preload/**/*.ts', 'src/view-preload/**/*.ts'],
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      // В main и preload допустимы console и process — это не renderer-код.
      'no-console': 'off',
      // iconVerify грузит fs/url/path и nativeImage лениво, через require внутри
      // функции: так модуль не тянет electron и node-контекст при импорте.
      '@typescript-eslint/no-require-imports': 'off',
    },
  },

  {
    files: ['src/renderer/**/*.ts', 'src/renderer/**/*.vue'],
    languageOptions: {
      globals: { ...globals.browser },
    },
    rules: {
      // Renderer идёт в браузерный контекст, console там полезен для отладки.
      'no-console': 'off',
    },
  },

  {
    files: ['src/renderer/**/*.vue'],
    rules: {
      // Один корневой компонент — норма для этого проекта.
      'vue/multi-word-component-names': 'off',
      // Раскладка атрибутов и переносы — за prettier, они не должны спорить с lint.
      'vue/max-attributes-per-line': 'off',
      'vue/singleline-html-element-content-newline': 'off',
      'vue/html-self-closing': 'off',
      'vue/html-indent': 'off',
      'vue/html-closing-bracket-newline': 'off',
      'vue/multiline-html-element-content-newline': 'off',
      'vue/attributes-order': 'off',
      // В шаблоне Vue допустимо обращаться к computed напрямую: реф снимается
      // при разыменовании в шаблоне, это штатный режим, а не ошибка.
      'vue/no-ref-as-operand': 'off',
    },
  },

  {
    // Скрипты инструментов локализации (scripts/) идут в Node-контексте.
    files: ['scripts/**/*.{js,mjs,cjs}'],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
)
