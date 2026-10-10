/**
 * Minimal XML utilities for the WebDAV surface. Workers have no DOMParser,
 * so PROPFIND/PROPPATCH bodies are handled with a small namespace-aware
 * scanner: a well-formedness validator (litmus expects 400 for broken
 * bodies) plus element extraction that yields self-contained markup and
 * `{namespace}local` expanded names.
 */

/** A parsed element occurrence inside a `<prop>` block. */
export interface PropElement {
  /** Expanded name: `{namespace}local` (namespace "" = no namespace). */
  key: string;
  /** Local (unprefixed) name. */
  local: string;
  /** Original markup, made self-contained (declares every prefix it uses). */
  markup: string;
}

const DECL_RE = /\sxmlns(?::([A-Za-z_][\w.-]*))?\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

/** xmlns declarations inside an attribute string (prefix → uri; "" = default). */
export function declsIn(attrs: string): Map<string, string> {
  const decls = new Map<string, string>();
  DECL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = DECL_RE.exec(attrs)) !== null) {
    decls.set(m[1] ?? '', m[2] ?? m[3] ?? '');
  }
  return decls;
}

/** All xmlns declarations in a body, last occurrence wins. */
export function collectXmlScope(body: string): Map<string, string> {
  return declsIn(body);
}

/**
 * Rewrite `markup` so every namespace binding it relies on is declared
 * inside it: a `<prop>` result must stay valid when re-emitted under our
 * own response root, wherever the client declared the prefix.
 */
