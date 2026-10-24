import { describe, expect, it } from 'vitest'
import { convertEnmlToMarkdown } from './enml'

describe('ENML conversion', () => {
  it('converts headings, tasks, links and media while filtering unsafe content', () => {
    const result = convertEnmlToMarkdown('<!DOCTYPE en-note><en-note><h2>Title</h2><p><en-todo checked="true"/>Done <a href="javascript:alert(1)">bad</a></p><en-media hash="abc" type="image/png"/><script>alert(1)</script></en-note>')
    expect(result.markdown).toContain('## Title')
    expect(result.markdown).toContain('- [x]')
    expect(result.markdown).not.toContain('javascript:')
    expect(result.markdown).not.toContain('<script>')
    expect(result.resourceHashes).toEqual(['abc'])
  })

  it('preserves safe links and reports malformed media', () => {
    const result = convertEnmlToMarkdown('<en-note><p><a href="https://example.com">site</a></p><en-media type="application/pdf"/></en-note>')
    expect(result.markdown).toContain('[site](https://example.com)')
    expect(result.warnings).toHaveLength(1)
  })
})
