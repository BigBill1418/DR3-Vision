// ADR-0049 D2/D4 — normalized OneDrive/SharePoint Files transport types.
//
// A GENERIC read-only Graph Files capability (client-credentials + `Files.Read.All`).
// The normalized shapes below are what the sync engine sees regardless of whether
// the bytes came from the real Graph API (`graphFilesTransport`) or fixtures
// (`mockFilesTransport`). Raw Graph JSON is confined to `graph-transport.ts`.

/** Which implementation produced a result — self-reported at startup + per run. */
export type FilesTransportMode = 'mock' | 'graph';

/**
 * A normalized OneDrive/SharePoint driveItem (file). `ctag` is the CHANGE guard
 * (D2): an unchanged `ctag` between polls means the file content is unchanged, so
 * the engine skips the re-download / re-parse. `id` is the stable Graph item id.
 */
export interface DriveFile {
  id: string;
  name: string;
  /** Graph cTag — changes on any content OR metadata edit; the delta guard (D2). */
  ctag: string;
  /** ISO-8601 last-modified — informational (the ctag is the authoritative guard). */
  lastModified: string;
  size: number;
}
