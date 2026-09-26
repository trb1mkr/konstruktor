import { app } from 'electron'

// Secure DNS (DNS-over-HTTPS) для сессий вкладок.
// Chromium включает DoH через prefs; в Electron API нет прямого флага,
// поэтому пробрасываем через command-line switches на весь app:
// --enable-features=DnsOverHttps + --dns-over-https-servers.
// Применяется при старте из сохраненных настроек; смена в UI требует рестарта.
export function dnsServersFor(mode: string, custom: string): string | null {
  if (mode === 'cloudflare') return 'https://cloudflare-dns.com/dns-query'
  if (mode === 'google') return 'https://dns.google/dns-query'
  if (mode === 'custom' && custom.trim()) return custom.trim()
  return null
}

export function applySecureDns(servers: string | null): void {
  if (!servers) return
  // Дубли appendSwitch безопасны — Chromium берет последнее значение.
  app.commandLine.appendSwitch('enable-features', 'DnsOverHttps')
  app.commandLine.appendSwitch('dns-over-https-servers', servers)
}
