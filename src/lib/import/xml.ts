/**
 * Internal to the import module: XML read into a tree, nothing more.
 *
 * A Word part is generated, well-formed and namespace-prefixed the same way by
 * every producer that matters, so a tokenizer and a stack are enough, and the
 * walker matches `w:p` by its prefixed name. Entities are decoded; a DOCTYPE is
 * skipped and never resolved, so a part cannot make this read anything else.
 */

const XML_TOKEN =
  /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[([\s\S]*?)\]\]>|<!DOCTYPE[^>]*>|<(\/?)([^\s/>]+)([^>]*?)(\/?)>|([^<]+)/g;
const XML_ATTRIBUTE = /([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
const XML_ENTITY = /&(?:#x([0-9a-fA-F]+)|#(\d+)|(lt|gt|amp|quot|apos));/g;
const NAMED_ENTITIES = new Map([
  ["amp", "&"],
  ["apos", "'"],
  ["gt", ">"],
  ["lt", "<"],
  ["quot", '"'],
]);

export interface XmlElement {
  readonly attributes: ReadonlyMap<string, string>;
  readonly children: readonly XmlNode[];
  readonly name: string;
}

type XmlNode = XmlElement | string;

interface OpenElement extends XmlElement {
  readonly children: XmlNode[];
}

export class XmlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "XmlError";
  }
}

/** The root element of one part; `part` names it in the refusal. */
export function parseXml(text: string, part: string): XmlElement {
  const document: OpenElement = { attributes: new Map(), children: [], name: "#document" };
  const stack: OpenElement[] = [document];

  for (const match of text.matchAll(XML_TOKEN)) {
    const [, cdata, closing, name, attributes = "", selfClosing, characters] = match;
    const parent = stack.at(-1) ?? document;

    if (characters !== undefined || cdata !== undefined) {
      parent.children.push(cdata ?? decode(characters ?? ""));
    } else if (name !== undefined) {
      tag(
        stack,
        { attributes, closing: closing === "/", name, selfClosing: selfClosing === "/" },
        part
      );
    }
  }

  const [root] = elements(document);

  if (stack.length !== 1 || root === undefined) {
    throw new XmlError(`${part}: niepoprawny XML, dokument się urywa`);
  }

  return root;
}

function tag(
  stack: OpenElement[],
  token: {
    readonly attributes: string;
    readonly closing: boolean;
    readonly name: string;
    readonly selfClosing: boolean;
  },
  part: string
): void {
  const parent = stack.at(-1);

  if (parent === undefined) {
    throw new XmlError(`${part}: niepoprawny XML przy <${token.name}>`);
  }

  if (token.closing) {
    if (parent.name !== token.name || stack.length < 2) {
      throw new XmlError(`${part}: niepoprawny XML przy </${token.name}>`);
    }

    stack.pop();

    return;
  }

  const element: OpenElement = {
    attributes: parseAttributes(token.attributes),
    children: [],
    name: token.name,
  };

  parent.children.push(element);

  if (!token.selfClosing) {
    stack.push(element);
  }
}

function parseAttributes(text: string): Map<string, string> {
  const attributes = new Map<string, string>();

  for (const [, name = "", double, single] of text.matchAll(XML_ATTRIBUTE)) {
    attributes.set(name, decode(double ?? single ?? ""));
  }

  return attributes;
}

function decode(text: string): string {
  return text.replace(XML_ENTITY, (whole, hex?: string, decimal?: string, named?: string) => {
    if (named !== undefined) {
      return NAMED_ENTITIES.get(named) ?? whole;
    }

    return String.fromCodePoint(Number.parseInt(hex ?? decimal ?? "", hex === undefined ? 10 : 16));
  });
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
