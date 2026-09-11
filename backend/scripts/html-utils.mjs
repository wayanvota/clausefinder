const ENTITY_MAP = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "-",
  mdash: "-",
  rsquo: "'",
  lsquo: "'",
  rdquo: '"',
  ldquo: '"'
};

export function decodeEntities(value) {
  return String(value || "")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)))
    .replace(/&([a-z]+);/gi, (_, entity) => ENTITY_MAP[entity] || " ");
}

export function stripHtml(value) {
  const withoutScripts = removeElementContent(String(value || ""), "script");
  const withoutStyles = removeElementContent(withoutScripts, "style");
  return decodeEntities(
    withoutStyles
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  );
}

function removeElementContent(markup, tagName) {
  const lower = markup.toLowerCase();
  const opening = `<${tagName}`;
  const closing = `</${tagName}`;
  let cursor = 0;
  let result = "";
  while (cursor < markup.length) {
    const start = lower.indexOf(opening, cursor);
    if (start < 0) return result + markup.slice(cursor);
    const boundary = lower[start + opening.length];
    if (!isTagBoundary(boundary)) {
      result += markup.slice(cursor, start + opening.length);
      cursor = start + opening.length;
      continue;
    }
    const openEnd = lower.indexOf(">", start + opening.length);
    if (openEnd < 0) return result + markup.slice(cursor, start);
    const closeStart = lower.indexOf(closing, openEnd + 1);
    if (closeStart < 0) return result + markup.slice(cursor, start);
    const closeEnd = lower.indexOf(">", closeStart + closing.length);
    if (closeEnd < 0) return result + markup.slice(cursor, start);
    result += `${markup.slice(cursor, start)} `;
    cursor = closeEnd + 1;
  }
  return result;
}

function isTagBoundary(character) {
  return character === undefined || character === ">" || character === "/" ||
    character === " " || character === "\t" || character === "\n" || character === "\r" || character === "\f";
}
