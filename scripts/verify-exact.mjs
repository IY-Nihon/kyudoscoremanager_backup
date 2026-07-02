// scripts/verify-exact.mjs
// バックアップ直後にFirestoreの実データと1文字単位で照合するスクリプト
// backup.yml の中でバックアップ実行直後に呼ばれる

import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';
import { getDatabase } from 'firebase-admin/database';
import { readFileSync, readdirSync } from 'fs';
import { gunzipSync } from 'zlib';
import { resolve } from 'path';

// ─────────────────────────────────────────
// 環境変数チェック・JSON.parse を try-catch で保護
// ─────────────────────────────────────────

if (!process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
  console.error('❌ FIREBASE_SERVICE_ACCOUNT_JSON が未設定です。');
  process.exit(1);
}

let firebaseServiceAccount;
try {
  firebaseServiceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
} catch {
  console.error('❌ FIREBASE_SERVICE_ACCOUNT_JSON が不正なJSONです。');
  process.exit(1);
}

// ─────────────────────────────────────────
// 初期化
// ─────────────────────────────────────────

let app, db, auth, rtdb;
try {
  app = initializeApp({
    credential: cert(firebaseServiceAccount),
    databaseURL: 'https://kyudoscoremanager-default-rtdb.firebaseio.com',
  });
  db = getFirestore();
  auth = getAuth();
  rtdb = getDatabase(app);
} catch {
  console.error('❌ Firebase初期化に失敗しました。FIREBASE_SERVICE_ACCOUNT_JSONを確認してください。');
  process.exit(1);
}

// ─────────────────────────────────────────
// バックアップ読み込み
// ─────────────────────────────────────────

function loadBackup() {
  const dir = './backup-output';
  const files = readdirSync(dir).filter(f => f.endsWith('.json.gz')).sort();
  if (files.length === 0) throw new Error('backup-output/ にファイルがありません');
  const latest = files.at(-1);
  console.log(`📂 照合対象: ${latest}`);
  return JSON.parse(gunzipSync(readFileSync(resolve(dir, latest))).toString('utf8'));
}

// ─────────────────────────────────────────
// 値の正規化（比較前に型を揃える）
// ─────────────────────────────────────────

function normalize(value) {
  if (value === null || value === undefined) return null;
  if (typeof value?.toDate === 'function') return value.toDate().getTime();
  if (Array.isArray(value)) return value.map(normalize);
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, normalize(v)])
    );
  }
  return value;
}

// バックアップ値の正規化（ISOString → ミリ秒数値）
function normalizeBk(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value)) {
    return new Date(value).getTime();
  }
  if (Array.isArray(value)) return value.map(normalizeBk);
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, normalizeBk(v)])
    );
  }
  return value;
}

// ─────────────────────────────────────────
// 差分検出
// ─────────────────────────────────────────

function diffObjects(fbData, bkData, prefix, diffs) {
  const allKeys = new Set([...Object.keys(fbData || {}), ...Object.keys(bkData || {})]);
  for (const key of allKeys) {
    const fb = JSON.stringify(normalize(fbData?.[key]));
    const bk = JSON.stringify(normalizeBk(bkData?.[key]));
    if (fb !== bk) {
      diffs.push({ path: `${prefix}.${key}`, fb: fb?.slice(0, 100), bk: bk?.slice(0, 100) });
    }
  }
}

// ─────────────────────────────────────────
// コレクション照合
// ─────────────────────────────────────────

async function verifyCollection(colRef, bkDocs, label) {
  const docRefs = await colRef.listDocuments();
  const bkMap = Object.fromEntries((bkDocs || []).map(d => [d.id, d._fields || {}]));
  const fbIds = docRefs.map(r => r.id);
  const fbIdSet = new Set(fbIds);
  const bkIdSet = new Set(Object.keys(bkMap));

  let errors = 0;

  const missingInBk = fbIds.filter(id => !bkIdSet.has(id));
  const extraInBk = [...bkIdSet].filter(id => !fbIdSet.has(id));
  if (missingInBk.length || extraInBk.length) {
    console.log(`  ❌ ${label}: 件数不一致 Firebase=${fbIds.length} BK=${Object.keys(bkMap).length}`);
    if (missingInBk.length) console.log(`     BK未収録ID: ${missingInBk.slice(0, 5).join(', ')}`);
    if (extraInBk.length) console.log(`     BK余分ID:   ${extraInBk.slice(0, 5).join(', ')}`);
    errors++;
  }

  let fieldDiffs = 0;
  for (const docRef of docRefs) {
    if (!bkIdSet.has(docRef.id)) continue;
    const snap = await docRef.get();
    const fbFields = snap.exists ? snap.data() : {};
    const bkFields = bkMap[docRef.id] || {};
    const diffs = [];
    diffObjects(fbFields, bkFields, docRef.id, diffs);
    if (diffs.length > 0) {
      fieldDiffs += diffs.length;
      for (const d of diffs.slice(0, 2)) {
        console.log(`     差分 ${d.path}`);
        console.log(`       Firebase:  ${d.fb}`);
        console.log(`       バックアップ: ${d.bk}`);
      }
      if (diffs.length > 2) console.log(`     ... 他 ${diffs.length - 2} 件`);
    }
  }

  if (fieldDiffs > 0) {
    console.log(`  ❌ ${label}: フィールド差分 ${fieldDiffs} 箇所`);
    errors++;
  } else if (!missingInBk.length && !extraInBk.length) {
    console.log(`  ✅ ${label}: ${fbIds.length}件 完全一致`);
  }

  return errors;
}

