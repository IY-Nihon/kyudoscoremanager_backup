// scripts/backup-firestore.mjs
// Firestore・RTDB の全データと Auth の利用者の一覧を、毎日バックアップするスクリプト
// 保存期間: 90日（公開リポジトリの成果物の上限。.github/workflows/backup.yml の retention-days）。暗号化はワークフローがする

import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';
import { getDatabase } from 'firebase-admin/database';
import { createGzip } from 'zlib';
import { mkdirSync, writeFileSync } from 'fs';

// ─────────────────────────────────────────
// 環境変数チェック
// ─────────────────────────────────────────

const REQUIRED_ENV = ['FIREBASE_SERVICE_ACCOUNT_JSON'];
const missingEnv = REQUIRED_ENV.filter(k => !process.env[k]);
if (missingEnv.length > 0) {
  console.error(`❌ 以下の環境変数（GitHub Secrets）が未設定です:\n  ${missingEnv.join('\n  ')}`);
  process.exit(1);
}

// ─────────────────────────────────────────
// JSON.parse を try-catch で囲む
// ─────────────────────────────────────────

let firebaseServiceAccount;
try {
  firebaseServiceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
} catch {
  console.error('❌ FIREBASE_SERVICE_ACCOUNT_JSON が不正なJSONです。GitHub Secretsの登録内容を確認してください。');
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
  console.error('❌ Firebase初期化に失敗しました。FIREBASE_SERVICE_ACCOUNT_JSONが正しいFirebaseサービスアカウントのJSONか確認してください。');
  process.exit(1);
}

const OUTPUT_DIR = './backup-output';

// ファイル名に JST の日時を含める（同日複数実行でも区別できる）
const nowUtc = new Date();
const jstNow  = new Date(nowUtc.getTime() + 9 * 60 * 60 * 1000);
const jstISO  = jstNow.toISOString();
const jstDate = jstISO.slice(0, 10);
const jstTime = jstISO.slice(11, 19).replace(/:/g, '-');
const BACKUP_FILENAME = `backup-${jstDate}_${jstTime}.json.gz`;

// ─────────────────────────────────────────
// ヘルパー
// ─────────────────────────────────────────

function sanitize(value) {
  if (value === null || value === undefined) return value;
  if (typeof value?.toDate === 'function') return value.toDate().toISOString();
  if (Array.isArray(value)) return value.map(sanitize);
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, sanitize(v)]));
  }
  return value;
}

function gzipBuffer(jsonString) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const gz = createGzip();
    gz.on('data', chunk => chunks.push(chunk));
    gz.on('end', () => resolve(Buffer.concat(chunks)));
    gz.on('error', reject);
    gz.write(jsonString);
    gz.end();
  });
}

// ─────────────────────────────────────────
// 再帰的コレクション取得
// ─────────────────────────────────────────

async function backupDocument(docRef, depth = 0) {
  const snap = await docRef.get();
  const result = {
    _fields: snap.exists ? sanitize(snap.data()) : {},
    _collections: {},
  };

  const subcollections = await docRef.listCollections();
  await Promise.all(subcollections.map(async subColRef => {
    const docRefs = await subColRef.listDocuments();
    const subResults = await Promise.all(
      docRefs.map(async childDocRef => {
        const subData = await backupDocument(childDocRef, depth + 1);
        return { id: childDocRef.id, ...subData };
      })
    );
    result._collections[subColRef.id] = subResults;
    const indent = '  '.repeat(depth + 1);
    console.log(`${indent}📂 ${subColRef.id}: ${subResults.length}件`);
  }));

  return result;
}

async function backupCollection(colRef, depth = 0) {
  const docRefs = await colRef.listDocuments();
  const results = await Promise.all(
    docRefs.map(async docRef => {
      const data = await backupDocument(docRef, depth);
      return { id: docRef.id, ...data };
    })
  );
  return results;
}

// ─────────────────────────────────────────
// メイン処理
// ─────────────────────────────────────────

async function main() {
  console.log(`\n🔥 バックアップ開始: ${BACKUP_FILENAME}\n`);

  let backupData;
  try {
    backupData = {
      exportedAt: nowUtc.toISOString(),
      projectId: 'kyudoscoremanager',
      firestore: {},
      rtdb: null,
      auth: {},
    };

    console.log('📁 Firestore コレクションを検出中...');
    const topCollections = await db.listCollections();
    const topColIds = topCollections.map(c => c.id);
    console.log(`  検出: [${topColIds.join(', ')}]\n`);

    for (const colRef of topCollections) {
      const colId = colRef.id;
      console.log(`📁 ${colId} を取得中...`);
      const docs = await backupCollection(colRef);
      backupData.firestore[colId] = docs;
      console.log(`✅ ${colId}: ${docs.length}件\n`);
    }

    console.log('⚡ RTDB データを取得中...');
    const rtdbSnap = await rtdb.ref('/').once('value');
    const rtdbData = rtdbSnap.val() ?? {};

    const liveSessions = rtdbData.live_sessions ?? {};
    const liveGroupIds = Object.keys(liveSessions);
    if (liveGroupIds.length === 0) {
      console.log('✅ RTDB live_sessions: 空（未保存データなし）');
    } else {
      for (const gid of liveGroupIds) {
        const sessions = liveSessions[gid] ?? {};
        const sessionNames = Object.keys(sessions);
        const activeSessions = sessionNames.filter(
          name => sessions[name]?.state?.status === 'active'
        );
        console.log(`⚠️  RTDB グループ ${gid}: ${sessionNames.length}セッション（うちactive: ${activeSessions.length}件）`);
        if (activeSessions.length > 0) {
          console.log(`    未保存セッション: [${activeSessions.join(', ')}]`);
        }
      }
    }
    backupData.rtdb = rtdbData;
    console.log('');

    console.log('👤 Firebase Auth ユーザーを取得中...');
    const authUsers = [];
    let pageToken;
    do {
      const result = await auth.listUsers(1000, pageToken);
      authUsers.push(...result.users.map(u => ({
        uid: u.uid,
        email: u.email,
        createdAt: u.metadata.creationTime,
        lastSignedIn: u.metadata.lastSignInTime,
      })));
      pageToken = result.pageToken;
    } while (pageToken);
    backupData.auth.users = authUsers;
    console.log(`✅ Auth ユーザー: ${authUsers.length}件\n`);

  } catch (err) {
    console.error('❌ データ取得中にエラーが発生しました。保存をスキップします。');
    throw err;
  }

  const jsonString = JSON.stringify(backupData, null, 2);
  const sizeKB = Math.round(Buffer.byteLength(jsonString) / 1024);
  console.log(`📄 JSON サイズ: ${sizeKB} KB`);

  const compressed = await gzipBuffer(jsonString);
  const compressedKB = Math.round(compressed.length / 1024);
  console.log(`📦 圧縮後サイズ: ${compressedKB} KB`);

  mkdirSync(OUTPUT_DIR, { recursive: true });
  writeFileSync(`${OUTPUT_DIR}/${BACKUP_FILENAME}`, compressed);
  console.log(`✅ ファイル保存完了: ${OUTPUT_DIR}/${BACKUP_FILENAME}`);
  console.log('\n✅ バックアップ完了！\n');

  await app.delete();
}

main().catch(async err => {
  console.error('\n❌ バックアップ失敗:', err);
  await app.delete().catch(() => {});
  process.exit(1);
});
