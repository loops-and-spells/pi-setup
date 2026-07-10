/**
 * Repo symbol map: signatures + doc contracts, no bodies.
 *
 * Measured basis (pi-bench ctx study): removing cross-file context made a
 * model hallucinate another module's signature; a signatures+docstrings map
 * fully recovered full-file quality at a fraction of the tokens.
 *
 * Extraction is tree-sitter based (web-tree-sitter + tree-sitter-wasms — one
 * mechanism, every bundled grammar, no external language servers), with the
 * original measured regex extractors as fallback when a grammar fails to
 * load. Shared by the repo-map pi extension (production injection) and
 * pi-bench's ctx-map config (the A/B) — one implementation, no copy drift.
 */
import { createRequire } from "node:module"
import Parser from "web-tree-sitter"

const requireHere = createRequire(import.meta.url)

/** Code files worth mapping → tree-sitter-wasms grammar name. */
export const GRAMMAR_BY_EXT: Readonly<Record<string, string>> = {
  py: "python",
  ts: "typescript",
  tsx: "tsx",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  go: "go",
  rs: "rust",
  java: "java",
  rb: "ruby",
  c: "c",
  h: "c",
  cc: "cpp",
  cpp: "cpp",
  hpp: "cpp",
  cs: "c_sharp",
  php: "php",
  swift: "swift",
  kt: "kotlin",
  scala: "scala",
  sh: "bash",
  bash: "bash",
  lua: "lua",
  zig: "zig",
  ex: "elixir",
  exs: "elixir",
  ml: "ocaml",
  dart: "dart"
}

const JS_FAMILY = new Set(["typescript", "tsx", "javascript"])

let parserReady: Promise<void> | null = null
const languages = new Map<string, Parser.Language | null>()

const loadLanguage = async (grammar: string): Promise<Parser.Language | null> => {
  const cached = languages.get(grammar)
  if (cached !== undefined) return cached
  try {
    parserReady ??= Parser.init()
    await parserReady
    const wasm = requireHere.resolve(`tree-sitter-wasms/out/tree-sitter-${grammar}.wasm`)
    const lang = await Parser.Language.load(wasm)
    languages.set(grammar, lang)
    return lang
  } catch {
    languages.set(grammar, null)
    return null
  }
}

// ------------------------------------------------------------ AST extraction

/** Function-likes: emit the signature, never descend into the body. */
const DEF_LIKE =
  /^(function_definition|function_declaration|function_item|method_definition|method_declaration|function_signature|method_signature|constructor_declaration|func_literal)$/

/** Container-likes: emit, then descend so methods surface too. */
const CLASS_LIKE =
  /^(class_definition|class_declaration|class_specifier|interface_declaration|trait_item|struct_item|struct_specifier|enum_item|enum_declaration|enum_specifier|impl_item|type_alias_declaration|type_spec|protocol_declaration|trait_declaration|mod_item|namespace_definition|module_declaration)$/

const MAX_SIG_CHARS = 160

const collapse = (text: string): string => text.replace(/\s+/g, " ").trim()

type TSNode = Parser.SyntaxNode

