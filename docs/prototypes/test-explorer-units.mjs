import { validateIdentifier, generateCreateTableSql } from '../../src/explorer.js';

console.log('Testing pure functions from src/explorer.js in Node...');

// Test 1: validateIdentifier
try {
  if (validateIdentifier('valid_table_1') !== 'valid_table_1') throw new Error('Valid identifier failed');
  if (validateIdentifier('_custom') !== '_custom') throw new Error('Leading underscore failed');
  
  let rejected = 0;
  try { validateIdentifier('123bad'); } catch { rejected++; }
  try { validateIdentifier('bad-name!'); } catch { rejected++; }
  try { validateIdentifier(''); } catch { rejected++; }
  try { validateIdentifier(' '); } catch { rejected++; }
  if (rejected !== 4) throw new Error(`Expected 4 rejections, got ${rejected}`);
  console.log('✓ validateIdentifier passed');
} catch (e) {
  console.error('✗ validateIdentifier failed:', e.message);
  process.exit(1);
}

// Test 2: generateCreateTableSql
try {
  const sql = generateCreateTableSql({
    tableName: 'inventory',
    columns: [
      { name: 'id', type: 'INTEGER', pk: true, notnull: true },
      { name: 'sku', type: 'TEXT', notnull: true },
      { name: 'price', type: 'REAL', defaultValue: '9.99' },
      { name: 'active', type: 'INTEGER', defaultValue: 1 },
      { name: 'created_at', type: 'TEXT', defaultValue: 'CURRENT_TIMESTAMP' },
    ]
  });

  if (!sql.includes('CREATE TABLE "inventory"')) throw new Error('Table name missing');
  if (!sql.includes('"id" INTEGER PRIMARY KEY NOT NULL')) throw new Error('id def missing');
  if (!sql.includes('"sku" TEXT NOT NULL')) throw new Error('sku def missing');
  if (!sql.includes('"price" REAL DEFAULT 9.99')) throw new Error('price def missing');
  if (!sql.includes('"active" INTEGER DEFAULT 1')) throw new Error('active def missing');
  if (!sql.includes('"created_at" TEXT DEFAULT CURRENT_TIMESTAMP')) throw new Error('created_at def missing');
  console.log('✓ generateCreateTableSql passed');
  console.log('Generated SQL:\n', sql);
} catch (e) {
  console.error('✗ generateCreateTableSql failed:', e.message);
  process.exit(1);
}

console.log('🎉 All Node unit tests passed!');
