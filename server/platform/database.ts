import { AsyncLocalStorage } from 'node:async_hooks';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres, { type Sql } from 'postgres';

export const requestDb = new AsyncLocalStorage<PostgresJsDatabase>();

export interface DatabaseHandle {
  raw: PostgresJsDatabase;
  db: PostgresJsDatabase;
  client: Sql;
}

export function openDatabase(connectionString: string): DatabaseHandle {
  const client = postgres(connectionString, { max: 20 });
  const raw = drizzle(client);
  const db = new Proxy(raw, {
    get(target, prop, receiver) {
      const current = requestDb.getStore() ?? target;
      const value = Reflect.get(current, prop, receiver);
      return typeof value === 'function' ? value.bind(current) : value;
    },
  }) as PostgresJsDatabase;
  return { raw, db, client };
}
