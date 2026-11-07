// scripts/backup-firestore.mjs
// Firestore・RTDB の全データと Auth の利用者の一覧を、毎日バックアップするスクリプト
// 保存期間: 90日（workflow/backup.yml の retention-days）。暗号化はワークフローがする
// ログは Actions に残る（2026-11 から動かすのは非公開の倉庫だが、念のため）。団体ID・団体名・人の名前・文書の ID・
// ライブの枝（団体の合言葉）・ライブ名は出さず、集まりの道の型（groups/*/sessions）ごとの数だけを出す
//
// ■ 無料の枠（Firestore の読みは 1 日 5 万回。アプリ・照合と分け合う）
// 文書 1 件につき、一覧で 1 回・中身で 1 回・その下の集まりを聞くので 1 回、読みが数えられる（おおよそ 3 回）。
// 読んだ数をログの終わりに出す。
// disposable_domains（使い捨てメールのドメインの一覧。約 1 万件）は控えない。公開の一覧から入れ直せる
// （アプリの npm run ops:disposable:run）うえ、毎日読むと枠の半分ほどを使ってしまう。数だけ数えて残す
//
// ■ 一度に投げる数を絞る
// 前は全部の文書を一度に並べて取っていた（文書の数だけ同時に問い合わせる）。いまは中身を 100 件ずつまとめて読み、
// 同時に走らせる問い合わせを 8 本までにしている
//
// ■ 控えの形（format 2）
// firestore: { 集まり: [ { id, _fields, _collections: { 下の集まり: [...] } } ] }
//   ・日時（Timestamp）は ISO 8601 の字（ミリ秒まで）
//   ・参照は { _ref: 道 }・位置は { _geo: [緯度, 経度] }・バイト列は { _bytes: base64 }・ベクトルは { _vector: [...] }
//   ・中身が無く、下に集まりだけがある文書（Firestore の「missing」）は _exists: false
// skippedCollections: 控えなかった集まりと、その件数

import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore, Timestamp, DocumentReference, GeoPoint } from 'firebase-admin/firestore';
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
const 控えの形 = 2;

/** 控えない集まり（根の集まりの名前 → わけ） */
const 控えない集まり = new Map([
  ['disposable_domains', '使い捨てメールのドメインの一覧。公開の一覧から入れ直せる（アプリの npm run ops:disposable:run）'],
]);

const 一度に読む数 = 100; // getAll 1 回に渡す文書の数
const 同時の上限 = 8; // 同時に走らせる問い合わせの数
const 保存の日数 = 90; // workflow/backup.yml の retention-days と同じ

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

const 数 = {
  読み: 0, // Firestore の読み（おおよそ。一覧・中身・下の集まりの問い合わせ・数え上げ）
  型ごと: new Map(), // 集まりの道の型 → 文書の数
  中身の無い文書: 0,
  型の分からない値: 0,
};

// groups/abc/sessions → groups/*/sessions（文書の ID は出さない）
const 型の道 = (道) => 道.split('/').map((名, 番) => (番 % 2 ? '*' : 名)).join('/');

