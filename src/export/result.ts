export type ExportResult =
  | { status: "saved"; path: string }
  | { status: "cancelled" }
  | { status: "failed"; message: string };
