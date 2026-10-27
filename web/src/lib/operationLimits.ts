export const SPREADSHEET_IMPORT_ENTRY_CHUNK_SIZE = 1_000;
/**
 * Internal request size for UI bulk actions. Users can select any amount;
 * Two spare SQL-variable slots keep queue updates and a new-category insert
 * within D1's per-statement limit.
 */
export const BULK_OPERATION_CHUNK_SIZE = 98;
