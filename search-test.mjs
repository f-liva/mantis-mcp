import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { pipeline } from '@huggingface/transformers';

const db = new Database('/home/fede9/Progetti/mantis-mcp/mantis-mcp.db');
sqliteVec.load(db);

process.env.TRANSFORMERS_JS_LOG_LEVEL = 'error';
const extractor = await pipeline('feature-extraction', 'Xenova/paraphrase-multilingual-MiniLM-L12-v2', { dtype: 'fp32' });

const query = 'codici sconto B2B B2C aziende impostare configurare coupon promozione convenzione aziendale';
const output = await extractor(query, { pooling: 'mean', normalize: true });
const vec = output.data;
const buf = Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);

const sql = `
  SELECT c.issue_id, c.chunk_type, c.note_id, c.text, c.metadata_json, v.distance
  FROM vec_chunks v
  JOIN chunks c ON c.id = v.chunk_id
  WHERE v.embedding MATCH ? AND k = 200
  ORDER BY v.distance
`;

const results = db.prepare(sql).all(buf);

const filtered = results.filter(r => {
  const meta = JSON.parse(r.metadata_json || '{}');
  const proj = (meta.project || '').toLowerCase();
  return proj.includes('viaggi sicuri') || proj.includes('assivia');
});

console.log('=== Risultati filtrati per Viaggi Sicuri / Assivia ===');
console.log('Trovati: ' + filtered.length + ' risultati su ' + results.length + ' totali\n');

filtered.forEach((r, i) => {
  const meta = JSON.parse(r.metadata_json || '{}');
  const similarity = ((1 - r.distance / 2) * 100).toFixed(1);
  console.log('--- Risultato ' + (i + 1) + ' ---');
  console.log('Issue #' + r.issue_id + ' | Progetto: ' + meta.project + ' | Similarità: ' + similarity + '%');
  console.log('Tipo: ' + r.chunk_type + (r.chunk_type === 'note' ? ' (nota #' + r.note_id + ')' : ''));
  console.log(r.text.substring(0, 800));
  console.log('');
});

if (filtered.length === 0) {
  console.log('Nessun risultato per quei progetti. Top 5 generali:');
  results.slice(0, 5).forEach((r, i) => {
    const meta = JSON.parse(r.metadata_json || '{}');
    const similarity = ((1 - r.distance / 2) * 100).toFixed(1);
    console.log((i + 1) + '. Issue #' + r.issue_id + ' | ' + meta.project + ' | ' + similarity + '% | ' + r.text.substring(0, 250));
  });
}

db.close();
