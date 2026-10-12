import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@server/platform';
import type { SemanticBizType, SemanticSimilarItem } from '@shared/api.interface';

const SIMILARITY_MAX_DISTANCE = 0.4;
const TABLE_BY_TYPE: Record<SemanticBizType, string> = {
  contract: 'erp_contract',
  project: 'erp_project',
};

interface SimilarRawRow {
  id: string;
  code: string;
  name: string;
  similarity: string | number;
}

@Injectable()
export class SemanticService {
  private readonly logger = new Logger(SemanticService.name);

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase
  ) {}

  async findSimilar(
    type: SemanticBizType,
    id: string,
    limit: number
  ): Promise<SemanticSimilarItem[]> {
    const table: string = TABLE_BY_TYPE[type];

    const existsRows: unknown = await this.db.execute(
      sql`SELECT 1 AS ok FROM ${sql.raw(`"${table}"`)} WHERE id = ${id}`
    );
    const existsList = this.normalizeRows<{ ok: number }>(existsRows);
    if (existsList.length === 0) {
      throw new NotFoundException('记录不存在');
    }

    const rows: unknown = await this.db.execute(sql`
      WITH query_embedding AS MATERIALIZED (
        SELECT embedding FROM ${sql.raw(`"${table}"`)} WHERE id = ${id}
      )
      SELECT t.id AS id, t.code AS code, t.name AS name,
             1 - (t.embedding <=> q.embedding) AS similarity
      FROM ${sql.raw(`"${table}"`)} t, query_embedding q
      WHERE t.embedding IS NOT NULL
        AND t.id <> ${id}
        AND t.embedding <=> q.embedding < ${SIMILARITY_MAX_DISTANCE}
      ORDER BY t.embedding <=> q.embedding
      LIMIT ${limit}
    `);
    const list = this.normalizeRows<SimilarRawRow>(rows);
    return list.map((row: SimilarRawRow) => ({
      id: row.id,
      code: row.code,
      name: row.name,
      similarity: Math.round(Number(row.similarity) * 1000) / 1000,
    }));
  }

  private normalizeRows<T>(raw: unknown): T[] {
    if (Array.isArray(raw)) return raw as T[];
    const wrapped = raw as { rows?: T[] };
    return wrapped.rows ?? [];
  }
}
