// markdown-it-footnote에 공식 타입 선언이 없다 — 플러그인 형태만 선언한다.
declare module "markdown-it-footnote" {
  import type { PluginWithOptions } from "markdown-it";
  const plugin: PluginWithOptions;
  export default plugin;
}
