import type { RecentSnapshot, WorkspaceHistoryAction } from "../api";

interface HistoryIO {
  getWorkspaceHistory?(): Promise<RecentSnapshot>;
  updateWorkspaceHistory?(action: WorkspaceHistoryAction): Promise<RecentSnapshot>;
}
interface HistoryState {
  entries: RecentSnapshot["entries"];
  loading: boolean;
  busy: boolean;
  loaded: boolean;
  error: string | null;
}

/** Small independent subscription: history responses do not rerender editor state. */
export class WorkspaceHistory {
  private state: HistoryState = { entries: [], loading: false, busy: false, loaded: false, error: null };
  private listeners = new Set<() => void>();
  private revision = -1;
  private generation = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private actions = 0;
  constructor(private io: HistoryIO) {}
  getSnapshot = (): HistoryState => this.state;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private emit(patch: Partial<HistoryState>) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
  accept(snapshot: RecentSnapshot): void {
    if (snapshot.revision < this.revision) return;
    this.revision = snapshot.revision; this.generation++;
    this.emit({ entries: snapshot.entries, loading: false, loaded: true });
  }
  async load(): Promise<void> {
    if (!this.io.getWorkspaceHistory) return;
    const generation = ++this.generation; this.emit({ loading: true });
    try {
      const snapshot = await this.io.getWorkspaceHistory();
      if (generation === this.generation) this.emit({ error: null });
      this.accept(snapshot);
    } catch (error) {
      if (generation === this.generation) this.emit({ error: String(error) });
    } finally {
      if (generation === this.generation) this.emit({ loading: false });
    }
  }
  record(path: string, current: () => boolean): Promise<boolean> { return this.change({ kind: "record", path }, current); }
  remove(path: string): Promise<boolean> { return this.change({ kind: "remove", path }); }
  clear(): Promise<boolean> { return this.change({ kind: "clear" }); }
  private change(action: WorkspaceHistoryAction, current: () => boolean = () => true): Promise<boolean> {
    if (!this.io.updateWorkspaceHistory) return Promise.resolve(false);
    this.actions++; this.emit({ busy: true });
    const operation = this.queue.then(async () => {
      try {
        if (!current()) return false;
        this.accept(await this.io.updateWorkspaceHistory!(action));
        this.emit({ error: null }); return true;
      } catch (error) { this.emit({ error: String(error) }); return false; }
      finally { this.actions--; this.emit({ busy: this.actions > 0 }); }
    });
    this.queue = operation; return operation;
  }
}
