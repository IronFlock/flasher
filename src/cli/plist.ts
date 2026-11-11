// A reader for the XML property lists `diskutil -plist` prints: dict, array,
// string, integer, real, true, false, date and data (as its base64 text).
// Pure, so it is unit-tested.

export type PlistValue = string | number | boolean | PlistValue[] | { [key: string]: PlistValue }

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

const unescape = (text: string): string =>
  text.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, (_, name: string) => {
    if (name.startsWith('#x')) return String.fromCodePoint(parseInt(name.slice(2), 16))
    if (name.startsWith('#')) return String.fromCodePoint(parseInt(name.slice(1), 10))
    return ENTITIES[name]
  })

type Token = { tag: string; kind: 'open' | 'close' | 'empty'; text?: string }

const tokenize = (xml: string): Token[] => {
  const tokens: Token[] = []
  // <tag>text</tag> pairs of scalars, <tag/> and the open/close of containers.
  const pattern = /<(\/?)([A-Za-z]+)(?:\s[^>]*?)?\s*(\/?)>|([^<]+)/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(xml)) !== null) {
    if (match[4] !== undefined) {
      const last = tokens[tokens.length - 1]
      if (last && last.kind === 'open') last.text = (last.text ?? '') + match[4]
      continue
    }
    const kind = match[1] ? 'close' : match[3] ? 'empty' : 'open'
    tokens.push({ tag: match[2], kind })
  }
  return tokens
}

export const parsePlist = (xml: string): PlistValue => {
  // Drop the prolog, the doctype and comments.
  const body = xml
    .replace(/<\?[^>]*\?>/g, '')
    .replace(/<!DOCTYPE[^>]*>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
  const tokens = tokenize(body)
  let at = 0

  const fail = (message: string): never => {
    throw new Error(`Not a property list: ${message}`)
  }

  const value = (): PlistValue => {
    const token = tokens[at++] ?? fail('it ends early')
    if (token.kind === 'close') fail(`unexpected </${token.tag}>`)
    const { tag } = token
    if (token.kind === 'empty') {
      if (tag === 'true') return true
      if (tag === 'false') return false
      if (tag === 'dict') return {}
      if (tag === 'array') return []
      if (tag === 'string' || tag === 'data' || tag === 'date') return ''
      return fail(`<${tag}/>`)
    }
    if (tag === 'dict') {
      const dict: { [key: string]: PlistValue } = {}
      while (tokens[at] && !(tokens[at].kind === 'close' && tokens[at].tag === 'dict')) {
        const key = tokens[at++]
        if (key.tag !== 'key') fail(`<${key.tag}> where a key belongs`)
        if (key.kind === 'open') close('key')
        dict[unescape((key.text ?? '').trim())] = value()
      }
      close('dict')
      return dict
    }
    if (tag === 'array') {
      const array: PlistValue[] = []
      while (tokens[at] && !(tokens[at].kind === 'close' && tokens[at].tag === 'array')) {
        array.push(value())
      }
      close('array')
      return array
    }
    close(tag)
    const text = token.text ?? ''
    if (tag === 'string' || tag === 'date') return unescape(text)
    if (tag === 'data') return text.replace(/\s+/g, '')
    if (tag === 'integer' || tag === 'real') {
      const number = Number(text.trim())
      return Number.isFinite(number) ? number : fail(`<${tag}>${text}`)
    }
    if (tag === 'plist') return fail('nested <plist>')
    return fail(`<${tag}>`)
  }

  const close = (tag: string) => {
    const token = tokens[at++]
    if (!token || token.kind !== 'close' || token.tag !== tag) fail(`</${tag}> missing`)
  }

  const root = tokens[at++]
  if (!root || root.tag !== 'plist' || root.kind !== 'open') fail('no <plist>')
  const result = value()
  close('plist')
  return result
}
