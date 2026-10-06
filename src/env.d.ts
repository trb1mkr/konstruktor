// Типы Vite для import.meta в main и renderer.
//
// electron-vite собирает оба процесса через Vite, поэтому import.meta.env
// и import.meta.glob работают и в main, и в renderer. Официальные
// vite/client типы не подключены (tsconfig.types), поэтому объявлены здесь
// точечно — ровно те поля, которые использует код.
interface ImportMetaEnv {
  // Заменяются статически при сборке: dev — true, prod — false.
  readonly DEV: boolean
  readonly PROD: boolean
  readonly MODE: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
  // Eager glob: каталоги языков вшиваются в бандл без правок кода.
  glob(pattern: string, options: { eager: true }): Record<string, { default: unknown }>
}
