const decodeBunUnicodeEscapes = (part: string): string =>
  part.replace(/\\u\{([0-9a-fA-F]+)\}|\\u([0-9a-fA-F]{4})/g, (_, wide, short) => String.fromCodePoint(parseInt(wide ?? short, 16)));

export const rawHTML = (strings: TemplateStringsArray, ...values: unknown[]): string =>
  String.raw({ raw: strings.raw.map(decodeBunUnicodeEscapes) }, ...values);
