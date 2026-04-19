import BetterSqlite3 from "better-sqlite3";

export type SQLInputValue = string | number | bigint | Buffer | Uint8Array | null;

export type StatementResult = {
  changes: number | bigint;
  lastInsertRowid: number | bigint;
};

export interface StatementSync {
  run(...params: SQLInputValue[]): StatementResult;
  get<T = unknown>(...params: SQLInputValue[]): T;
  all<T = unknown>(...params: SQLInputValue[]): T[];
  iterate<T = unknown>(...params: SQLInputValue[]): IterableIterator<T>;
}

export type DatabaseSyncOptions = {
  open?: boolean;
  readOnly?: boolean;
  fileMustExist?: boolean;
  timeout?: number;
  verbose?: (message?: unknown, ...additionalArgs: unknown[]) => void;
};

export type DriverCompatibilityProbe =
  | { ok: true }
  | {
      ok: false;
      code: "node_abi_mismatch" | "driver_load_failed";
      message: string;
      guidance: string;
    };

function formatDriverCompatibilityProbe(error: unknown): DriverCompatibilityProbe {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("compiled against a different Node.js version using")) {
    return {
      ok: false,
      code: "node_abi_mismatch",
      message,
      guidance:
        `ClawForce's SQLite driver was built for a different Node runtime than the current process (${process.version}). ` +
        "Reinstall or rebuild ClawForce dependencies using the same Node version as the active host process.",
    };
  }
  return {
    ok: false,
    code: "driver_load_failed",
    message,
    guidance:
      "ClawForce could not initialize its SQLite driver in the current runtime. " +
      "Verify the native dependency is installed and compatible with the active Node process.",
  };
}

export function probeDatabaseDriverCompatibility(): DriverCompatibilityProbe {
  try {
    const db = new BetterSqlite3(":memory:");
    db.close();
    return { ok: true };
  } catch (error) {
    return formatDriverCompatibilityProbe(error);
  }
}

export class DatabaseSync {
  readonly #db: BetterSqlite3.Database;

  constructor(path: string, options: DatabaseSyncOptions = {}) {
    if (options.open === false) {
      throw new Error("DatabaseSync with open: false is not supported by the better-sqlite3 driver.");
    }

    const dbOptions: {
      readonly?: boolean;
      fileMustExist?: boolean;
      timeout?: number;
      verbose?: (message?: unknown, ...additionalArgs: unknown[]) => void;
    } = {};

    if (options.readOnly !== undefined) dbOptions.readonly = options.readOnly;
    if (options.fileMustExist !== undefined) dbOptions.fileMustExist = options.fileMustExist;
    if (options.timeout !== undefined) dbOptions.timeout = options.timeout;
    if (options.verbose !== undefined) dbOptions.verbose = options.verbose;

    this.#db = new BetterSqlite3(path, dbOptions);
  }

  exec(sql: string): this {
    this.#db.exec(sql);
    return this;
  }

  prepare(sql: string): StatementSync {
    return this.#db.prepare(sql) as unknown as StatementSync;
  }

  close(): void {
    this.#db.close();
  }
}
