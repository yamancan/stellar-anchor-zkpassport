import { initializeDb, type DB, type DBStatement } from "./db.js";

interface SqlCursor {
  rowsWritten: number;
  next(): IteratorResult<Record<string, unknown>>;
  toArray(): Record<string, unknown>[];
}

export interface DurableSqlStorage {
  exec(query: string, ...bindings: unknown[]): SqlCursor;
}

export interface DurableStorage {
  sql: DurableSqlStorage;
  transactionSync<T>(fn: () => T): T;
  getAlarm(): Promise<number | null>;
  setAlarm(timestamp: number): Promise<void>;
}

class DurableStatement implements DBStatement {
  constructor(
    private readonly sql: DurableSqlStorage,
    private readonly query: string
  ) {}

  all(...values: unknown[]): Record<string, any>[] {
    return this.sql.exec(this.query, ...values).toArray();
  }

  get(...values: unknown[]): Record<string, any> | undefined {
    const row = this.sql.exec(this.query, ...values).next();
    return row.done ? undefined : row.value;
  }

  run(...values: unknown[]) {
    const cursor = this.sql.exec(this.query, ...values);
    return { changes: cursor.rowsWritten, lastInsertRowid: 0 };
  }
}

export function openDurableDb(storage: DurableStorage): DB {
  const db: DB = {
    exec: (query) => storage.sql.exec(query),
    prepare: (query) => new DurableStatement(storage.sql, query),
    close: () => {},
    transactionSync: (fn) => storage.transactionSync(fn),
  };
  initializeDb(db);
  return db;
}
