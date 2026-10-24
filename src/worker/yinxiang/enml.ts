export interface EnmlConversion {
  markdown: string
  warnings: string[]
  resourceHashes: string[]
}

const SAFE_SCHEMES = /^(?:https?:|mailto:|tel:)/i

export function convertEnmlToMarkdown(enml: string, resourceHashByGuid = new Map<string, string>()): EnmlConversion {
  const warnings: string[] = []
  const resourceHashes: string[] = []
  let value = enml.slice(0, 2_000_000)
  if (enml.length > value.length) warnings.push('ENML content exceeded the conversion limit')
  value = value.replace(/<!DOCTYPE[\s\S]*?>/gi, '')
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[\s\S]*?<\/style>/gi, '')
    .replace(/\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/<en-media\b([^>]*)\/?>(?:<\/en-media>)?/gi, (_match, attributes: string) => {
      const hash = /hash\s*=\s*["']([^"']+)["']/i.exec(attributes)?.[1]
      const type = /type\s*=\s*["']([^"']+)["']/i.exec(attributes)?.[1] ?? 'application/octet-stream'
      if (!hash) {
        warnings.push('A media resource had no hash')
        return '[Unresolved attachment]'
      }
      const resolved = resourceHashByGuid.get(hash) ?? hash
      resourceHashes.push(resolved)
      return `![Attachment](/api/files/by-source/${encodeURIComponent(resolved)} "${type}")`
    })
    .replace(/<en-todo\b[^>]*checked\s*=\s*["']true["'][^>]*\/?>(?:<\/en-todo>)?/gi, '- [x] ')
    .replace(/<en-todo\b[^>]*\/?>(?:<\/en-todo>)?/gi, '- [ ] ')
    .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, level, text) => `${'#'.repeat(Number(level))} ${stripTags(text)}\n\n`)
    .replace(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/gi, (_m, text) => stripTags(text).split(/\r?\n/).map((line: string) => `> ${line}`).join('\n') + '\n\n')
    .replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_m, text) => `- ${stripTags(text).trim()}\n`)
    .replace(/<br\s*\/?>(?=\S)/gi, '\n')
    .replace(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi, (_m, attributes: string, text: string) => {
      const href = /href\s*=\s*["']([^"']+)["']/i.exec(attributes)?.[1] ?? ''
      return href && SAFE_SCHEMES.test(href) ? `[${stripTags(text).trim()}](${href})` : stripTags(text)
    })
    .replace(/<p\b[^>]*>([\s\S]*?)<\/p>/gi, (_m, text) => `${text.trim()}\n\n`)
    .replace(/<div\b[^>]*>([\s\S]*?)<\/div>/gi, (_m, text) => `${text.trim()}\n\n`)
    .replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_m, text) => `\`${stripTags(text).trim()}\``)
    .replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_m, text) => `\n\`\`\`\n${stripTags(text).trim()}\n\`\`\`\n`)
    .replace(/<[^>]+>/g, '')
  value = decodeEntities(value).replace(/\r\n/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
  return { markdown: value, warnings, resourceHashes }
}

function stripTags(value: string): string {
  return decodeEntities(value.replace(/<[^>]+>/g, '')).trim()
}

function decodeEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
}
