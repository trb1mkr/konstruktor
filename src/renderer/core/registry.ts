import type { App, Component } from 'vue'

// Реестр компонентов конструктора.
// Пользователь регистрирует свои SFC здесь, shell резолвит их по имени.
const registry = new Map<string, Component>()
const meta = new Map<string, { version: string; description: string }>()

export function registerComponent(
  name: string,
  component: Component,
  info: { version?: string; description?: string } = {}
) {
  registry.set(name, component)
  meta.set(name, {
    version: info.version ?? '0.1.0',
    description: info.description ?? ''
  })
}

export function getComponent(name: string): Component | undefined {
  return registry.get(name)
}

export function listComponents(): string[] {
  return [...registry.keys()]
}

export function installRegistry(app: App) {
  // Глобальная регистрация: компоненты доступны в любом layout-SFC.
  for (const [name, comp] of registry) {
    app.component(name, comp)
  }
}