// ─────────────────────────────────────────
// メイン
// ─────────────────────────────────────────

async function main() {
  console.log('\n🔍 バックアップ完全照合を開始します\n');

  const backup = loadBackup();
  const bFirestore = backup.firestore || {};
  const bkGroups = bFirestore.groups || [];
  let totalErrors = 0;

  console.log('=== group_accounts ===');
  const gaColRef = db.collection('group_accounts');
  totalErrors += await verifyCollection(gaColRef, bFirestore.group_accounts, 'group_accounts');

  const gaDocs = await gaColRef.listDocuments();
  for (const gaDocRef of gaDocs) {
    const gid = gaDocRef.id;
    const gaSnap = await gaDocRef.get();
    const name = gaSnap.exists ? (gaSnap.data().name || '不明') : '不明';
    console.log(`\n=== グループ ${gid} (${name}) ===`);

    const bkGroup = bkGroups.find(g => g.id === gid);
    if (!bkGroup) {
      console.log(`  ⚠️ groups にデータなし（新規グループの可能性）: ${gid}`);
      continue;
    }

    const bkCols = bkGroup._collections || {};

    const groupDocRef = db.collection('groups').doc(gid);
    const actualSubcols = await groupDocRef.listCollections();
    const actualSubcolIds = actualSubcols.map(c => c.id);

    const bkOnlyCols = Object.keys(bkCols).filter(id => !actualSubcolIds.includes(id));
    if (bkOnlyCols.length) {
      console.log(`  ⚠️ BKのみに存在するサブコレクション（バックアップ後に削除された可能性）: ${bkOnlyCols.join(', ')}`);
    }

    for (const subColRef of actualSubcols) {
      const colRef = groupDocRef.collection(subColRef.id);
      totalErrors += await verifyCollection(colRef, bkCols[subColRef.id], subColRef.id);
    }
  }

  console.log('\n=== RTDB（全パス）===');
  const rtdbSnap = await rtdb.ref('/').once('value');
  const fbRtdb = rtdbSnap.val() || {};
  const bkRtdb = backup.rtdb || {};
  const fbRtdbJson = JSON.stringify(normalize(fbRtdb));
  const bkRtdbJson = JSON.stringify(normalizeBk(bkRtdb));
  if (fbRtdbJson === bkRtdbJson) {
    console.log(`  ✅ RTDB 全データ: 完全一致`);
  } else {
    console.log(`  ❌ RTDB: 差分あり`);
    for (const key of new Set([...Object.keys(fbRtdb), ...Object.keys(bkRtdb)])) {
      const fb = JSON.stringify(normalize(fbRtdb[key]));
      const bk = JSON.stringify(normalizeBk(bkRtdb[key]));
      if (fb !== bk) console.log(`     差分パス: /${key}`);
    }
    totalErrors++;
  }

  console.log('\n=== Firebase Auth ===');
  const authUsers = [];
  let pageToken;
  do {
    const result = await auth.listUsers(1000, pageToken);
    authUsers.push(...result.users);
    pageToken = result.pageToken;
  } while (pageToken);

  const bkUsers = backup.auth?.users || [];
  const fbUidMap = Object.fromEntries(authUsers.map(u => [u.uid, u]));
  const bkUidMap = Object.fromEntries(bkUsers.map(u => [u.uid, u]));

  const missingUids = authUsers.map(u => u.uid).filter(uid => !bkUidMap[uid]);
  const extraUids = bkUsers.map(u => u.uid).filter(uid => !fbUidMap[uid]);
  let authDiffs = 0;

  if (missingUids.length || extraUids.length) {
    console.log(`  ❌ Auth: 件数不一致 Firebase=${authUsers.length} BK=${bkUsers.length}`);
    if (missingUids.length) console.log(`     BK未収録UID: ${missingUids.slice(0, 3).join(', ')}`);
    if (extraUids.length) console.log(`     BK余分UID:   ${extraUids.slice(0, 3).join(', ')}`);
    totalErrors++;
  } else {
    for (const fbUser of authUsers) {
      const bkUser = bkUidMap[fbUser.uid];
      if (!bkUser) continue;
      if (fbUser.email !== bkUser.email) {
        console.log(`     差分 uid=${fbUser.uid} email: FB=${fbUser.email} BK=${bkUser.email}`);
        authDiffs++;
      }
      if (fbUser.metadata?.creationTime !== bkUser.createdAt) {
        console.log(`     差分 uid=${fbUser.uid} createdAt: FB=${fbUser.metadata?.creationTime} BK=${bkUser.createdAt}`);
        authDiffs++;
      }
    }
    if (authDiffs > 0) {
      console.log(`  ❌ Auth: フィールド差分 ${authDiffs} 箇所`);
      totalErrors++;
    } else {
      console.log(`  ✅ Auth: ${authUsers.length}件 完全一致（uid・email・createdAt）`);
    }
  }

  console.log('\n' + '='.repeat(50));
  if (totalErrors === 0) {
    console.log('✅ 全データが完全に一致しています（1文字の差異もなし）');
  } else {
    console.log(`❌ ${totalErrors} 件の問題が検出されました`);
    process.exitCode = 1;
  }

  await app.delete();
}

main().catch(async err => {
  console.error('\n❌ 照合スクリプトエラー:', err.message);
  await app.delete().catch(() => {});
  process.exit(1);
});
