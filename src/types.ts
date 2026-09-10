/** A file owned by the extension, to be cleaned up after use. */
export interface SpFile {
  path: string;
  /** true = this extension created the file and should delete it after. */
  owned: boolean;
}