export function selfContain(markup: string, scope: Map<string, string>): string {
  const start = /^<([^\s/>]+)((?:[^>/"']|"[^"]*"|'[^']*')*)(\/?)>/.exec(markup);
  if (!start) return markup;
  const qname = start[1] ?? '';
  const attrs = start[2] ?? '';
  const decls = declsIn(attrs);
  const add: string[] = [];

  // Every prefix used anywhere in the markup (elements and attributes).
  const used = new Set<string>();
  for (const m of markup.matchAll(/[<\s]([A-Za-z_][\w.-]*):/g)) {
    const pfx = m[1];
    if (pfx && pfx !== 'xmlns') used.add(pfx);
  }
  for (const pfx of used) {
    if (decls.has(pfx)) continue;
    const uri = scope.get(pfx);
    if (uri !== undefined && uri !== '') add.push(` xmlns:${pfx}="${uri}"`);
  }
  // Unprefixed root element relies on the default namespace in effect.
  if (!qname.includes(':') && !decls.has('')) {
    const uri = scope.get('');
    if (uri) add.push(` xmlns="${uri}"`);
  }
  if (add.length === 0) return markup;
  const end = start[0].length;
  // Insert before the '>' — and before the '/' of a self-closing tag, so
  // the markup stays valid (`<X:foo xmlns:X="..."/>`, never `/ ...>`).
  const insertAt = end - 1 - (start[3] === '/' ? 1 : 0);
  return markup.slice(0, insertAt) + add.join('') + markup.slice(insertAt);
}

/** Expanded-name lookup for one element start tag. */
export function resolveNs(
  qname: string,
  decls: Map<string, string>,
  scope: Map<string, string>,
): string {
  const idx = qname.indexOf(':');
  if (idx === -1) return decls.get('') ?? scope.get('') ?? '';
  const pfx = qname.slice(0, idx);
  return decls.get(pfx) ?? scope.get(pfx) ?? '';
}

/**
 * XML well-formedness + namespace validity check: matching (and correctly
 * prefixed) close tags, single root, declared prefixes, no empty prefix
 * bindings (`xmlns:p=""` is illegal; `xmlns=""` merely undeclares).
 * Returns an error reason, or null when the body is acceptable.
 */
export function validateXml(body: string): string | null {
  const tagStack: string[] = [];
  const scopeStack: Array<Map<string, string>> = [new Map()];
  let roots = 0;
  let i = 0;
  const n = body.length;

  // A raw `&` must open a well-formed entity reference; anything else makes
  // the document not XML (strict parsers reject it before we re-emit props).
  const bareAmpOk = (text: string): boolean => {
    let idx = text.indexOf('&');
    while (idx !== -1) {
      const rest = text.slice(idx);
      if (!/^&(?:amp|lt|gt|apos|quot|#\d+|#x[0-9A-Fa-f]+);/.test(rest)) return false;
      idx = text.indexOf('&', idx + 1);
    }
    return true;
  };

  while (i < n) {
    const lt = body.indexOf('<', i);
    if (lt === -1) {
      // trailing text is fine, but not a bare '&'
      if (!bareAmpOk(body.slice(i))) return 'bare & entity';
      break;
    }
    if (!bareAmpOk(body.slice(i, lt))) return 'bare & entity';
    if (body.startsWith('<!--', lt)) {
      const e = body.indexOf('-->', lt + 4);
      if (e === -1) return 'unterminated comment';
      i = e + 3;
      continue;
    }
    if (body.startsWith('<![CDATA[', lt)) {
      const e = body.indexOf(']]>', lt + 9);
      if (e === -1) return 'unterminated CDATA section';
      i = e + 3;
      continue;
    }
    if (body.startsWith('<?', lt)) {
      const e = body.indexOf('?>', lt + 2);
      if (e === -1) return 'unterminated processing instruction';
      i = e + 2;
      continue;
    }
    if (body.startsWith('<!', lt)) {
      const e = body.indexOf('>', lt + 2);
      if (e === -1) return 'unterminated declaration';
      i = e + 1;
      continue;
    }
    // Element: scan to '>' honoring quotes (a stray '<' inside is a parse
    // error; an unclosed quote swallows the rest and fails later).
    let j = lt + 1;
    let quote = '';
    while (j < n) {
      const c = body[j];
      if (quote) {
        if (c === quote) quote = '';
      } else if (c === '"' || c === "'") {
        quote = c;
      } else if (c === '<') {
        return 'unbalanced markup';
      } else if (c === '>') {
        break;
      }
      j++;
    }
    if (j >= n) return 'unterminated tag';
    const raw = body.slice(lt + 1, j);
    // Inside a tag the only legal '&' is in an attribute value, and there it
    // must still be an entity reference.
    if (!bareAmpOk(raw)) return 'bare & entity';
    i = j + 1;

    if (raw.startsWith('/')) {
      const qname = raw.slice(1).trim();
      if (tagStack.length === 0) return 'unmatched closing tag';
      if (tagStack.pop() !== qname) return 'mismatched closing tag';
      scopeStack.pop();
      continue;
    }

    const selfClose = raw.endsWith('/');
    const inner = selfClose ? raw.slice(0, -1) : raw;
    const nameMatch = /^\s*([^\s/>]+)/.exec(inner);
    if (!nameMatch) return 'invalid element name';
    const qname = nameMatch[1] ?? '';
    if (!/^[A-Za-z_][\w.-]*(?::[A-Za-z_][\w.-]*)?$/.test(qname)) {
      return 'invalid element name';
    }

    const parentScope = scopeStack[scopeStack.length - 1] ?? new Map<string, string>();
    const decls = declsIn(inner);
    for (const [pfx, uri] of decls) {
      if (pfx !== '' && uri === '') return 'empty namespace binding';
    }
    // A prefixed name must resolve; unprefixed elements/attributes are
    // legal in no namespace.
    const checkPrefix = (name: string): string | null => {
      const idx = name.indexOf(':');
      if (idx === -1) return null;
      const pfx = name.slice(0, idx);
      if (pfx === 'xmlns') return null;
      const uri = decls.get(pfx) ?? parentScope.get(pfx);
      return uri === undefined ? `undeclared prefix "${pfx}"` : null;
    };
    const bad = checkPrefix(qname);
    if (bad) return bad;
    const attrRe = /([A-Za-z_][\w.-]*(?::[A-Za-z_][\w.-]*)?)\s*=/g;
    let am: RegExpExecArray | null;
    while ((am = attrRe.exec(inner)) !== null) {
      const attrBad = checkPrefix(am[1] ?? '');
      if (attrBad) return attrBad;
    }

    if (tagStack.length === 0) {
      roots++;
      if (roots > 1) return 'multiple root elements';
    }
    if (!selfClose) {
      tagStack.push(qname);
      const scope = new Map(parentScope);
      for (const [pfx, uri] of decls) scope.set(pfx, uri);
      scopeStack.push(scope);
    }
  }
  if (tagStack.length > 0) return 'unclosed elements';
  return null;
}

/**
 * Extract the top-level elements of an XML fragment (typically the inside
 * of a `<prop>` block) with expanded names and self-contained markup.
 * The fragment must already be validated.
 */
export function parsePropElements(fragment: string, scope: Map<string, string>): PropElement[] {
  const out: PropElement[] = [];
  const openTag = /<([A-Za-z_][\w.-]*:)?([A-Za-z_][\w.-]*)(\s[^>]*)?(\/?)>/g;
  let m: RegExpExecArray | null;
  while ((m = openTag.exec(fragment)) !== null) {
    const prefix = m[1] ?? '';
    const local = m[2] ?? '';
    const qname = prefix + local;
    let markup = m[0];
    if (m[4] !== '/') {
      // Container element: consume through its close tag so nested tags
      // are not mistaken for separate properties.
      const closeRe = new RegExp(`</${prefix}${local}\\s*>`);
      const rest = fragment.slice(openTag.lastIndex);
      const cm = rest.match(closeRe);
      if (cm && cm.index !== undefined) {
        markup = m[0] + rest.slice(0, cm.index + cm[0].length);
        openTag.lastIndex += cm.index + cm[0].length;
      }
    }
    const decls = declsIn(m[3] ?? '');
    const ns = resolveNs(qname, decls, scope);
    out.push({ key: `{${ns}}${local}`, local, markup: selfContain(markup, scope) });
  }
  return out;
}
