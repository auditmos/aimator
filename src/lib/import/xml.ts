/**
 * Internal to the import module: XML read into a tree, nothing more.
 *
 * A Word part is generated, well-formed and namespace-prefixed the same way by
 * every producer that matters, so a scanner and a stack are enough, and the
 * walker matches `w:p` by its prefixed name. Entities are decoded; a DOCTYPE is
 * refused rather than read, so a part cannot make this read anything else, and
 * so is a control character, so a part cannot write to anybody's terminal.
 *
 * The scanner moves forward with `indexOf` and never backtracks, because the
 * bytes come from somebody's document: a regular expression with two
 * quantifiers over the same characters turns `<a<a<a…` into an afternoon. The
 * tree is capped too, so a part of tiny tags ends as a refusal, not as memory.
 */

const XML_ENTITY = /&(?:#x([0-9a-fA-F]+)|#(\d+)|(lt|gt|amp|quot|apos));/g;
const NAMED_ENTITIES = new Map([
  ["amp", "&"],
  ["apos", "'"],
  ["gt", ">"],
  ["lt", "<"],
  ["quot", '"'],
]);
const WHITESPACE = new Set([" ", "\t", "\n", "\r"]);
const LAST_CODE_POINT = 0x10_ff_ff;
/** About forty times a long treatment's `document.xml`. */
const MAX_NODES = 2_000_000;
const NO_ATTRIBUTES: ReadonlyMap<string, string> = new Map();
/** What opens with `<` and is not a tag: where it ends, and whether it is text. */
const DELIMITED = [
  { close: "-->", open: "<!--", text: false },
  { close: "]]>", open: "<![CDATA[", text: true },
  { close: "?>", open: "<?", text: false },
] as const;

export interface XmlElement {
  readonly attributes: ReadonlyMap<string, string>;
  readonly children: readonly XmlNode[];
  readonly name: string;
}

type XmlNode = XmlElement | string;

interface OpenElement extends XmlElement {
  readonly children: XmlNode[];
}

type Token =
  | { readonly kind: "skip" }
  | { readonly kind: "text"; readonly text: string }
  | {
      readonly attributes: string;
      readonly closing: boolean;
      readonly kind: "tag";
      readonly name: string;
      readonly selfClosing: boolean;
    };

export class XmlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "XmlError";
  }
}

/** The root element of one part; `part` names it in the refusal. */
export function parseXml(text: string, part: string): XmlElement {
  const document: OpenElement = { attributes: NO_ATTRIBUTES, children: [], name: "#document" };
  const stack: OpenElement[] = [document];
  let nodes = 0;
  let at = 0;

  while (at < text.length) {
    const open = text.indexOf("<", at);
    const end = open === -1 ? text.length : open;
    const parent = stack.at(-1) ?? document;

    if (end > at) {
      parent.children.push(printable(decode(text.slice(at, end)), part));
      nodes += 1;
    }

    if (open === -1) {
      break;
    }

    const markup = markupAt(text, open, part);

    nodes += place(stack, markup.token, part);
    at = markup.end;

    if (nodes > MAX_NODES) {
      throw new XmlError(`${part}: dokument jest zbyt złożony (ponad ${MAX_NODES} węzłów)`);
    }
  }

  const [root] = elements(document);

  if (stack.length !== 1 || root === undefined) {
    throw new XmlError(`${part}: niepoprawny XML, dokument się urywa`);
  }

  return root;
}

/** One `<…>` starting at `open`, and the index just past it. */
function markupAt(
  text: string,
  open: number,
  part: string
): { readonly end: number; readonly token: Token } {
  for (const delimited of DELIMITED) {
    if (text.startsWith(delimited.open, open)) {
      const close = text.indexOf(delimited.close, open + delimited.open.length);

      if (close === -1) {
        throw new XmlError(`${part}: niepoprawny XML, ${delimited.open} bez ${delimited.close}`);
      }

      return {
        end: close + delimited.close.length,
        token: delimited.text
          ? { kind: "text", text: text.slice(open + delimited.open.length, close) }
          : { kind: "skip" },
      };
    }
  }

  if (text.startsWith("<!", open)) {
    throw new XmlError(`${part}: deklaracja <! (np. DOCTYPE) nie jest obsługiwana`);
  }

  const close = tagEnd(text, open);

  if (close === -1) {
    throw new XmlError(`${part}: niepoprawny XML, znacznik bez >`);
  }

  const inner = text.slice(open + 1, close);
  const closing = inner.startsWith("/");
  const selfClosing = !closing && inner.endsWith("/");
  const body = inner.slice(closing ? 1 : 0, selfClosing ? -1 : inner.length);
  const space = firstSpace(body);

  return {
    end: close + 1,
    token: {
      attributes: space === -1 ? "" : body.slice(space),
      closing,
      kind: "tag",
      name: space === -1 ? body : body.slice(0, space),
      selfClosing,
    },
  };
}

