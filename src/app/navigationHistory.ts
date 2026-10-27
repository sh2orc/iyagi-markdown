import { EditorSelection, type ChangeDesc } from "@codemirror/state";

export interface NavigationPoint {
  tabId: string;
  selection: EditorSelection;
  /** Pixel offsets are reusable only while the document is unchanged. */
  scroll: number | null;
  outerScroll: number | null;
}

/** Window-local navigation through open documents; never stores document copies. */
export class NavigationHistory {
  private back: NavigationPoint[] = [];
  private forward: NavigationPoint[] = [];
  get canBack() { return this.back.length > 0; }
  get canForward() { return this.forward.length > 0; }

  private same(a: NavigationPoint | undefined, b: NavigationPoint): boolean {
    return a?.tabId === b.tabId && a.selection.eq(b.selection) &&
      a.scroll === b.scroll && a.outerScroll === b.outerScroll;
  }

  private push(stack: NavigationPoint[], point: NavigationPoint): void {
    const last = stack.at(-1);
    if (this.same(last, point)) return;
    stack.push(point);
    if (stack.length > 100) stack.shift();
  }
  visit(current: NavigationPoint | null): void {
    if (current) this.push(this.back, current);
    this.forward = [];
  }
  travel(forward: boolean, current: NavigationPoint | null): NavigationPoint | null {
    const source = forward ? this.forward : this.back;
    const target = source.pop();
    if (!target) return null;
    if (current) this.push(forward ? this.back : this.forward, current);
    return target;
  }
  remove(tabId: string): void {
    this.back = this.back.filter((point) => point.tabId !== tabId);
    this.forward = this.forward.filter((point) => point.tabId !== tabId);
  }
  discardCurrent(current: NavigationPoint | null): void {
    if (!current) return;
    for (const stack of [this.back, this.forward]) while (this.same(stack.at(-1), current)) stack.pop();
  }
  map(tabId: string, changes: ChangeDesc): void {
    if (changes.empty) return;
    for (const stack of [this.back, this.forward]) for (const point of stack) if (point.tabId === tabId) {
      point.selection = clampSelection(point.selection, changes.length).map(changes);
      point.scroll = point.outerScroll = null;
    }
  }
  /** Reloads/setState have no trustworthy incremental position mapping. */
  invalidate(tabId: string, length: number): void {
    for (const stack of [this.back, this.forward]) for (const point of stack) if (point.tabId === tabId) {
      point.selection = clampSelection(point.selection, length);
      point.scroll = point.outerScroll = null;
    }
  }
}

export function clampSelection(selection: EditorSelection, length: number): EditorSelection {
  return EditorSelection.create(selection.ranges.map((range) => EditorSelection.range(
    Math.min(range.anchor, length), Math.min(range.head, length),
  )), selection.mainIndex);
}
