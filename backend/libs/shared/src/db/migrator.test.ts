import { describe, expect, it } from 'vitest';
import { listMigrations as listMigrationsForTest } from './migrator.js';

describe('migrator file listing', () => {
  it('keeps only NNNN_name.sql files in order', () => {
    expect(listMigrationsForTest(['0002_b.sql', 'README.md', '0001_a.sql', 'x.sql'])).toEqual([
      '0001_a.sql',
      '0002_b.sql',
    ]);
  });

  it('rejects duplicate migration numbers', () => {
    expect(() => listMigrationsForTest(['0001_a.sql', '0001_b.sql'])).toThrow(
      /Duplicate migration number 0001/,
    );
  });
});
