import type { TreeNode } from "../api";
import { buildWikiIndex } from "../editor/wiki";
import type { WikiDoc } from "../editor/wikiComplete";

/** Build once per tree refresh; labels never serve as disambiguation syntax. */
export function workspaceCompletions(tree: TreeNode[]): { docs: WikiDoc[]; tags: string[] } {
  const index = buildWikiIndex(tree);
  const docs: WikiDoc[] = [], tags = new Set<string>();
  const safeWikiName = (name: string) => !!name.trim() && !name.startsWith("^") && !/[\[\]#|\\\r\n]/.test(name) && name.trim() === name;
  const unique = (name: string, path: string) => index.get(name.toLowerCase())?.every((candidate) => candidate === path) === true;
  const walk = (nodes: TreeNode[], prefix: string) => {
    for (const node of nodes) {
      if (node.kind === "dir") {
        if (/^(?!\p{N})[\p{L}\p{N}_\-/]+$/u.test(node.name)) tags.add(node.name);
        walk(node.children ?? [], `${prefix}${node.name}/`);
      } else if (node.kind === "file") {
        const name = node.stem ?? node.name.replace(/\.(md|markdown)$/i, "");
        const canonical = `/${prefix}${node.name}`;
        const target = safeWikiName(name) && unique(name, node.path) ? name
          : safeWikiName(canonical) && unique(canonical, node.path) ? canonical : null;
        docs.push({ name, path: node.path, target });
      }
    }
  };
  walk(tree, "");
  return { docs, tags: [...tags].sort((a, b) => a.localeCompare(b)) };
}