/** エラーの文から文書の道・RTDB の道（団体ID・ライブの枝が入る）を伏せる */
const 伏せる = (文) => String(文).replace(/documents\/[^\s'",)]+/g, 'documents/…').replace(/ at \/[^\s:'",)]+/g, ' at /…');

/** 同時に走らせる問い合わせの数を絞る。問い合わせ 1 本だけを包む（中で絞りを待つと詰まる） */
function 絞りを作る(上限) {
  let 走り = 0;
  const 列 = [];
  const 次へ = () => {
    while (走り < 上限 && 列.length) {
      const { 仕事, 済み, 失敗 } = 列.shift();
      走り++;
      Promise.resolve()
        .then(仕事)
        .then(済み, 失敗)
        .finally(() => {
          走り--;
          次へ();
        });
    }
  };
  return (仕事) => new Promise((済み, 失敗) => {
    列.push({ 仕事, 済み, 失敗 });
    次へ();
  });
}
const 絞って = 絞りを作る(同時の上限);

const ベクトルか = (値) => typeof 値?.toArray === 'function' && 値.constructor?.name === 'VectorValue';

/** Firestore の値を JSON にできる形へ（型は「控えの形」の決まりで残す） */
function sanitize(value) {
  if (value === null || value === undefined) return value;
  if (value instanceof Timestamp) return value.toDate().toISOString();
  if (value instanceof DocumentReference) return { _ref: value.path };
  if (value instanceof GeoPoint) return { _geo: [value.latitude, value.longitude] };
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return { _bytes: Buffer.from(value).toString('base64') };
  if (ベクトルか(value)) return { _vector: value.toArray() };
  if (Array.isArray(value)) return value.map(sanitize);
  if (typeof value === 'object') {
    const 原型 = Object.getPrototypeOf(value);
    if (原型 !== Object.prototype && 原型 !== null) {
      // 知らない型。中の作り（SDK の内部）までたどらない
      数.型の分からない値++;
      return { _unknown: String(value) };
    }
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

/** 1 つの集まりを、下の集まりまで控える */
async function backupCollection(colRef) {
  const docRefs = await 絞って(() => colRef.listDocuments());
  数.読み += Math.max(1, docRefs.length);
  const 型 = 型の道(colRef.path);
  数.型ごと.set(型, (数.型ごと.get(型) || 0) + docRefs.length);

  // 中身は 100 件ずつまとめて読む（順番は一覧のまま）
  const 束たち = [];
  for (let 番 = 0; 番 < docRefs.length; 番 += 一度に読む数) 束たち.push(docRefs.slice(番, 番 + 一度に読む数));
  const snaps = (await Promise.all(束たち.map(束 => 絞って(() => db.getAll(...束))))).flat();
  数.読み += docRefs.length;

  return Promise.all(snaps.map(async snap => {
    const subcollections = await 絞って(() => snap.ref.listCollections());
    数.読み += 1;
    const doc = { id: snap.id };
    if (!snap.exists) {
      doc._exists = false;
      数.中身の無い文書++;
    }
    doc._fields = snap.exists ? sanitize(snap.data()) : {};
    doc._collections = {};
    for (const subColRef of subcollections) {
      doc._collections[subColRef.id] = await backupCollection(subColRef);
    }
    return doc;
  }));
}

/** 数だけ数える（1,000 件で 1 回の読み） */
async function 数える(colRef) {
  const 件数 = (await 絞って(() => colRef.count().get())).data().count;
  数.読み += Math.max(1, Math.ceil(件数 / 1000));
  return 件数;
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
      format: 控えの形,
      firestore: {},
      skippedCollections: {},
      rtdb: null,
      auth: {},
    };

    console.log('📁 Firestore コレクションを検出中...');
    const topCollections = await db.listCollections();
    数.読み += 1;
    console.log(`  検出: [${topCollections.map(c => c.id).join(', ')}]\n`);

    for (const colRef of topCollections) {
      const colId = colRef.id;
      if (控えない集まり.has(colId)) {
        const 件数 = await 数える(colRef);
        backupData.skippedCollections[colId] = { count: 件数, reason: 控えない集まり.get(colId) };
        console.log(`⏭  ${colId}: 控えない（${件数}件。${控えない集まり.get(colId)}）\n`);
        continue;
      }
      console.log(`📁 ${colId} を取得中...`);
      const docs = await backupCollection(colRef);
      backupData.firestore[colId] = docs;
      console.log(`✅ ${colId}: ${docs.length}件\n`);
    }

    console.log('📊 Firestore の集まり（道の型ごとの文書の数）');
    for (const [型, 件数] of [...数.型ごと].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      console.log(`  ${型}: ${件数}件`);
    }
    if (数.中身の無い文書) console.log(`  （うち中身が無く、下に集まりだけがある文書: ${数.中身の無い文書}件）`);
    if (数.型の分からない値) console.log(`⚠️  知らない型の値: ${数.型の分からない値}か所（字にして控えた）`);
    console.log(`📖 Firestore の読み: おおよそ ${数.読み.toLocaleString('ja-JP')}回（無料の枠は 1 日 5 万回。アプリ・照合と分け合う）\n`);

    console.log('⚡ RTDB データを取得中...');
    const rtdbSnap = await rtdb.ref('/').once('value');
    const rtdbData = rtdbSnap.val() ?? {};

    // live_sessions/{枝}/{ライブ名}/state。枝は団体ごとの合言葉なので、名前は出さない
    const liveSessions = rtdbData.live_sessions ?? {};
    const 枝たち = Object.values(liveSessions);
    if (枝たち.length === 0) {
      console.log('✅ RTDB live_sessions: 空（未保存データなし）');
    } else {
      const ライブたち = 枝たち.flatMap(枝 => Object.values(枝 ?? {}));
      const 途中 = ライブたち.filter(ライブ => ライブ?.state?.status === 'active').length;
      // 保存して終わったライブは、団体の枝に「終わった」印だけが残る（盤面は無い）
      const 終わった = ライブたち.filter(ライブ => ライブ?.state?.status === 'finished').length;
      console.log(`${途中 ? '⚠️ ' : '✅'} RTDB live_sessions: ${枝たち.length} 団体・${ライブたち.length} ライブ（うち途中: ${途中}・終わった印: ${終わった}）`);
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
    // 8 = RESOURCE_EXHAUSTED。無料の枠を使い切ると、その日の読みは断られる（太平洋時間の 0 時に戻る）
    if (err?.code === 8) console.error('   Firestore の読みの枠を使い切った可能性があります（無料の枠は 1 日 5 万回）。');
    throw err;
  }

  const jsonString = JSON.stringify(backupData, null, 2);
  const sizeKB = Math.round(Buffer.byteLength(jsonString) / 1024);
  console.log(`📄 JSON サイズ: ${sizeKB} KB`);

  const compressed = await gzipBuffer(jsonString);
  const compressedKB = Math.round(compressed.length / 1024);
  // 非公開の倉庫の成果物は、持ち主の無料の置き場（GitHub Free は 500MB）を使う。越えると上げられなくなる
  const 保存の全部MB = Math.ceil((compressed.length * 保存の日数) / 1024 / 1024);
  console.log(`📦 圧縮後サイズ: ${compressedKB} KB（${保存の日数} 日分でおおよそ ${保存の全部MB} MB。GitHub Free の置き場は 500MB まで）`);

  mkdirSync(OUTPUT_DIR, { recursive: true });
  writeFileSync(`${OUTPUT_DIR}/${BACKUP_FILENAME}`, compressed);
  console.log(`✅ ファイル保存完了: ${OUTPUT_DIR}/${BACKUP_FILENAME}`);
  console.log('\n✅ バックアップ完了！\n');

  await app.delete();
}

main().catch(async err => {
  console.error('\n❌ バックアップ失敗:', err?.code ?? '', 伏せる(err?.stack || err));
  await app.delete().catch(() => {});
  process.exit(1);
});