const signatureOf = (node: TSNode, source: string, exported: boolean): string => {
  const body = node.childForFieldName("body")
  const raw =
    body !== null
      ? source.slice(node.startIndex, body.startIndex)
      : (source.slice(node.startIndex, node.endIndex).split("\n")[0] ?? "")
  let sig = collapse(raw).replace(/[{=]\s*$/, "").trim()
  if (exported && !sig.startsWith("export")) sig = `export ${sig}`
  return sig.length > MAX_SIG_CHARS ? `${sig.slice(0, MAX_SIG_CHARS)}…` : sig
}

/** Python: first line of the body's leading docstring. Others: preceding comment. */
const docOf = (node: TSNode, wrapper: TSNode, grammar: string): string | undefined => {
  if (grammar === "python") {
    const first = node.childForFieldName("body")?.namedChildren[0]
    if (first?.type === "expression_statement" && first.namedChildren[0]?.type === "string") {
      const line = (first.text.split("\n")[0] ?? "").replace(/^[rub]*["']{1,3}|["']{1,3}$/g, "").trim()
      return line === "" ? undefined : line
    }
    return undefined
  }
  const prev = wrapper.previousNamedSibling
  if (prev?.type !== "comment") return undefined
  for (const line of prev.text.split("\n")) {
    const cleaned = line
      .replace(/^\s*(\/\*\*|\*\/|\*|\/\/\/?|#)\s?/, "")
      .replace(/\s*\*\/\s*$/, "")
      .trim()
    if (cleaned !== "") return cleaned
  }
  return undefined
}

const entryFor = (sig: string, doc: string | undefined): string =>
  doc !== undefined ? `- \`${sig}\` — ${doc}` : `- \`${sig}\``

const astSymbols = (root: TSNode, source: string, grammar: string): string[] => {
  const out: string[] = []
  const hasExports = JS_FAMILY.has(grammar) && /^export\s/m.test(source)
  // when a JS-family file exports anything, its non-exported top level is private
  const hidden = (exported: boolean, topLevel: boolean): boolean =>
    hasExports && topLevel && !exported

  const visit = (node: TSNode, wrapper: TSNode, exported: boolean, topLevel: boolean): void => {
    // wrappers: dive through, remembering export/decorator context
    if (node.type === "export_statement" || node.type === "decorated_definition") {
      for (const child of node.namedChildren) {
        visit(child, node, exported || node.type === "export_statement", topLevel)
      }
      return
    }
    if (DEF_LIKE.test(node.type)) {
      if (!hidden(exported, topLevel)) {
        out.push(entryFor(signatureOf(node, source, exported), docOf(node, wrapper, grammar)))
      }
      return // never descend into function bodies (closures are noise)
    }
    if (CLASS_LIKE.test(node.type)) {
      if (hidden(exported, topLevel)) return
      out.push(entryFor(signatureOf(node, source, exported), docOf(node, wrapper, grammar)))
      const body = node.childForFieldName("body")
      if (body !== null) for (const child of body.namedChildren) visit(child, child, exported, false)
      return
    }
    // const f = (…) => … — the JS family's other way to declare a function
    if (
      JS_FAMILY.has(grammar) &&
      (node.type === "lexical_declaration" || node.type === "variable_declaration")
    ) {
      if (hidden(exported, topLevel)) return
      for (const declarator of node.namedChildren) {
        const value = declarator.childForFieldName("value")
        if (value === null || !/function|arrow_function/.test(value.type)) continue
        const valueBody = value.childForFieldName("body")
        const end = valueBody !== null ? valueBody.startIndex : value.startIndex
        let sig = collapse(source.slice(node.startIndex, end)).replace(/[{=]\s*$/, "").trim()
        if (exported && !sig.startsWith("export")) sig = `export ${sig}`
        if (sig.length > MAX_SIG_CHARS) sig = `${sig.slice(0, MAX_SIG_CHARS)}…`
        out.push(entryFor(sig, docOf(node, wrapper, grammar)))
      }
      return
    }
    for (const child of node.namedChildren) visit(child, child, exported, false)
  }

  for (const child of root.namedChildren) visit(child, child, false, true)
  return out
}

// ----------------------------------------------------- regex fallback (measured)

/**
 * Python signatures + docstrings — the original pi-bench symbolMap that
 * measured ctx-map == ctx-full. Fallback when a grammar fails to load.
 */
export const pySymbols = (content: string): string[] => {
  const out: string[] = []
  const lines = content.split("\n")
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ""
    if (line.match(/^(\s*)(?:class|def)\s.*$/) === null) continue
    let entry = line.trim()
    let j = i
    while (!/[:]\s*(#.*)?$/.test(lines[j] ?? "") && j < i + 5) {
      j++
      entry += ` ${(lines[j] ?? "").trim()}`
    }
    const doc = (lines[j + 1] ?? "").trim().match(/^[ru]*["']{3}(.*?)(?:["']{3})?$/)
    out.push(doc?.[1] !== undefined && doc[1] !== "" ? `- \`${entry}\` — ${doc[1]}` : `- \`${entry}\``)
  }
  return out
}

/** TS/JS fallback: exported/top-level declarations, first JSDoc line as contract. */
export const tsSymbols = (content: string): string[] => {
  const out: string[] = []
  const lines = content.split("\n")
  const hasExports = /^export\s/m.test(content)
  const decl =
    /^(export\s+)?(default\s+)?(abstract\s+)?(async\s+)?(function|class|interface|type|const|enum)\s+([A-Za-z_$][\w$]*)/
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ""
    const m = line.match(decl)
    if (m === null) continue
    if (hasExports && m[1] === undefined) continue
    if (m[5] === "const" && !/=\s*(async\s*)?(\(|function)/.test(line) && !line.includes("=>")) continue
    const entry = line.trim().replace(/\s*[{=].*$/, "").trim()
    out.push(`- \`${entry}\``)
  }
  return out
}

// --------------------------------------------------------------- map assembly

const fallbackSymbols = (rel: string, content: string): string[] =>
  /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(rel) ? tsSymbols(content) : pySymbols(content)

export const fileSymbols = async (rel: string, content: string): Promise<string[]> => {
  const ext = rel.split(".").pop() ?? ""
  const grammar = GRAMMAR_BY_EXT[ext]
  if (grammar === undefined) return fallbackSymbols(rel, content)
  const lang = await loadLanguage(grammar)
  if (lang === null) return fallbackSymbols(rel, content)
  const parser = new Parser()
  try {
    parser.setLanguage(lang)
    const tree = parser.parse(content)
    try {
      return astSymbols(tree.rootNode, content, grammar)
    } finally {
      tree.delete()
    }
  } catch {
    // a grammar that loads but cannot parse (wasm ABI drift) is dead weight —
    // blacklist it for the session and degrade to the regex extractors
    languages.set(grammar, null)
    return fallbackSymbols(rel, content)
  } finally {
    parser.delete()
  }
}

/** A `### \`path\`` section per file, one bullet per symbol; symbol-less files omitted. */
export const buildSymbolMap = async (files: Readonly<Record<string, string>>): Promise<string> => {
  const out: string[] = []
  for (const [rel, content] of Object.entries(files)) {
    const symbols = await fileSymbols(rel, content)
    if (symbols.length === 0) continue
    out.push(`### \`${rel}\``, ...symbols, "")
  }
  return out.join("\n")
}

/** Mappable files, shallow paths first — the top of the tree orients best. */
export const selectMapFiles = (allFiles: readonly string[], maxFiles: number): string[] =>
  allFiles
    .filter((f) => {
      if (f.endsWith(".d.ts")) return false
      return GRAMMAR_BY_EXT[f.split(".").pop() ?? ""] !== undefined
    })
    .sort((a, b) => {
      const depth = a.split("/").length - b.split("/").length
      return depth !== 0 ? depth : a.localeCompare(b)
    })
    .slice(0, maxFiles)

/** Whole `###` sections until the budget — a truncated section misleads. */
export const fitToBudget = (map: string, budgetChars: number): string => {
  if (map.length <= budgetChars) return map
  const sections = map.split(/\n(?=### )/)
  let out = ""
  let dropped = 0
  for (const s of sections) {
    if (out.length + s.length + 1 <= budgetChars) out += (out === "" ? "" : "\n") + s
    else dropped++
  }
  if (dropped > 0) out += `\n(… ${dropped} more file(s) not shown)`
  return out
}