/** The `>` that closes the tag at `open`, skipping any inside a quoted value. */
function tagEnd(text: string, open: number): number {
  let quote: string | null = null;

  for (let at = open + 1; at < text.length; at += 1) {
    const character = text[at];

    if (quote !== null) {
      quote = character === quote ? null : quote;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === ">") {
      return at;
    }
  }

  return -1;
}

function firstSpace(text: string): number {
  for (let at = 0; at < text.length; at += 1) {
    if (WHITESPACE.has(text[at] ?? "")) {
      return at;
    }
  }

  return -1;
}

/** Puts one token into the tree, and says how many nodes it added. */
function place(stack: OpenElement[], token: Token, part: string): number {
  const parent = stack.at(-1);

  if (parent === undefined || token.kind === "skip") {
    return 0;
  }

  if (token.kind === "text") {
    parent.children.push(printable(token.text, part));

    return 1;
  }

  if (token.name === "") {
    throw new XmlError(`${part}: niepoprawny XML, znacznik bez nazwy`);
  }

  if (token.closing) {
    if (parent.name !== token.name || stack.length < 2) {
      throw new XmlError(`${part}: niepoprawny XML przy </${token.name}>`);
    }

    stack.pop();

    return 0;
  }

  const element: OpenElement = {
    attributes: parseAttributes(token.attributes, part),
    children: [],
    name: token.name,
  };

  parent.children.push(element);

  if (!token.selfClosing) {
    stack.push(element);
  }

  return 1;
}

/** `a="1" b='2'`, read forward: a name, `=`, a quoted value, again. */
function parseAttributes(text: string, part: string): ReadonlyMap<string, string> {
  let at = skipSpace(text, 0);

  if (at === text.length) {
    return NO_ATTRIBUTES;
  }

  const attributes = new Map<string, string>();

  while (at < text.length) {
    const equals = text.indexOf("=", at);
    const quoteAt = equals === -1 ? -1 : skipSpace(text, equals + 1);
    const quote = quoteAt === -1 ? undefined : text[quoteAt];
    const close = quote === '"' || quote === "'" ? text.indexOf(quote, quoteAt + 1) : -1;

    if (close === -1) {
      throw new XmlError(`${part}: niepoprawny atrybut w „${text.slice(at, at + 40)}”`);
    }

    attributes.set(
      text.slice(at, equals).trim(),
      printable(decode(text.slice(quoteAt + 1, close)), part)
    );
    at = skipSpace(text, close + 1);
  }

  return attributes;
}

function skipSpace(text: string, from: number): number {
  let at = from;

  while (at < text.length && WHITESPACE.has(text[at] ?? "")) {
    at += 1;
  }

  return at;
}

/** Entities decoded; a reference to no character is kept as it was written. */
function decode(text: string): string {
  return text.replace(XML_ENTITY, (whole, hex?: string, decimal?: string, named?: string) => {
    if (named !== undefined) {
      return NAMED_ENTITIES.get(named) ?? whole;
    }

    const code = Number.parseInt(hex ?? decimal ?? "", hex === undefined ? 10 : 16);

    return code <= LAST_CODE_POINT ? String.fromCodePoint(code) : whole;
  });
}

/**
 * `text` as it was, unless it holds a character a terminal would execute: C0
 * but the tab and the two line ends, which XML forbids outright, and DEL and
 * C1, which it only discourages. Word writes none of them, so one here was put
 * there, and a heading carrying it would rewrite the screen of whoever reads
 * the material. Refused rather than dropped, for the reason hidden text is.
 */
function printable(text: string, part: string): string {
  for (let at = 0; at < text.length; at += 1) {
    const code = text.charCodeAt(at);

    if (
      (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) ||
      (code >= 0x7f && code <= 0x9f)
    ) {
      const before = text.slice(Math.max(0, at - 30), at).trim();
      const where = before === "" ? "" : ` zaraz po „${before}”`;

      throw new XmlError(
        `${part}: dokument zawiera niewidoczny znak sterujący U+${code.toString(16).toUpperCase().padStart(4, "0")}${where}; usuń go w Wordzie i zapisz dokument ponownie`
      );
    }
  }

  return text;
}

/** The element children of `node`, all of them or those named `name`. */
export function elements(node: XmlElement | undefined, name?: string): XmlElement[] {
  return (node?.children ?? []).filter(
    (item): item is XmlElement =>
      typeof item !== "string" && (name === undefined || item.name === name)
  );
}

export function child(node: XmlElement | undefined, name: string): XmlElement | undefined {
  return elements(node, name)[0];
}

export function descendants(node: XmlElement): XmlElement[] {
  return elements(node).flatMap((element) => [element, ...descendants(element)]);
}

/** The text directly inside `node`, joined, without its elements' text. */
export function ownText(node: XmlElement): string {
  return node.children.filter((item) => typeof item === "string").join("");
}
