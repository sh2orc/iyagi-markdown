import { GFM, parser } from "@lezer/markdown";
import { lexicallyClean, percentDecode } from "../links";
import { frontMatterSyntax } from "./frontmatter";
import { inlineLinkParts } from "./inlineLinkEdit";
import { mathSyntax } from "./mathSyntax";
import { wikiLinkSyntax } from "./wiki";

const imageParser = parser.configure([GFM, mathSyntax, frontMatterSyntax, wikiLinkSyntax]);

/** Same destination resolution for the editor widget and full-screen viewer. */
export function imageSource(src: string, baseDir: string): string {
  if (/^(https?:|data:|file:|#)/i.test(src)) return src;
  const decoded = percentDecode(src).replace(/\\/g, "/");
  return lexicallyClean(decoded.startsWith("/") ? decoded : `${baseDir}/${decoded}`);
}

export interface DocumentImage { from: number; to: number; src: string; alt: string }

/** Parse once when opening the gallery, including images outside the editor's
 * partially parsed viewport. Reference images follow the editor's current scope. */
export function documentImages(source: string, baseDir: string): DocumentImage[] {
  const images: DocumentImage[] = [];
  imageParser.parse(source).iterate({ enter(node) {
    if (node.name !== "Image") return;
    const parts = inlineLinkParts(source.slice(node.from, node.to));
    if (parts?.kind === "image") images.push({
      from: node.from, to: node.to, src: imageSource(parts.url, baseDir), alt: parts.text,
    });
    return false;
  } });
  return images;
}
