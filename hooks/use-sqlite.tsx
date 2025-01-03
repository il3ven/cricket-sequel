"use client";

import { useState, useEffect, useRef, createContext, useContext } from "react";
import sqlite3InitModule, { type Database, type SqlValue } from "@sqlite.org/sqlite-wasm";
import posthog from "posthog-js";

export interface TableMetadata {
  name: string;
  columns: string[];
}

const SQLiteContext = createContext<
  | {
      runQuery: (query: string) => Promise<SqlValue[][]>;
      loadingProgress: number;
      getTableMetadata: () => Promise<TableMetadata[]>;
    }
  | undefined
>(undefined);

async function downloadWithProgress(
  url: string,
  onProgress: (progress: number) => void
): Promise<Uint8Array> {
  const response = await fetch(url, {
    headers: {
      "Accept-Encoding": "br",
    },
  });
  const contentLength =
    Number(response.headers.get("x-file-size") ?? response.headers.get("Content-Length")) || 0;
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Failed to get response reader");

  const chunks: Uint8Array[] = [];
  let receivedLength = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    chunks.push(value);
    receivedLength += value.byteLength;
    // There is no way to determine actual file size. Hardcoding the file size to be 800mb.
    // As long as the received file is below this size. Everything should be fine.
    onProgress(Math.min((receivedLength / 800_000_000) * 100, 99));
  }

  // Concatenate chunks into a single ArrayBuffer
  const concatenated = new Uint8Array(receivedLength);
  let offset = 0;
  for (const chunk of chunks) {
    concatenated.set(chunk, offset);
    offset += chunk.length;
  }

  onProgress(100);
  return concatenated;
}

export function SQLiteProvider({ children, dbUrl }: { children: React.ReactNode; dbUrl: string }) {
  const [loadingProgress, setLoadingProgress] = useState(0);
  const dbRef = useRef<Database | null>(null);

  useEffect(() => {
    const initDb = async (dbUrl: string) => {
      let sqlite3 = await sqlite3InitModule();
      const buffer = await downloadWithProgress(dbUrl, setLoadingProgress);
      const p = sqlite3.wasm.allocFromTypedArray(buffer);
      const db = new sqlite3.oo1.DB("") as Database;
      const rc = sqlite3.capi.sqlite3_deserialize(
        db.pointer!,
        "main",
        p,
        buffer.byteLength,
        buffer.byteLength,
        sqlite3.capi.SQLITE_DESERIALIZE_FREEONCLOSE
        // Optionally:
        // | sqlite3.capi.SQLITE_DESERIALIZE_RESIZEABLE
      );
      db.checkRc(rc);
      db.exec({
        sql: "SELECT count(*) FROM matches",
        callback: (row) => {
          console.log(row);
        },
      });
      db.exec({
        sql: "PRAGMA shrink_memory",
      });
      return db;
    };

    const startTime = performance.now();

    initDb(dbUrl)
      .then((database) => {
        dbRef.current = database;
        const endTime = performance.now();
        posthog.capture("sqlite_db_loaded", {
          durationMs: endTime - startTime,
        });
      })
      .catch((error) => {
        const endTime = performance.now();
        posthog.capture("sqlite_db_load_failed", {
          durationMs: endTime - startTime,
          error: error.message ?? error.toString(),
        });
      });
  }, [dbUrl]);

  const runQuery = async (query: string) => {
    return new Promise<SqlValue[][]>(async (resolve, reject) => {
      const db = dbRef.current;
      if (!db) {
        reject("Database not ready");
        return;
      }
      const columnNames = [] as string[];
      const rows: SqlValue[] = [];
      try {
        // Add LIMIT to the query if it doesn't already have a LIMIT clause
        query = query.trim().endsWith(";") ? query.slice(0, -1) : query;
        const limitedQuery = query.toLowerCase().includes("limit") ? query : `${query} LIMIT 25;`;

        console.log("Running SQL", limitedQuery);

        db.exec({
          sql: limitedQuery,
          callback: (row) => {
            rows.push(...row);
          },
          columnNames,
          rowMode: "array", // ensures consistent row format
        });

        // Group rows into table
        const columnsCount = columnNames.length;
        const rowsCount = rows.length / columnsCount;
        const table = [columnNames] as SqlValue[][];
        for (let i = 0; i < rowsCount; i++) {
          const row = [] as SqlValue[];
          for (let j = 0; j < columnsCount; j++) {
            row.push(rows[i * columnsCount + j]);
          }
          table.push(row);
        }
        resolve(table);
      } catch (error) {
        reject(error);
      }
    });
  };

  // Function to get table metadata
  const getTableMetadata = async (): Promise<TableMetadata[]> => {
    const db = dbRef.current;
    if (!db) {
      throw "Database not ready";
    }
    const tables: TableMetadata[] = [];

    // Get all tables
    const tablesQuery = "SELECT name FROM sqlite_master WHERE type='table'";
    db.exec({
      sql: tablesQuery,
      callback: (row) => {
        const tableName = row[0] as string;

        // Get columns for each table
        db.exec({
          sql: `PRAGMA table_info(${tableName})`,
          callback: (columnRow) => {
            if (!tables.find((t) => t.name === tableName)) {
              tables.push({ name: tableName, columns: [] });
            }
            const table = tables.find((t) => t.name === tableName)!;
            table.columns.push(columnRow[1] as string);
          },
        });
      },
    });

    return tables;
  };

  return (
    <SQLiteContext.Provider value={{ runQuery, loadingProgress, getTableMetadata }}>
      {children}
    </SQLiteContext.Provider>
  );
}

export function useSQLite() {
  const context = useContext(SQLiteContext);
  if (!context) {
    throw new Error("useSQLite must be used within a SQLiteProvider");
  }
  return context;
}
